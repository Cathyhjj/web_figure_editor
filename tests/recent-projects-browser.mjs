// Start a dedicated server on 127.0.0.1:18766. Never use the normal editing origin.
// PLAYWRIGHT_MODULE can point to an installed Playwright module when it is not local.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDeck, serializeDeck } from '../deck.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'figure-recent-checks-'));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1550, height: 1050 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
let acceptConfirm = true;
page.on('dialog', dialog => dialog.type() === 'confirm' && !acceptConfirm ? dialog.dismiss() : dialog.accept());
await page.addInitScript(() => {
  // Keep dirty-state tests deterministic; all file writes in this suite are explicit.
  localStorage.setItem('figure-editor-autosave', 'off');
  window.recentCheckPickers = { open: [], save: [], calls: [] };
  window.showOpenFilePicker = async () => {
    const name = window.recentCheckPickers.open.shift();
    window.recentCheckPickers.calls.push({ type: 'open', name });
    if (!name) throw new Error('Unexpected Open picker.');
    return [await (await navigator.storage.getDirectory()).getFileHandle(name)];
  };
  window.showSaveFilePicker = async () => {
    const name = window.recentCheckPickers.save.shift();
    window.recentCheckPickers.calls.push({ type: 'save', name });
    if (!name) throw new Error('Unexpected Save picker.');
    return (await navigator.storage.getDirectory()).getFileHandle(name, { create: true });
  };
});

function check(name, pass) {
  checks.push({ name, pass: !!pass });
  assert.ok(pass, name);
  console.log('PASS', name);
}
const fixture = name => ({ ...createDeck(), name });
const idle = () => page.waitForFunction(() => !document.getElementById('open-project').disabled);
const projectName = () => page.locator('#project-name').inputValue();
const rows = () => page.locator('#recent-projects-list .recent-project-open');
const row = name => rows().filter({ has: page.locator('span', { hasText: name }) });
const fileNames = () => rows().locator('span').allTextContents();
const showRecent = () => page.locator('#open-recent-project').click();
const closeRecent = () => page.locator('#recent-projects-close').click();
async function writeFile(name, project) {
  await page.evaluate(async ({ name, contents }) => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle(name, { create: true });
    const writer = await handle.createWritable();
    await writer.write(contents); await writer.close();
  }, { name, contents: serializeDeck(project) });
}
async function readFile(name) {
  return page.evaluate(async name => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle(name);
    return JSON.parse(await (await handle.getFile()).text());
  }, name);
}
async function pickOpen(name) {
  await page.evaluate(name => window.recentCheckPickers.open.push(name), name);
  await page.locator('#open-project').click(); await idle();
}
async function saveAs(name) {
  await page.evaluate(name => window.recentCheckPickers.save.push(name), name);
  await page.locator('#save-project-as').click(); await idle();
}
async function draft() {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('figure-editor-drafts', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const store = db.transaction('drafts').objectStore('drafts');
      const read = key => new Promise((resolve, reject) => {
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const [project, file] = await Promise.all([read('current'), read('current-file')]);
      return { project, file: file && { name: file.name, dirty: file.dirty, hasHandle: !!file.handle } };
    } finally { db.close(); }
  });
}
async function until(predicate, label) {
  const deadline = Date.now() + 10000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

try {
  console.log('Test artifacts:', output);
  await page.goto('http://127.0.0.1:18766/'); await idle();
  await showRecent();
  check('A new browser shows a clear empty state', await page.locator('#recent-projects-empty').isVisible() && await rows().count() === 0);
  check('Clear history is unavailable for an empty list', await page.locator('#recent-projects-clear').isDisabled());
  await page.keyboard.press('Escape');
  check('Escape closes the recent-project dialog', !await page.locator('#recent-projects-dialog').evaluate(element => element.open));

  const first = 'first.figure.json', second = 'second.figure.json', copy = 'copy.figure.json';
  const firstProject = fixture('First project'), secondProject = fixture('Second project');
  await writeFile(first, firstProject); await writeFile(second, secondProject);
  await pickOpen(first); await pickOpen(second); await showRecent();
  check('Opening two real files lists the newest first', JSON.stringify(await fileNames()) === JSON.stringify([second, first]));
  check('Structured-cloned OPFS handles show direct Open file actions', (await rows().locator('small').allTextContents()).every(text => text.includes('Open file')));
  await page.screenshot({ path: path.join(output, 'recent-projects.png'), fullPage: true });

  // Change the real stored bytes independently of the editor before reopening.
  await writeFile(first, { ...firstProject, name: 'First externally updated' });
  await row(first).click(); await idle();
  check('Reopening a recent entry reads the latest file bytes', await projectName() === 'First externally updated');
  check('Reopened files become the Save destination', (await page.locator('#save-project').getAttribute('title')).includes(first));
  await showRecent();
  check('Reopening moves a file to the top without duplicates', JSON.stringify(await fileNames()) === JSON.stringify([first, second]));
  await closeRecent();

  await page.locator('#project-name').fill('Keep my unsaved edits');
  await showRecent(); acceptConfirm = false;
  await row(second).click(); await idle(); acceptConfirm = true;
  check('Canceling replacement preserves unsaved edits and destination', await projectName() === 'Keep my unsaved edits' && (await page.locator('#save-project').getAttribute('title')).includes(first));
  check('Canceled reopen keeps history order and explains cancellation', JSON.stringify(await fileNames()) === JSON.stringify([first, second]) && (await page.locator('#recent-projects-status').textContent()).includes('canceled'));
  await closeRecent();

  await saveAs(copy);
  check('Save As writes the edited project to the new destination', (await readFile(copy)).name === 'Keep my unsaved edits' && (await readFile(first)).name === 'First externally updated');
  await showRecent();
  check('Save As keeps distinct file destinations even with the same project ID', JSON.stringify(await fileNames()) === JSON.stringify([copy, first, second]));
  await closeRecent();
  await page.reload(); await idle(); await showRecent();
  check('Reload restores recent order and persisted file handles', JSON.stringify(await fileNames()) === JSON.stringify([copy, first, second]) && (await rows().locator('small').allTextContents()).every(text => text.includes('Open file')));
  await row(second).click(); await idle();
  check('A restored recent handle opens directly without another picker', await projectName() === 'Second project' && await page.evaluate(() => window.recentCheckPickers.calls.length) === 0);

  await page.evaluate(async name => (await navigator.storage.getDirectory()).removeEntry(name), first);
  await showRecent(); const beforeMissing = await fileNames();
  await row(first).click(); await idle();
  check('A deleted file reports recovery guidance without changing the active project', await projectName() === 'Second project' && (await page.locator('#recent-projects-status').textContent()).includes('moved or deleted') && (await page.locator('#save-project').getAttribute('title')).includes(second));
  check('Failed reopen leaves history unchanged', JSON.stringify(await fileNames()) === JSON.stringify(beforeMissing));
  await page.screenshot({ path: path.join(output, 'missing-project.png'), fullPage: true });
  await closeRecent();

  // Keep an actual selection behind the modal, then exercise editing shortcuts.
  await page.locator('#shapes-toggle').click(); await page.locator('#add-rect').click();
  await until(async () => (await draft()).project?.slides[0].items.length === 1, 'selected object draft');
  const beforeKeys = await draft();
  await showRecent(); await page.locator('#recent-projects-close').focus();
  for (const key of ['ArrowRight', 'Delete', 'Control+z', 'Meta+z', 'Control+d', 'Meta+d']) await page.keyboard.press(key);
  const clipboardEvents = await page.evaluate(async project => {
    const { createSelection, encodeSelection, CLIPBOARD_MIME } = await import('/clipboard.js');
    const { slideProject } = await import('/deck.js');
    const selected = new Set(project.slides[0].items.map(item => item.id));
    const text = encodeSelection(createSelection(slideProject(project), selected));
    const target = document.getElementById('recent-projects-close');
    const cutData = new DataTransfer(), pasteData = new DataTransfer();
    pasteData.setData(CLIPBOARD_MIME, text); pasteData.setData('text/plain', text);
    const cut = new ClipboardEvent('cut', { bubbles: true, cancelable: true, clipboardData: cutData });
    const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: pasteData });
    const status = document.getElementById('status').textContent;
    target.dispatchEvent(cut); target.dispatchEvent(paste);
    return { cutHandled: cut.defaultPrevented, pasteHandled: paste.defaultPrevented, cutTypes: cutData.types.length, statusUnchanged: status === document.getElementById('status').textContent };
  }, beforeKeys.project);
  check('Native cut and paste events stay outside the editor while the modal is open', !clipboardEvents.cutHandled && !clipboardEvents.pasteHandled && clipboardEvents.cutTypes === 0 && clipboardEvents.statusUnchanged);
  check('Pasting a valid object payload inside the modal cannot add or remove canvas objects', await page.locator('.layer-select').count() === beforeKeys.project.slides[0].items.length);
  await page.keyboard.press('Escape');
  await page.locator('#save-project').click(); await idle();
  check('Modal keyboard shortcuts cannot nudge, delete, duplicate, or undo editor objects', JSON.stringify((await readFile(second)).slides) === JSON.stringify(beforeKeys.project.slides));
  check('Modal Escape retains the underlying selection', !await page.locator('#delete-item').isDisabled());

  await page.locator('#project-name').fill('Draft kept after clearing');
  await until(async () => (await draft()).project?.name === 'Draft kept after clearing', 'current dirty draft');
  const draftBeforeClear = await draft(), fileBeforeClear = await readFile(second);
  await showRecent(); await page.locator('#recent-projects-clear').click();
  await page.waitForFunction(() => document.getElementById('recent-projects-status').textContent.includes('History cleared'));
  check('Clear history removes only recent entries', await rows().count() === 0 && await page.locator('#recent-projects-empty').isVisible());
  check('Clear history preserves the current draft, dirty state, file binding, and file bytes', JSON.stringify(await draft()) === JSON.stringify(draftBeforeClear) && JSON.stringify(await readFile(second)) === JSON.stringify(fileBeforeClear));
  await closeRecent(); await page.reload(); await idle(); await showRecent();
  check('Cleared history stays empty after reload', await rows().count() === 0);
  check('Reload after clearing still restores the unsaved draft', await projectName() === 'Draft kept after clearing' && (await page.locator('#save-project').getAttribute('title')).includes(second));
  await closeRecent();

  // File-input fallback can remember metadata without claiming permanent access.
  const fallbackProject = fixture('Fallback project');
  await page.evaluate(() => { window.showOpenFilePicker = undefined; });
  await page.locator('#project-input').setInputFiles({ name: 'fallback.figure.json', mimeType: 'application/json', buffer: Buffer.from(serializeDeck(fallbackProject)) });
  await idle(); await showRecent();
  check('Fallback entries clearly require choosing the file again', await rows().count() === 1 && (await row('fallback.figure.json').textContent()).includes('Choose file again'));
  const chooserPromise = page.waitForEvent('filechooser');
  await row('fallback.figure.json').click(); const chooser = await chooserPromise;
  await chooser.setFiles({ name: 'fallback.figure.json', mimeType: 'application/json', buffer: Buffer.from(serializeDeck({ ...fallbackProject, name: 'Fallback updated bytes' })) });
  await idle();
  check('Clicking a fallback entry opens a real file chooser and reads the chosen bytes', await projectName() === 'Fallback updated bytes');
  await showRecent();
  check('Choosing the same fallback filename updates its existing entry', await rows().count() === 1);
  await page.getByRole('button', { name: 'Remove fallback.figure.json from recent projects', exact: true }).click();
  await until(async () => await rows().count() === 0, 'removed recent entry');
  check('Removing one entry preserves the open project', await projectName() === 'Fallback updated bytes');
  check('No uncaught editor errors', errors.length === 0);
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  console.error(error);
  console.error('PAGE ERRORS', errors);
  console.error('EDITOR STATUS', await page.locator('#status').textContent().catch(() => ''));
  console.error('RECENT STATUS', await page.locator('#recent-projects-status').textContent().catch(() => ''));
  await page.screenshot({ path: path.join(output, 'error.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ checks, errors, failure: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  await context.close(); await browser.close();
}
