// Owns an ephemeral localhost server, isolated Chrome contexts and synthetic files.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDeck, validateDeck, serializeDeck } from '../deck.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = await mkdtemp(join(tmpdir(), 'figure-mcp-test-'));
const python = process.env.PYTHON || 'python3';
const server = spawn(python, ['-u', '-c', 'import server; from pathlib import Path; server.start_clipboard_helper=lambda:None; s=server.create_server(Path.cwd(),0); print(s.server_port,flush=True); s.serve_forever()'], { cwd: resolve('.') });
let serverErrors = ''; server.stderr.on('data', chunk => { serverErrors = (serverErrors + chunk).slice(-10000); });
const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Test server did not start: ' + serverErrors)), 10000);
  createInterface({ input: server.stdout }).once('line', line => { clearTimeout(timer); resolve(Number(line)); });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Test server exited ${code}: ${serverErrors}`)); });
});
const mcp = spawn(python, ['figure_mcp.py', '--port', String(port), '--output-dir', output]);
const pending = new Map(); let sequence = 0, stderr = '';
mcp.stderr.on('data', chunk => { stderr += chunk; });
createInterface({ input: mcp.stdout }).on('line', line => {
  const response = JSON.parse(line), slot = pending.get(response.id);
  if (slot) { clearTimeout(slot.timer); pending.delete(response.id); slot.resolve(response); }
});
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, timer: setTimeout(() => { pending.delete(id); reject(new Error('MCP request timed out: ' + method)); }, 60000) });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function call(name, args = {}, errorPattern) {
  const reply = await rpc('tools/call', { name: 'figure_' + name, arguments: args });
  assert.ok(!reply.error, JSON.stringify(reply));
  if (errorPattern) { assert.equal(reply.result.isError, true); assert.match(reply.result.content[0].text, errorPattern); return reply.result; }
  assert.equal(reply.result.isError, false, JSON.stringify(reply.result));
  return reply.result;
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function sessions(count) {
  for (let n = 0; n < 100; n++) {
    const result = (await call('sessions')).structuredContent.sessions;
    if (result.length === count) return result;
    await pause(100);
  }
  throw new Error('Expected ' + count + ' connected sessions.');
}
function fixture(name = 'MCP synthetic') {
  const deck = createDeck(); deck.name = name;
  deck.slides[0].items = ['a', 'b', 'c'].map((id, index) => ({ id, type: 'text', name: 'Panel ' + id, text: '(' + id + ') Synthetic data', x: 40 + index * 230, y: 30 + index * 50, width: 180, height: 55, fontSize: 20 }));
  return validateDeck(deck);
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [], checks = [];
const pass = name => { checks.push(name); console.log('PASS', name); };
async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1550, height: 1050 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => {
    localStorage.setItem('figure-editor-autosave', 'off');
    window.showOpenFilePicker = async () => [await (await navigator.storage.getDirectory()).getFileHandle('original.figure.json')];
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => !document.querySelector('#open-project').disabled);
  return { page, context };
}
try {
  assert.equal((await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'integration-test', version: '1' } })).result.serverInfo.name, 'figure-editor');
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  assert.equal((await rpc('tools/list')).result.tools.length, 7);
  const { page } = await newPage();
  const sessionId = (await sessions(1))[0].sessionId;
  const deck = fixture();
  await page.locator('#project-input').setInputFiles({ name: 'synthetic.figure.json', mimeType: 'application/json', buffer: Buffer.from(serializeDeck(deck)) });
  await page.waitForFunction(() => !document.querySelector('#open-project').disabled);
  const state = async () => (await call('get_state', { sessionId })).structuredContent;
  const initial = await state(), slideId = initial.activeSlideId;
  assert.equal(initial.project.name, deck.name); assert.equal(initial.slide.items.length, 3);
  pass('stdio MCP reads the live page and object IDs');
  const operations = [{ op: 'set', slideId, itemIds: ['a', 'b', 'c'], properties: { width: 200, fontSize: 18 } },
    { op: 'align', slideId, itemIds: ['a', 'b', 'c'], alignment: 'top' },
    { op: 'distribute', slideId, itemIds: ['a', 'b', 'c'], axis: 'x', gap: 16 }];
  const edited = (await call('batch_edit', { sessionId, expectedRevision: initial.revision, operations })).structuredContent;
  assert.deepEqual(edited.slide.items.map(i => [i.x, i.y, i.width]), [[40, 30, 200], [256, 30, 200], [472, 30, 200]]);
  assert.equal(edited.history.undo, 1);
  assert.equal(await page.locator('#stage [data-item="b"]').getAttribute('transform'), 'translate(256 30) rotate(0 100 27.5)');
  await call('batch_edit', { sessionId, expectedRevision: initial.revision, operations }, /revision changed/);
  const invalid = [...operations, { op: 'set', slideId, itemIds: ['missing'], properties: { x: 5 } }];
  await call('batch_edit', { sessionId, expectedRevision: edited.revision, operations: invalid }, /does not exist/);
  assert.deepEqual((await state()).slide.items, edited.slide.items);
  pass('batch applies exact geometry; stale and invalid batches leave state intact');
  const undone = (await call('history', { sessionId, expectedRevision: edited.revision, action: 'undo' })).structuredContent;
  assert.deepEqual(undone.slide.items, initial.slide.items);
  const redone = (await call('history', { sessionId, expectedRevision: undone.revision, action: 'redo' })).structuredContent;
  assert.deepEqual(redone.slide.items, edited.slide.items);
  pass('one Undo/Redo restores the entire batch');
  await page.locator('#export-open').click();
  await call('batch_edit', { sessionId, expectedRevision: redone.revision, operations }, /Close the open dialog/);
  await page.locator('#export-cancel').click();
  pass('an open modal prevents conflicting edits');
  const preview = await call('preview', { sessionId, maxSize: 800 });
  const png = Buffer.from(preview.content.find(block => block.type === 'image').data, 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.ok(preview.structuredContent.width <= 800);
  await writeFile(join(output, 'preview.png'), png);
  await page.screenshot({ path: join(output, 'editor.png') });
  for (const format of ['png', 'svg', 'pdf', 'pptx', 'html']) {
    const exported = (await call('export', { sessionId, format, dpi: 150 })).structuredContent;
    assert.equal((await readFile(exported.path)).length, exported.bytes);
    assert.equal(exported.renderedRevision, redone.revision);
  }
  pass('preview and all five existing export formats produce actual files');
  await call('save', { sessionId, expectedRevision: redone.revision, destination: 'file' }, /No project file is authorized/);
  const savedDraft = (await call('save', { sessionId, expectedRevision: redone.revision, destination: 'draft' })).structuredContent;
  assert.equal(savedDraft.destination, 'draft'); assert.equal(savedDraft.state.save.draftCurrent, true); assert.equal(savedDraft.state.save.savedToFile, false);
  pass('draft save is explicit; unauthorized file save does not open a picker');
  await page.evaluate(async contents => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('original.figure.json', { create: true });
    const writer = await handle.createWritable(); await writer.write(contents); await writer.close();
  }, serializeDeck(fixture('Authorized file')));
  await page.locator('#open-project').click(); await page.waitForFunction(() => !document.querySelector('#open-project').disabled);
  let current = await state();
  await call('batch_edit', { sessionId, expectedRevision: redone.revision, operations }, /revision changed/);
  const setX = (s, x) => ({ sessionId, expectedRevision: s.revision, operations: [{ op: 'set', slideId: s.activeSlideId, itemIds: ['a'], properties: { x } }] });
  current = (await call('batch_edit', setX(current, 123))).structuredContent;
  const savedFile = (await call('save', { sessionId, expectedRevision: current.revision, destination: 'file' })).structuredContent;
  assert.equal(savedFile.saved, true); assert.equal(savedFile.state.save.savedToFile, true); assert.equal(savedFile.state.save.autoSave, false);
  assert.equal(await page.evaluate(async () => JSON.parse(await (await (await (await navigator.storage.getDirectory()).getFileHandle('original.figure.json')).getFile()).text()).slides[0].items[0].x), 123);
  await page.locator('#autosave-toggle').check();
  current = (await call('batch_edit', setX(await state(), 234))).structuredContent;
  await page.waitForFunction(async () => JSON.parse(await (await (await (await navigator.storage.getDirectory()).getFileHandle('original.figure.json')).getFile()).text()).slides[0].items[0].x === 234);
  await page.waitForFunction(() => !document.querySelector('#open-project').disabled);
  pass('project epochs prevent stale edits; explicit save and AutoSave persist MCP edits');
  await page.locator('#autosave-toggle').uncheck();
  await page.evaluate(async () => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('original.figure.json');
    const document = JSON.parse(await (await handle.getFile()).text()); document.name = 'External update';
    const writer = await handle.createWritable(); await writer.write(JSON.stringify(document)); await writer.close();
  });
  current = (await call('batch_edit', setX(await state(), 345))).structuredContent;
  await call('save', { sessionId, expectedRevision: current.revision, destination: 'file' }, /changed outside/);
  assert.equal((await state()).slide.items[0].x, 345);
  assert.equal(await page.evaluate(async () => JSON.parse(await (await (await (await navigator.storage.getDirectory()).getFileHandle('original.figure.json')).getFile()).text()).name), 'External update');
  pass('external file conflicts preserve both external bytes and live edits');
  const second = await newPage();
  const secondId = (await sessions(2)).find(s => s.sessionId !== sessionId).sessionId;
  assert.equal((await call('get_state', { sessionId: secondId })).structuredContent.slide.items.length, 0);
  await call('batch_edit', setX(await state(), 456));
  assert.equal((await call('get_state', { sessionId: secondId })).structuredContent.slide.items.length, 0);
  await second.page.locator('#ai-control-toggle').click();
  await sessions(1);
  await call('get_state', { sessionId: secondId }, /disconnected|expired/);
  await second.page.locator('#ai-control-toggle').click();
  assert.notEqual((await sessions(2)).find(s => s.sessionId !== sessionId).sessionId, secondId);
  pass('multiple pages are isolated; pause/reconnect invalidates old sessions');
  assert.deepEqual(errors, []); assert.equal(stderr, '');
  console.log(JSON.stringify({ passed: checks.length, output }));
} catch (error) {
  console.error('Server diagnostics:', serverErrors); throw error;
} finally {
  await browser.close(); mcp.stdin.end(); mcp.kill(); server.kill();
  for (const slot of pending.values()) clearTimeout(slot.timer);
}
