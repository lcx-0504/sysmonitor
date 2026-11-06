'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { getWebviewHtml } = require('../src/view/webview-html');
const { catalogs } = require('../src/i18n');

let modules, state;
test.before(async () => {
  modules = Object.fromEntries(await Promise.all(
    ['app', 'charts', 'layout', 'performance', 'settings', 'navigation', 'servers', 'processes']
      .map(async name => [name, await import('../src/view/assets/' + name + '.mjs')]),
  ));
  ({ state } = await import('../src/view/assets/state.mjs'));
  state.locale = { language: 'zh-CN', messages: catalogs['zh-CN'] };
});

test('browser modules import without accessing the DOM before initialization', () => {
  for (const name of Object.keys(modules)) {
    assert.equal(typeof modules[name]['initialize' + name[0].toUpperCase() + name.slice(1)], 'function');
  }
});

test('frontend module dependencies form an acyclic graph', () => {
  const dir = path.join(__dirname, '../src/view/assets');
  const imports = new Map(fs.readdirSync(dir).filter(file => file.endsWith('.mjs')).map(file => [file,
    [...fs.readFileSync(path.join(dir, file), 'utf8').matchAll(/from\s+["']\.\/([^"']+)["']/g)].map(match => match[1]),
  ]));
  const done = new Set();
  function visit(file, stack = []) {
    assert.equal(stack.includes(file), false, [...stack, file].join(' -> '));
    if (done.has(file)) return;
    for (const dependency of imports.get(file) || []) visit(dependency, [...stack, file]);
    done.add(file);
  }
  for (const file of imports.keys()) visit(file);
});

test('HTML loads a native module with a nonce, allowed resource origin, and encoded configuration', async () => {
  const html = await getWebviewHtml({
    nonce: 'test', initConfig: { language: 'zh-CN', value: '<script>unsafe</script>' },
    webview: { cspSource: 'https://fixture.invalid', asWebviewUri: () => ({ toString: () => 'https://fixture.invalid/main.mjs' }) },
    vscode: { Uri: { file: value => value } },
  });
  assert.match(html, /<script type="module" nonce="test" src="https:\/\/fixture.invalid\/main.mjs"><\/script>/);
  assert.match(html, /script-src 'nonce-test' https:\/\/fixture.invalid/);
  assert.doesNotMatch(html, /<script>unsafe<\/script>/);
  const encoded = html.match(/data-config="([^"]+)"/)[1];
  assert.equal(JSON.parse(Buffer.from(encoded, 'base64')).value, '<script>unsafe</script>');
});

test('retry countdown exposes zero immediately and keeps manual retry available while paused', () => {
  const retry = modules.navigation.retryButtonState;
  assert.equal(retry('disconnected', false, false, 10000, 2000, true).text, '重试 (8)');
  assert.equal(retry('disconnected', false, false, 10000, 10000, true).text, '重试');
  assert.equal(retry('disconnected', false, true, 10000, 2000, true).text, '重试');
  assert.equal(retry('connecting', false, false, null, 0, false).disabled, true);
});

test('topbar chooses stages from measured content widths', () => {
  const choose = modules.layout.chooseTopbarStage;
  assert.equal(choose(300, [280, 210, 140, 40]), 0);
  assert.equal(choose(200, [280, 210, 140, 40]), 2);
  assert.equal(choose(20, [280, 210, 140, 40]), 3);
});

test('GPU footers use finite values and escape process search text', () => {
  assert.equal(modules.performance.gpuStatsMarkup({ temp: null, power: null }).includes('--'), true);
  assert.match(modules.performance.gpuStatsMarkup({ temp: 35, power: { draw: '40', limit: '250' } }), /35°C/);
  assert.equal(modules.processes.esc('<task>'), '&lt;task&gt;');
  assert.match(modules.processes.procSearchStr({ name: 'Task', user: 'User', cmd: 'run', pid: 12, gpus: [{ idx: 3 }] }), /gpu3 gpu 3 #3/);
});

test('layout retains card minimums, a four-column maximum, and overlay scrollbars', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/view/assets/webview.css'), 'utf8');
  assert.match(css, /150px/);
  assert.match(css, /gpu/);
  assert.match(css, /#connection-retry[^}]*secondaryBackground/);
  assert.match(css, /\.modal-scrollbar/);
  assert.match(css, /\.device-scrollbar/);
});
