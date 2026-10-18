import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDemo } from '../demo.js';
import { createProject, validateProject, serializeProject, projectToSVG } from '../core.js';

test('missing local example yields editable synthetic content that round-trips and exports', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ status: 404, ok: false, json() { throw new Error('404 body must not be read'); } }));
  const project = await makeDemo();
  assert.deepEqual(validateProject(project), project);
  assert.deepEqual(JSON.parse(serializeProject(project)), project);
  assert.deepEqual(project.assets, []);
  assert.ok(project.items.length > 0);
  assert.deepEqual(new Set(project.items.map(item => item.type)), new Set(['text', 'rect', 'line']));
  assert.ok(project.items.every(item => !item.locked && !item.hidden));
  const svg = projectToSVG(project);
  assert.match(svg, /<text\b/);
  assert.match(svg, /<rect\b/);
  assert.match(svg, /<line\b/);
  assert.doesNotMatch(svg, /<image\b|data:image/);
  const second = await makeDemo();
  project.items[0].text = 'Edited label';
  assert.notEqual(second.items[0].text, project.items[0].text);
  assert.match(projectToSVG(project), /Edited label/);
});

test('loads the optional relative local project and validates it without mutating its input', async t => {
  const input = createProject();
  input.name = 'Local fixture';
  input.items = [{ id: 'local-label', type: 'text', x: 10, y: 20, width: 200, height: 30, text: 'Local editable label' }];
  input.unknown = 'discard me';
  const original = structuredClone(input);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(String(url));
    return { status: 200, ok: true, json: async () => input };
  });
  const project = await makeDemo();
  assert.deepEqual(requests, [new URL('../examples/local-demo.figure.json', import.meta.url).href]);
  assert.deepEqual(project, validateProject(input));
  assert.equal(project.name, 'Local fixture');
  assert.equal(project.unknown, undefined);
  assert.deepEqual(input, original);
  assert.notEqual(project, input);
});

test('HTTP errors other than 404 remain visible instead of replacing the local project', async t => {
  let status = 403;
  t.mock.method(globalThis, 'fetch', async () => ({ status, ok: false, json() { throw new Error('error body must not be read'); } }));
  for (status of [403, 500]) await assert.rejects(makeDemo(), new RegExp(`Could not load the local example \\(${status}\\)`));
});

test('network and JSON failures remain visible', async t => {
  const networkError = new TypeError('Connection unavailable');
  const parseError = new SyntaxError('Invalid JSON');
  let response;
  t.mock.method(globalThis, 'fetch', async () => {
    if (!response) throw networkError;
    return response;
  });
  await assert.rejects(makeDemo(), error => error === networkError);
  response = { status: 200, ok: true, json: async () => { throw parseError; } };
  await assert.rejects(makeDemo(), error => error === parseError);
});

test('an invalid local project fails validation rather than silently loading the synthetic example', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ status: 200, ok: true, json: async () => ({ format: 'figure-editor', version: 99 }) }));
  await assert.rejects(makeDemo(), /Invalid figure project/);
});
