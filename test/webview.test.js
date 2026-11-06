'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { getWebviewHtml } = require('../src/view/webview-html');
const { createTranslator } = require('../src/i18n');

let modules, state;
test.before(async () => {
  modules = Object.fromEntries(await Promise.all(
    ['app', 'charts', 'connection', 'layout', 'performance', 'settings', 'navigation', 'servers', 'processes']
      .map(async name => [name, await import('../src/view/assets/' + name + '.mjs')]),
  ));
  ({ state } = await import('../src/view/assets/state.mjs'));
  state.locale = { language: 'zh-CN' };
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
  assert.match(html, /style-src 'nonce-test';/);
  assert.doesNotMatch(html, /unsafe-inline/);
  assert.doesNotMatch(html, /\sstyle="/);
  assert.doesNotMatch(html, /<script>unsafe<\/script>/);
  const encoded = html.match(/data-config="([^"]+)"/)[1];
  assert.equal(JSON.parse(Buffer.from(encoded, 'base64')).value, '<script>unsafe</script>');
});

test('retry countdown exposes zero immediately and keeps manual retry available while paused', () => {
  const retry = modules.connection.retryButtonState;
  assert.equal(retry('disconnected', false, false, 10000, 2000, 'zh-CN').text, '重试 (8)');
  assert.equal(retry('disconnected', false, false, 10000, 10000, 'zh-CN').text, '重试');
  assert.equal(retry('disconnected', false, true, 10000, 2000, 'zh-CN').text, '重试');
  assert.equal(retry('connecting', false, false, null, 0, 'en').disabled, true);
});

test('topbar chooses stages from measured content widths', () => {
  const choose = modules.layout.chooseTopbarStage;
  assert.equal(choose(300, [280, 210, 140, 40]), 0);
  assert.equal(choose(200, [280, 210, 140, 40]), 2);
  assert.equal(choose(20, [280, 210, 140, 40]), 3);
});

test('GPU footers use finite values and escape process search text', () => {
  assert.deepEqual(modules.performance.gpuStatsValues({ temp: null, power: null }), { temperature: '--', power: null });
  assert.deepEqual(modules.performance.gpuStatsValues({ temp: 35, power: { draw: '40', limit: '250' } }), { temperature: '35°C', power: '40/250W' });
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

test('static labels come from the template and reflect the initial state', async () => {
  const running = await getWebviewHtml({ nonce: 'n', initConfig: { language: 'zh-CN' } });
  const paused = await getWebviewHtml({ nonce: 'n', initConfig: { language: 'zh-CN', paused: true } });
  assert.match(running, /<button class="tb on" id="pause-btn">运行中<\/button>/);
  assert.match(paused, /<button class="tb" id="pause-btn">已暂停<\/button>/);
  assert.match(running, /id="net-title">网络</);
  assert.match(running, /<span class="card-label">磁盘<\/span>/);
  assert.doesNotMatch(running, /class="sett-section"[^>]*hidden/);
  assert.match(running, /id="proc-footnote-info" aria-label="为减少 SSH 传输开销/);
});

test('process footnote reports the row limit, search coverage, and incomplete candidates', () => {
  const footnote = modules.processes.processFootnote;
  const zh = createTranslator('zh-CN');
  assert.equal(footnote({ total: 80, candidates: 80, matched: 80, searching: false }, zh), null);
  assert.deepEqual(footnote({ total: 600, candidates: 287, matched: 287, searching: false }, zh), { text: '显示前 100 个进程', incomplete: true });
  assert.deepEqual(footnote({ total: 80, candidates: 80, matched: 3, searching: true }, zh), { text: '在 80 个进程中搜索到 3 个结果。', incomplete: false });
  assert.deepEqual(footnote({ total: 600, candidates: 287, matched: 137, searching: true }, zh),
    { text: '在 287 个进程中搜索到 137 个结果，显示前 100 个，搜索结果可能不完全。', incomplete: true });
  assert.equal(footnote({ total: 600, candidates: 287, matched: 1, searching: true }, createTranslator('en')).text,
    'Found 1 result in 287 processes; results may be incomplete.');
});

test('process sessions appear in labels, tooltips, and search text but not in copied values', () => {
  const processes = modules.processes;
  const row = { pid: 2201218, name: 'python', user: 'alice', cmd: 'python train.py', cpu: 12.5, cpuWhole: 0.4, mem: 1, memStr: '1.0G', memPct: 2.5,
    gpus: [{ idx: 0, vramStr: '2G', memTotalStr: '80G', pct: 3 }], session: { type: 'tmux', name: 'train', id: 'train' } };
  const other = { ...row, pid: 3, session: null };
  assert.equal(processes.sessionLabel(row.session, false), 'tmux');
  assert.equal(processes.sessionLabel(row.session, true), 'tmux: train');
  assert.equal(processes.processNameTitle(row), 'PID 2201218  tmux: train\npython train.py');
  assert.equal(processes.processNameTitle(other), 'PID 3\npython train.py');
  assert.match(processes.procSearchStr(row), /tmux: train/);
  assert.equal(processes.selectProcessRows([row, other], 'cpu', 'screen').matchedCount, 0);
  assert.equal(processes.selectProcessRows([row, other], 'cpu', 'tmux').matchedCount, 1);
  assert.equal(processes.selectProcessRows([row, other], 'cpu', 'train').matchedCount, 2);
  const display = { cpu: 'core', ram: 'size', expandName: true, expandCmd: false };
  assert.deepEqual(processes.processCopyValues(row, display, true), ['2201218', 'python', 'alice', '12.5%', '1.0G', '#0 2G/80G 3%', 'python train.py']);
  assert.deepEqual(processes.processCopyValues({ ...row, gpus: [] }, display, false), ['2201218', 'python', 'alice', '12.5%', '1.0G', 'python train.py']);
});

test('process display preferences fill defaults and reject unknown modes', () => {
  const normalize = modules.processes.normalizeProcessDisplay;
  assert.deepEqual(normalize(undefined), { cpu: 'core', ram: 'size', expandName: false, expandCmd: false });
  assert.deepEqual(normalize({ cpu: 'both', ram: 'percent', expandName: true }), { cpu: 'both', ram: 'percent', expandName: true, expandCmd: false });
  assert.deepEqual(normalize({ cpu: 'all', ram: 1, expandCmd: 'yes' }), { cpu: 'core', ram: 'size', expandName: false, expandCmd: false });
});
