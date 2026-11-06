'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { getWebviewHtml } = require('../src/view/webview-html');
const { createTranslator } = require('../src/i18n');
const { SETTINGS } = require('../src/config/config-schema');
const { PROTOCOL_VERSION } = require('../src/view/protocol');
const { createFakeVscode } = require('./fake-vscode');

const ASSET_DIRECTORY = path.join(__dirname, '../src/view/assets');
const readAsset = (file) => fs.readFileSync(path.join(ASSET_DIRECTORY, file), 'utf8');
const readInitialConfig = (html) => JSON.parse(Buffer.from(html.match(/data-config="([^"]+)"/)[1], 'base64'));

// The static import declarations of every webview module, parsed from source without running it.
function moduleImports() {
  return new Map(fs.readdirSync(ASSET_DIRECTORY).filter((file) => file.endsWith('.mjs')).map((file) => {
    const source = readAsset(file);
    const declarations = [...source.matchAll(/^import\s+(?:([^;'"]*?)\s+from\s+)?['"]([^'"]+)['"];?/gm)];
    assert.equal(declarations.length, source.match(/^import\b/gm)?.length || 0, file + ' has an import this test cannot parse');
    return [file, declarations.map(([, clause = '', specifier]) => {
      assert.match(specifier, /^\.\/[\w-]+\.mjs$/, file + ' imports ' + specifier);
      const named = clause.match(/\{([^}]*)\}/);
      const names = named ? named[1].split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => entry.split(/\s+as\s+/)[0]) : [];
      const outside = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
      if (outside && !/^\*\s+as\s+\w+$/.test(outside)) names.push('default');
      return { target: specifier.slice(2), names };
    })];
  }));
}

let modules, state, ui;
test.before(async () => {
  modules = Object.fromEntries(await Promise.all(
    ['app', 'charts', 'connection', 'layout', 'performance', 'settings', 'navigation', 'servers', 'processes']
      .map(async name => [name, await import('../src/view/assets/' + name + '.mjs')]),
  ));
  ({ state } = await import('../src/view/assets/state.mjs'));
  ui = await import('../src/view/assets/ui.mjs');
  state.locale = { language: 'zh-CN' };
});

test('browser modules import in Node without touching the DOM until they are initialized', () => {
  for (const name of Object.keys(modules)) {
    assert.equal(typeof modules[name]['initialize' + name[0].toUpperCase() + name.slice(1)], 'function');
  }
});

test('static check: webview module dependencies form an acyclic graph', () => {
  const imports = new Map([...moduleImports()].map(([file, declarations]) => [file, declarations.map(({ target }) => target)]));
  const done = new Set();
  function visit(file, stack = []) {
    assert.equal(stack.includes(file), false, [...stack, file].join(' -> '));
    if (done.has(file)) return;
    for (const dependency of imports.get(file) || []) visit(dependency, [...stack, file]);
    done.add(file);
  }
  for (const file of imports.keys()) visit(file);
});

// main.mjs initializes the DOM when it is imported, so the bindings of every module, the entry module
// included, are checked against the exports of the modules they name. A missing binding would fail module
// linking in the browser and leave the whole webview blank.
test('every named import of a webview module, including the entry module, is exported by its target', async () => {
  const imports = moduleImports();
  const targets = new Set([...imports.values()].flat().map(({ target }) => target));
  const exported = new Map();
  for (const target of targets) {
    assert.ok(imports.has(target), target + ' does not exist');
    exported.set(target, new Set(Object.keys(await import(pathToFileURL(path.join(ASSET_DIRECTORY, target))))));
  }
  assert.ok(imports.get('main.mjs').length > 0);
  const missing = [...imports].flatMap(([file, declarations]) => declarations.flatMap(({ target, names }) =>
    names.filter((name) => !exported.get(target).has(name)).map((name) => `${file} imports ${name} from ${target}`)));
  assert.deepEqual(missing, []);
});

test('HTML loads a native module with a nonce, allowed resource origin, and encoded configuration', async () => {
  const html = await getWebviewHtml({
    nonce: 'test', initConfig: { language: 'zh-CN', value: '<script>unsafe</script>' },
    webview: { cspSource: 'https://fixture.invalid', asWebviewUri: () => ({ toString: () => 'https://fixture.invalid/main.mjs' }) },
    vscode: createFakeVscode(),
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

test('static check: every CSS custom property the scripts read is defined in the stylesheet', () => {
  const css = readAsset('webview.css');
  const scripts = fs.readdirSync(ASSET_DIRECTORY).filter((file) => file.endsWith('.mjs')).map(readAsset).join('\n');
  const read = [...new Set([...scripts.matchAll(/getPropertyValue\(\s*['"](--[\w-]+)['"]/g)].map((match) => match[1]))];
  assert.ok(read.length > 0);
  for (const property of read) assert.match(css, new RegExp(property + '\\s*:'), property);
});

test('static check: every GPU tag colour class that scripts produce has a translucent stylesheet background', () => {
  const css = readAsset('webview.css');
  const produced = new Set([0, 70, 90].map(ui.tagColorClass));
  produced.add('tag-unknown');
  assert.deepEqual([...produced].sort(), ['tag-accent', 'tag-danger', 'tag-unknown', 'tag-warn']);
  for (const className of produced) assert.match(css, new RegExp('\\.gpu-tag\\.' + className + '\\b[^{]*\\{[^}]*background:[^;}]*transparent'), className);
});

test('process GPU tags colour by memory percentage and mark usage without a matching card', () => {
  const tags = modules.processes.gpuTags({ gpus: [
    { idx: 0, vramStr: '0.0G', memTotalStr: '80.0G', pct: 0 },
    { idx: 1, vramStr: '60.0G', memTotalStr: '80.0G', pct: 75 },
    { idx: 2, vramStr: '76.0G', memTotalStr: '80.0G', pct: 95 },
    { idx: 3, vramStr: '1.0G', pct: null, mappingStatus: 'unmatched' },
  ] });
  assert.deepEqual(tags, [
    { className: 'gpu-tag tag-accent', text: '#0 0.0G/80.0G 0%' },
    { className: 'gpu-tag tag-warn', text: '#1 60.0G/80.0G 75%' },
    { className: 'gpu-tag tag-danger', text: '#2 76.0G/80.0G 95%' },
    { className: 'gpu-tag tag-unknown', text: '#3 1.0G/— —' },
  ]);
  assert.deepEqual(modules.processes.gpuTags({}), []);
});

test('messages to the extension carry the protocol version and go through the VS Code bridge', () => {
  const posted = [];
  const bridge = state.bridge;
  state.bridge = { postMessage: (message) => posted.push(message) };
  try {
    ui.sendToExtension('switchPage', { page: 'proc' });
  } finally {
    state.bridge = bridge;
  }
  assert.deepEqual(posted, [{ version: PROTOCOL_VERSION, cmd: 'switchPage', page: 'proc' }]);
});

test('the settings page takes the GPU first-N range from the configuration schema', async () => {
  const { minimum, maximum, default: initial } = SETTINGS.statusBar.properties.gpu.properties.firstN;
  const html = await getWebviewHtml({ nonce: 'n', initConfig: { language: 'en' } });
  assert.deepEqual(readInitialConfig(html).gpuFirstSetting, { default: initial, minimum, maximum });
});

test('static check: overlay scrollbars float over their content and the retry button uses the theme secondary button colours', () => {
  const css = readAsset('webview.css');
  for (const selector of ['.modal-scrollbar', '.device-scrollbar']) assert.match(css, new RegExp(selector.replace('.', '\\.') + ' \\{[^}]*position: absolute'), selector);
  assert.match(css, /#connection-retry \{[^}]*--vscode-button-secondaryBackground[^}]*--vscode-button-secondaryForeground/);
});

test('static check: the stylesheet has one [hidden] rule, one !important, z-index only through named layers and one reduced-motion block', () => {
  const css = readAsset('webview.css');
  assert.equal(css.match(/\[hidden\]/g).length, 1);
  assert.equal(css.match(/!important/g).length, 1);
  assert.doesNotMatch(css, /z-index:\s*\d/);
  assert.equal(css.match(/prefers-reduced-motion/g).length, 1);
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

test('process footnote reports the row limit and search coverage, and shows its info button only for incomplete candidates', () => {
  const footnote = modules.processes.processFootnote;
  const zh = createTranslator('zh-CN');
  assert.equal(footnote({ total: 80, candidates: 80, matched: 80, searching: false }, zh), null);
  assert.deepEqual(footnote({ total: 600, candidates: 287, matched: 287, searching: false }, zh), { text: '显示前 100 个进程', incomplete: true });
  assert.deepEqual(footnote({ total: 150, candidates: 150, matched: 150, searching: false }, zh), { text: '显示前 100 个进程', incomplete: false });
  assert.deepEqual(footnote({ total: 150, candidates: 150, matched: 120, searching: true }, zh), { text: '在 150 个进程中搜索到 120 个结果，显示前 100 个。', incomplete: false });
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
