'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { listSshHosts } = require('../src/ssh/ssh-config');
const { SshTransport } = require('../src/ssh/ssh-transport');
const { normalizeNavigation } = require('../src/view/multi-monitor-view-provider');
const { MultiMonitorViewProvider } = require('../src/view/multi-monitor-view-provider');
const { normalizeConfig } = require('../src/config/normalize-config');
const { getWebviewHtml } = require('../src/view/webview-html');
const { MonitorService } = require('../src/services/monitor-service');

test('SSH host list reads explicit aliases and Include globs without duplicate or wildcard devices', async () => {
  const home = path.join(os.homedir(), 'sysmonitor-test-fixture');
  const config = path.join(home, '.ssh', 'config');
  const include = path.join(home, '.ssh', 'config.d', 'one.conf');
  const files = new Map([
    [config, 'Host campus lab007 *-gpu\n  HostName example.invalid\nInclude config.d/*.conf\nHost campus\n'],
    [include, 'Host lab008 ?ther !deny\n'],
  ]);
  const fileSystem = {
    async realpath(file) { if (!files.has(file)) throw new Error('not found'); return file; },
    async readFile(file) { return files.get(file); },
    async readdir(dir) { return dir === path.dirname(include) ? ['one.conf'] : []; },
  };
  assert.deepEqual(await listSshHosts(config, { home, fileSystem }), ['campus', 'lab007', 'lab008']);
});

test('SSH transport keeps one shell session, quotes arguments, and serializes parallel commands', async () => {
  let starts = 0;
  const transport = new SshTransport({
    host: 'fixture',
    requireLinux: false,
    spawnProcess: () => { starts++; return spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SSH_CONNECTION: '10.0.0.1 50000 10.0.0.2 22' } }); },
  });
  try {
    const values = await Promise.all([
      transport.execFile('printf', ["a'b\\n"], { timeoutMilliseconds: 3000 }),
      transport.execFile('printf', ['second'], { timeoutMilliseconds: 3000 }),
    ]);
    assert.equal(values[0].stdout, "a'b");
    assert.equal(values[1].stdout, 'second');
    assert.equal(starts, 1);
    assert.deepEqual(transport.sshConnection, { clientIp: '10.0.0.1', clientPort: 50000, serverIp: '10.0.0.2', serverPort: 22 });
    await assert.rejects(transport.execFile('sh', ['-c', 'exit 7'], { timeoutMilliseconds: 3000 }), /Remote command exited \(7\)/);
  } finally { transport.dispose(); }
});

test('SSH retry delay is not extended by scheduled collectors and short queued commands do not kill the session', async () => {
  const transport = new SshTransport({
    host: 'fixture', requireLinux: false,
    spawnProcess: () => spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  try {
    const retryAfter = Date.now() + 10000;
    transport.retryAfter = retryAfter;
    transport.lastError = new Error('SSH command timed out: cat');
    await assert.rejects(transport.execFile('cat', ['/proc/stat']), /SSH command timed out: cat/);
    assert.equal(transport.retryAfter, retryAfter);
    transport.retryAfter = Date.now() - 1;
    assert.equal((await transport.execFile('printf', ['recovered'], { timeoutMilliseconds: 3000 })).stdout, 'recovered');
    assert.equal(transport.retryAfter, 0);
    await assert.rejects(transport.execFile('cat', ['/proc/stat'], { timeoutMilliseconds: 1 }), /while queued/);
    assert.ok(transport.child);
  } finally { transport.dispose(); }
});

test('navigation restore preserves selected device and page, with a fixed local Linux tab', () => {
  assert.deepEqual(normalizeNavigation({ tabs: ['ssh:campus', 'ssh:campus', 'ssh:lab007'], selected: 'ssh:lab007', page: 'proc' }, true), {
    tabs: ['local', 'ssh:campus', 'ssh:lab007'], selected: 'ssh:lab007', page: 'proc', processDisplay: { cpu: 'core', ram: 'size' },
  });
  assert.deepEqual(normalizeNavigation({}, false), { tabs: [], selected: null, page: 'servers', processDisplay: { cpu: 'core', ram: 'size' } });
  assert.deepEqual(normalizeNavigation({ tabs: ['ssh:campus', 'local', 'ssh:lab007'], selected: 'local', page: 'perf' }, true).tabs, ['ssh:campus', 'local', 'ssh:lab007']);
});

test('server settings restore by default and normalize invalid values', () => {
  assert.deepEqual(normalizeConfig({}).servers, { visibleOnly: false, restoreTabs: true });
  assert.deepEqual(normalizeConfig({ servers: { visibleOnly: true, restoreTabs: false } }).servers, { visibleOnly: true, restoreTabs: false });
  assert.deepEqual(normalizeConfig({ servers: { visibleOnly: 'yes', restoreTabs: null } }).servers, { visibleOnly: false, restoreTabs: true });
});

test('monitor cards start empty while a newly selected SSH server is loading', () => {
  const assets = path.join(__dirname, '..', 'src', 'view', 'assets');
  const css = fs.readFileSync(path.join(assets, 'webview.css'), 'utf8');
  const startup = fs.readFileSync(path.join(assets, 'webview-processes.js'), 'utf8');
  assert.match(css, /\.fill\s*\{\s*width:\s*0;/);
  assert.match(startup, /applyGroupVisibility\(\);\s*document\.getElementById\('ssh-card'\)\.style\.display = 'none';/);
});

test('status bar settings stay available in local non-Linux windows', () => {
  const settings = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview-settings.js'), 'utf8');
  assert.doesNotMatch(settings, /getElementById\('sett-bar-section'\)\.hidden/);
});

test('local sidebars show a one-time server guide and a status-bar scope tip', async () => {
  let dismissed = false;
  const updates = [];
  const provider = new MultiMonitorViewProvider({
    vscode: { env: { language: 'zh-cn' }, workspace: { getConfiguration: () => ({ get: () => null }) } },
    manager: { sync() {}, setConfigFile() {}, get() { return null; } },
    configStore: { getCurrent: () => normalizeConfig({}) },
    workspaceState: { get: () => ({}) },
    uiStateStore: { get: () => dismissed, update: async (key, value) => { updates.push([key, value]); dismissed = value; } },
    localLinux: false, loadHosts: async () => [],
  });
  const readInitial = (html) => JSON.parse(Buffer.from(html.match(/data-config="([A-Za-z0-9+/=]+)"/)[1], 'base64').toString('utf8'));
  const sidebarHtml = await provider.buildHtml(provider.sidebarState, { sidebar: true });
  const editorHtml = await provider.buildHtml(provider.sidebarState);
  assert.equal(readInitial(sidebarHtml).showLocalIntro, true);
  assert.equal(readInitial(editorHtml).showLocalIntro, false);
  assert.match(editorHtml, /data-surface="editor"/);
  assert.match(sidebarHtml, /data-surface="sidebar"/);
  assert.match(sidebarHtml, /id="server-intro-hint"/);
  assert.match(sidebarHtml, /id="server-intro-close">我知道了<\/button><button type="button" class="tb on" id="server-intro-ssh-default">自动安装<\/button>/);
  assert.match(sidebarHtml, /id="sett-bar-info"/);
  const linuxProvider = new MultiMonitorViewProvider({
    vscode: { env: { language: 'zh-cn' }, workspace: { getConfiguration: () => ({ get: () => null }) } },
    manager: { sync() {}, setConfigFile() {}, get() { return null; } },
    configStore: { getCurrent: () => normalizeConfig({}) },
    workspaceState: { get: () => ({}) },
    uiStateStore: { get: () => false },
    localLinux: true, loadHosts: async () => [],
  });
  assert.equal(readInitial(await linuxProvider.buildHtml(linuxProvider.sidebarState, { sidebar: true })).showLocalIntro, true);
  const messages = [];
  const source = { state: provider.sidebarState, ready: true, target: { webview: { postMessage: (message) => messages.push(message) } } };
  provider.sidebar = source;
  await provider.handleMessage({ version: 1, cmd: 'dismissLocalIntro' }, source);
  assert.deepEqual(updates, [['sysmonitor.localIntroDismissed', true]]);
  assert.equal(messages.some((message) => message.cmd === 'localIntroDismissed'), true);
  assert.equal(readInitial(await provider.buildHtml(provider.sidebarState, { sidebar: true })).showLocalIntro, false);
});

test('SSH default-install action is explicit, deduplicated, and writes the global Remote-SSH setting', async () => {
  const entries = ['example.other-extension'];
  const writes = [];
  const configuration = {
    get: (key) => key === 'defaultExtensions' ? entries : null,
    update: async (key, value, target) => {
      writes.push({ key, value, target });
      entries.splice(0, entries.length, ...value);
    },
  };
  const provider = new MultiMonitorViewProvider({
    vscode: { env: { language: 'zh-cn' }, workspace: { getConfiguration: () => configuration } },
    manager: { sync() {}, setConfigFile() {}, get() { return null; } },
    configStore: { getCurrent: () => normalizeConfig({}) },
    workspaceState: { get: () => ({}) },
    localLinux: false, loadHosts: async () => [],
  });
  const messages = [];
  const source = { state: provider.sidebarState, ready: true, target: { webview: { postMessage: (message) => messages.push(message) } } };
  provider.sidebar = source;
  assert.equal(provider.isSshDefaultExtension(), false);
  assert.equal(writes.length, 0);
  await provider.handleMessage({ version: 1, cmd: 'addSshDefaultExtension' }, source);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], { key: 'defaultExtensions', value: ['example.other-extension', 'LiChenxi.sysmonitor'], target: true });
  assert.equal(provider.isSshDefaultExtension(), true);
  assert.equal(messages.at(-1).installed, true);
  await provider.handleMessage({ version: 1, cmd: 'addSshDefaultExtension' }, source);
  assert.equal(writes.length, 1);
  assert.match(await provider.buildHtml(provider.sidebarState, { sidebar: true }), /id="server-intro-ssh-default"/);
});

test('SSH default-install errors are returned to the inline controls without changing settings', async () => {
  const configuration = { get: () => [], update: async () => { throw new Error('settings write denied'); } };
  const provider = new MultiMonitorViewProvider({
    vscode: { workspace: { getConfiguration: () => configuration } },
    manager: { sync() {}, setConfigFile() {}, get() { return null; } },
    configStore: { getCurrent: () => normalizeConfig({}) },
    workspaceState: { get: () => ({}) },
    localLinux: false, loadHosts: async () => [],
  });
  const messages = [];
  const source = { state: provider.sidebarState, ready: true, target: { webview: { postMessage: (message) => messages.push(message) } } };
  provider.sidebar = source;
  await provider.handleMessage({ version: 1, cmd: 'addSshDefaultExtension' }, source);
  assert.deepEqual(messages.at(-1), { cmd: 'sshDefaultExtensions', installed: false, error: 'settings write denied' });
});

test('tab sorting stays inside the device strip and Webview state updates preserve other hints', () => {
  const assets = path.join(__dirname, '..', 'src/view/assets');
  const navigation = fs.readFileSync(path.join(assets, 'webview-navigation.js'), 'utf8');
  const processes = fs.readFileSync(path.join(assets, 'webview-processes.js'), 'utf8');
  const style = fs.readFileSync(path.join(assets, 'webview.css'), 'utf8');
  assert.doesNotMatch(navigation, /dataTransfer|dragstart/);
  assert.match(navigation, /tab\.setPointerCapture\(event\.pointerId\)/);
  assert.match(navigation, /tab\.addEventListener\('auxclick', function\(event\) \{\s*if \(event\.button !== 1 \|\| id === 'local'\) return;\s*event\.preventDefault\(\);\s*sendToExtension\(\{ cmd: 'closeDevice', id: id \}\)/);
  assert.match(navigation, /moveTabWithinStrip\(event\)/);
  assert.match(navigation, /if \(tabs\.length < 2\) return;/);
  assert.match(navigation, /var minOffset = Math\.min\(0, bounds\.left \+ 1 - drag\.origin\.left\)/);
  assert.match(navigation, /var maxOffset = Math\.max\(0, bounds\.right - 1 - drag\.origin\.right\)/);
  assert.match(style, /\.device-tab\.dragging\s*\{[^}]*opacity:\s*\.68;/);
  assert.match(style, /\.device-strip\s*\{[^}]*clip-path:\s*inset\(0\);/);
  assert.match(style, /\.topbar\.instant-page \.tb\s*\{\s*transition:\s*none;/);
  assert.match(navigation, /var tabAvailabilityChanged = \(navigation\.tabs\.length === 0\) !== \(state\.tabs\.length === 0\)/);
  assert.match(style, /\.server-intro-actions\s*\{[^}]*justify-content:\s*flex-end;/);
  assert.match(style, /\.server-intro-actions \.tb\s*\{[^}]*min-height:\s*26px;/);
  assert.match(navigation, /slot\.tab\.style\.transform = shift \? 'translateX\('/);
  assert.match(navigation, /var shouldReorder = drag\.active && drag\.targetIndex !== drag\.originIndex/);
  assert.doesNotMatch(navigation, /pointerInsideStrip/);
  assert.match(navigation, /vscode\.setState\(Object\.assign\(\{\}, vscode\.getState\(\) \|\| \{\}, \{ navigation: navigation \}\)\)/);
  assert.match(processes, /vscode\.setState\(Object\.assign\(\{\}, vscode\.getState\(\) \|\| \{\}, \{ hintDismissed: true \}\)\)/);
  assert.match(style, /\.gpu-info-popover\.sett-info-popover\s*\{\s*z-index:\s*260;/);
  assert.match(style, /body\[data-surface="editor"\]\s*\{\s*--card-bg:\s*var\(--vscode-editor-background/);
});

test('page navigation precedes flat device tabs and server actions use Codicons', async () => {
  const html = await getWebviewHtml({ initConfig: {}, nonce: 'test' });
  const assets = path.join(__dirname, '..', 'src', 'view', 'assets');
  const css = fs.readFileSync(path.join(assets, 'webview.css'), 'utf8');
  const navigation = fs.readFileSync(path.join(assets, 'webview-navigation.js'), 'utf8');
  assert.ok(html.indexOf('class="topbar"') < html.indexOf('id="device-strip"'));
  assert.match(css, /\.device-tab\s*\{[^}]*border:\s*0;/);
  assert.match(css, /\.device-tab\s*\{[^}]*height:\s*25px;/);
  assert.match(css, /\.device-tab\.active::after\s*\{[^}]*bottom:\s*0;[^}]*background:\s*var\(--accent\);/);
  assert.match(css, /\.device-tab-close\s*\{[^}]*cursor:\s*pointer;/);
  assert.match(css, /\.device-tab-close:hover\s*\{[^}]*background:/);
  assert.match(navigation, /serverIcons = \{[\s\S]*editor: '<svg[\s\S]*window: '<svg[\s\S]*remote: '<svg[\s\S]*terminal: '<svg/);
  assert.match(navigation, /remote: '<svg viewBox="0 0 16 16"/);
  assert.doesNotMatch(navigation, /editor\.textContent = '↗'|terminal\.textContent = '>_'/);
  assert.match(navigation, /deviceStrip\.hidden = !hasTabs \|\| navigation\.page === 'servers'/);
  assert.match(navigation, /document\.getElementById\('updated'\)\.hidden = serverPageActive/);
  assert.match(navigation, /if \(tabsChanged \|\| deviceStrip\.childElementCount !== state\.tabs\.length\) renderDeviceTabs\(\);\s*else updateDeviceTabsPresentation\(\)/);
  const webview = fs.readFileSync(path.join(assets, 'webview.js'), 'utf8');
  assert.match(webview, /requestedPage = name;[\s\S]*?updateDeviceTabsPresentation\(\);[\s\S]*?sendToExtension\(\{cmd:'switchPage',page:name\}\)/);
  assert.match(navigation, /topbar\.hidden = false/);
  assert.match(navigation, /document\.getElementById\('tab-perf-btn'\)\.hidden = !hasTabs/);
  assert.match(navigation, /document\.getElementById\('topbar-server-refresh'\)\.hidden = !serverPageActive/);
  assert.match(navigation, /open\.textContent = zh \? '打开' : 'Open'/);
  assert.match(navigation, /open\.className = 'tb server-open'/);
  assert.match(navigation, /editor\.className = 'server-action server-editor'/);
  assert.match(navigation, /floating\.className = 'server-action server-window'/);
  assert.match(navigation, /sendToExtension\(\{ cmd: 'openServer', host: server\.host, inWindow: true \}\)/);
  assert.match(navigation, /remote\.className = 'server-action server-remote'/);
  assert.match(navigation, /actions\.appendChild\(open\); actions\.appendChild\(editor\); actions\.appendChild\(floating\); actions\.appendChild\(terminal\); actions\.appendChild\(remote\)/);
  assert.match(navigation, /connect\.textContent = zh \? '连接主机' : 'Connect to host'/);
  assert.doesNotMatch(navigation, /最近打开的文件夹|暂无记录/);
  assert.match(navigation, /if \(folders\.length\) \{\s*var divider = document\.createElement\('div'\)/);
  assert.match(navigation, /sendToExtension\(\{ cmd: 'listRemoteFolders', host: host \}\)/);
  assert.match(navigation, /terminal\.className = 'server-action server-terminal'/);
  assert.match(css, /\.server-action\s*\{[^}]*border:\s*0;/);
  assert.match(css, /\.server-folder-menu\s*\{[^}]*position:\s*fixed;/);
  assert.match(css, /\.server-folder-menu\s*\{[^}]*width:\s*max-content;[^}]*max-width:\s*min\(200px,/);
  assert.doesNotMatch(css, /\.server-folder-menu\s*\{[^}]*min-width:/);
  assert.doesNotMatch(navigation, /tab\.draggable = true|dataTransfer/);
  assert.match(navigation, /tab\.setPointerCapture\(event\.pointerId\)/);
  assert.match(navigation, /deviceStrip\.getBoundingClientRect\(\)/);
  assert.match(navigation, /sendToExtension\(\{ cmd: 'reorderDevices', tabs: reordered \}\)/);
});

test('device tab reorder persists per view and rejects unknown devices', async () => {
  const writes = [];
  const provider = new MultiMonitorViewProvider({
    vscode: { workspace: { getConfiguration: () => ({ get: () => null }) } },
    manager: { sync() {}, setConfigFile() {}, get() { return null; } },
    configStore: { getCurrent: () => normalizeConfig({}) },
    workspaceState: { get: () => ({ tabs: ['ssh:first', 'ssh:second'], selected: 'ssh:first', page: 'perf' }), update: async (_key, value) => { writes.push(value.tabs); } },
    localLinux: false, loadHosts: async () => [],
  });
  const source = { sidebar: true, state: provider.sidebarState, target: { visible: true, webview: { postMessage() {} } } };
  provider.sidebar = source;
  await provider.handleMessage({ version: 1, cmd: 'reorderDevices', tabs: ['ssh:second', 'ssh:first'] }, source);
  assert.deepEqual(source.state.tabs, ['ssh:second', 'ssh:first']);
  assert.deepEqual(writes.at(-1), ['ssh:second', 'ssh:first']);
  await provider.handleMessage({ version: 1, cmd: 'reorderDevices', tabs: ['ssh:second', 'ssh:other'] }, source);
  assert.deepEqual(source.state.tabs, ['ssh:second', 'ssh:first']);
});

test('closing the final device tab immediately updates its server row to idle', async () => {
  const devices = new Map([['ssh:campus', { id: 'ssh:campus', state: 'connected', model: null, service: { readSnapshot: () => null } }]]);
  const manager = {
    get: (id) => devices.get(id) || null,
    setConfigFile() {},
    sync(open) { for (const id of devices.keys()) if (!open.has(id)) devices.delete(id); },
  };
  const provider = new MultiMonitorViewProvider({
    vscode: { workspace: { getConfiguration: () => ({ get: () => null }) } },
    manager, configStore: { getCurrent: () => normalizeConfig({}) },
    workspaceState: { get: () => ({ tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'perf' }), update: async () => {} },
    localLinux: false, loadHosts: async () => ['campus'],
  });
  await provider.refreshHosts();
  const messages = [];
  const source = { state: provider.sidebarState, sidebar: true, ready: true, target: { visible: true, webview: { postMessage: (message) => messages.push(message) } } };
  provider.sidebar = source;
  await provider.handleMessage({ version: 1, cmd: 'closeDevice', id: 'ssh:campus' }, source);
  assert.deepEqual(source.state.tabs, []);
  assert.equal(devices.has('ssh:campus'), false);
  assert.equal(messages.some((message) => message.cmd === 'servers' && message.hosts[0].state === 'idle'), true);
});

test('native Editor tab keeps a short title regardless of selected server', async () => {
  let createdTitle = null;
  const provider = new MultiMonitorViewProvider({
    vscode: {
      ViewColumn: { Active: 1 },
      window: { createWebviewPanel: (_type, title) => { createdTitle = title; return {}; } },
      workspace: { getConfiguration: () => ({ get: () => null }) },
    },
    manager: { sync() {}, setConfigFile() {}, get() { return null; } },
    configStore: { getCurrent: () => normalizeConfig({}) },
    workspaceState: { get: () => ({}) }, localLinux: false, loadHosts: async () => [],
  });
  provider.attachEditor = async () => {};
  await provider.openEditorPanel({ tabs: ['ssh:lichenxi_lab007_vps'], selected: 'ssh:lichenxi_lab007_vps', page: 'perf' });
  assert.equal(createdTitle, 'System Monitor');
});

test('floating monitor reuses the Editor view and moves it into a native window', async () => {
  const calls = [];
  const panel = { reveal: (column) => calls.push(['reveal', column]), dispose() { calls.push(['dispose']); } };
  const provider = new MultiMonitorViewProvider({
    vscode: { ViewColumn: { Active: 1 }, commands: { executeCommand: async (command) => calls.push(['command', command]) }, workspace: { getConfiguration: () => ({ get: () => null }) } },
    manager: { sync() {}, setConfigFile() {}, get() { return null; } },
    configStore: { getCurrent: () => normalizeConfig({}) },
    workspaceState: { get: () => ({}) }, localLinux: false, loadHosts: async () => [],
  });
  provider.openEditorPanel = async (state) => { calls.push(['openEditor', state.selected]); return panel; };
  await provider.openFloatingPanel({ tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'proc' });
  assert.deepEqual(calls, [['openEditor', 'ssh:campus'], ['reveal', 1], ['command', 'workbench.action.moveEditorToNewWindow']]);
});

test('page switches retain the current snapshot while device switches hydrate atomically', async () => {
  const config = normalizeConfig({});
  const model = { performance: { cpu: { usagePercent: 12 } }, processes: [] };
  const device = (id) => ({ id, host: id.slice(4), state: 'connecting', error: null, model, history: [{ t: 1, cpu: 12 }], service: { readSnapshot: () => ({ accelerators: { value: null } }) } });
  const devices = new Map([['ssh:campus', device('ssh:campus')], ['ssh:lab007', device('ssh:lab007')]]);
  const manager = { paused: false, get: (id) => devices.get(id), sync() {}, setConfigFile() {} };
  const provider = new MultiMonitorViewProvider({
    vscode: { env: { language: 'zh-cn' }, workspace: { getConfiguration: () => ({ get: () => null }) } },
    manager, configStore: { getCurrent: () => config },
    workspaceState: { get: () => ({ tabs: ['ssh:campus', 'ssh:lab007'], selected: 'ssh:campus', page: 'perf' }), update: async () => {} },
    localLinux: false, loadHosts: async () => [],
  });
  const messages = [];
  const source = { state: provider.sidebarState, sidebar: true, ready: true, target: { visible: true, webview: { postMessage: (message) => messages.push(message) } } };
  provider.sidebar = source;
  await provider.handleMessage({ version: 1, cmd: 'switchPage', page: 'servers' }, source);
  assert.equal(messages.filter((message) => message.cmd === 'navigation').length, 1);
  assert.equal(messages.some((message) => message.cmd === 'history' || message.cmd === 'snapshot'), false);
  messages.length = 0;
  provider.onDeviceUpdate('ssh:campus', devices.get('ssh:campus'));
  assert.equal(messages.some((message) => message.cmd === 'snapshot'), true);
  assert.equal(messages.find((message) => message.cmd === 'snapshot').sampleTime, 1);
  messages.length = 0;
  await provider.handleMessage({ version: 1, cmd: 'switchDevice', id: 'ssh:lab007' }, source);
  assert.equal(messages.filter((message) => message.cmd === 'deviceState').length, 1);
  assert.equal(messages.some((message) => message.cmd === 'history' || message.cmd === 'snapshot'), false);
  assert.equal(messages.find((message) => message.cmd === 'deviceState').viewModel, model);
  assert.equal(messages.find((message) => message.cmd === 'deviceState').samples[0].t, 1);
  assert.equal(messages.find((message) => message.cmd === 'deviceState').sampleTime, 1);
  messages.length = 0;
  provider.sendCurrent(source);
  assert.equal(messages.find((message) => message.cmd === 'snapshot').sampleTime, 1);
});

test('chart history keeps source timestamps and does not append a duplicate point on hydration', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview.js'), 'utf8');
  const historyCode = script.slice(script.indexOf('  function pushHist('), script.indexOf('  // ── 消息处理'));
  const context = { SPARK_WINDOW: 300000, curInterval: 2 };
  vm.runInNewContext(`${historyCode}\nthis.pushHist = pushHist;`, context);
  const samples = [];
  context.pushHist(samples, 20, 10000);
  context.pushHist(samples, 30, 12000);
  context.pushHist(samples, 35, 12000);
  assert.deepEqual(Array.from(samples, (point) => [point.t, point.v]), [[10000, 20], [12000, 35]]);
  const navigation = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview-navigation.js'), 'utf8');
  assert.match(navigation, /restoreHistory\(data\.samples\);\s*if \(data\.viewModel\) renderMonitorSnapshot\(data\.viewModel, true, data\.sampleTime, true\)/);
  assert.match(script, /function recordHistory\(series, value\) \{ if \(!skipHistory\) pushHist\(series, value, sampleTime\); \}/);
  assert.match(script, /getElementById\('updated'\)\.textContent = T\.updAt \+ new Date\(typeof sampleTime === 'number' \? sampleTime : Date\.now\(\)\)\.toLocaleTimeString\(\)/);
});

test('remote process collection allows SSH queue time without changing local timeout', () => {
  const remote = new MonitorService({ runtimeConfig: normalizeConfig({}), isSsh: false, commandRunner: { dispose() {} }, fileReader: { readFile() {} }, systemInfo: {} });
  const local = new MonitorService({ runtimeConfig: normalizeConfig({}), isSsh: false });
  assert.equal(remote.runners.find((runner) => runner.key === 'processes').collector.timeoutMilliseconds, 10000);
  assert.equal(remote.runners.find((runner) => runner.key === 'processes').timeoutMilliseconds, 12000);
  assert.equal(local.runners.find((runner) => runner.key === 'processes').collector.timeoutMilliseconds, 3000);
  remote.dispose(); local.dispose();
});

test('sidebar and editor restore independent device/page state while sharing open device references', async () => {
  const syncs = [];
  const config = normalizeConfig({});
  const manager = {
    paused: false,
    sync(open, visible) { syncs.push({ open: [...open], visible: [...visible] }); },
    get() { return null; },
    setConfigFile() {},
  };
  const stored = { tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'proc', processDisplay: { cpu: 'core', ram: 'size' } };
  const workspaceState = { get: () => stored, update: async () => {} };
  const vscode = {
    env: { language: 'zh-cn' },
    Uri: { file: (file) => file },
    workspace: { getConfiguration: () => ({ get: () => null }) },
  };
  const provider = new MultiMonitorViewProvider({ vscode, manager, configStore: { getCurrent: () => config }, workspaceState, localLinux: false, loadHosts: async () => ['campus', 'lab007'] });
  assert.deepEqual(provider.sidebarState.tabs, ['ssh:campus']);
  const messages = [];
  const panel = {
    visible: true,
    webview: {
      onDidReceiveMessage(handler) { this.receive = handler; },
      postMessage(message) { messages.push(message); },
    },
    onDidDispose(handler) { this.dispose = handler; },
    onDidChangeViewState() {},
  };
  await provider.attachEditor(panel, { tabs: ['ssh:lab007'], selected: 'ssh:lab007', page: 'perf', processDisplay: { cpu: 'whole', ram: 'size' } });
  assert.equal(panel.title, 'System Monitor');
  assert.equal(path.basename(panel.iconPath.light), 'icon-tab-light.svg');
  assert.equal(path.basename(panel.iconPath.dark), 'icon-tab-dark.svg');
  assert.deepEqual(syncs.at(-1).open.sort(), ['ssh:campus', 'ssh:lab007']);
  await provider.handleMessage({ version: 1, cmd: 'ready' }, provider.editors.get(panel));
  assert.equal(messages.some((message) => message.cmd === 'navigation' && message.state.selected === 'ssh:lab007'), true);
  await provider.handleMessage({ version: 1, cmd: 'switchPage', page: 'servers' }, provider.editors.get(panel));
  assert.equal(provider.editors.get(panel).state.page, 'servers');
  assert.equal(provider.sidebarState.page, 'proc');
  panel.dispose();
  assert.deepEqual(syncs.at(-1).open, ['ssh:campus']);
});

test('server actions wait for SSH and keep failed hosts out of Editor and terminal', async () => {
  const devices = new Map();
  const manager = {
    paused: false, configFile: null,
    get(id) { return devices.get(id) || null; },
    open(id) {
      const device = {
        id, host: id.slice(4), state: 'connecting', error: null, model: null, history: [],
        transport: { connect: async () => { if (id === 'ssh:bad') throw new Error('SSH exited (255)'); } },
        service: { readSnapshot: () => ({ accelerators: { value: null } }) },
      };
      devices.set(id, device);
      return device;
    },
    sync(open) { for (const id of devices.keys()) if (!open.has(id)) devices.delete(id); },
    setConfigFile() {},
  };
  let editorOpens = 0;
  let floatingOpens = 0;
  let terminalOpens = 0;
  let probesDisposed = 0;
  const scheduled = [];
  const vscode = {
    env: { language: 'zh-cn' },
    workspace: { getConfiguration: () => ({ get: () => null }) },
    window: { createTerminal: () => { terminalOpens++; return { show() {} }; } },
  };
  const provider = new MultiMonitorViewProvider({
    vscode, manager, configStore: { getCurrent: () => normalizeConfig({}) },
    workspaceState: { get: () => ({}), update: async () => {} }, localLinux: false,
    loadHosts: async () => ['good', 'bad'],
    createProbe: ({ host }) => ({ connect: async () => { if (host === 'bad') throw new Error('SSH exited (255)'); }, dispose() { probesDisposed++; } }),
    scheduleErrorClear: (callback, milliseconds) => { scheduled.push({ callback, milliseconds }); return scheduled.length; },
    cancelErrorClear() {},
  });
  await provider.refreshHosts();
  provider.openEditorPanel = async () => { editorOpens++; };
  provider.openFloatingPanel = async (state) => { floatingOpens++; assert.deepEqual(state.tabs, ['ssh:good']); };
  const messages = [];
  const source = { state: provider.sidebarState, sidebar: true, ready: true, target: { visible: true, webview: { postMessage: (message) => messages.push(message) } } };
  provider.sidebar = source;

  await provider.handleMessage({ version: 1, cmd: 'openServer', host: 'bad', inEditor: true }, source);
  assert.equal(editorOpens, 0);
  assert.deepEqual(source.state.tabs, []);
  assert.equal(devices.has('ssh:bad'), false);
  assert.match(provider.serverRows().find((row) => row.host === 'bad').error, /255/);
  assert.equal(messages.some((message) => message.cmd === 'servers' && message.hosts.some((row) => row.host === 'bad' && row.busy)), true);
  assert.equal(scheduled.at(-1).milliseconds, 10000);
  scheduled.at(-1).callback();
  assert.equal(provider.serverRows().find((row) => row.host === 'bad').state, 'idle');
  assert.equal(provider.serverRows().find((row) => row.host === 'bad').error, null);

  await provider.handleMessage({ version: 1, cmd: 'openTerminal', host: 'bad' }, source);
  assert.equal(terminalOpens, 0);
  assert.equal(probesDisposed, 1);

  await provider.handleMessage({ version: 1, cmd: 'openServer', host: 'good', inWindow: true }, source);
  assert.equal(floatingOpens, 1);
  await provider.handleMessage({ version: 1, cmd: 'openServer', host: 'good', inEditor: true }, source);
  assert.equal(editorOpens, 1);
  devices.delete('ssh:good');
  await provider.handleMessage({ version: 1, cmd: 'openTerminal', host: 'good' }, source);
  assert.equal(terminalOpens, 1);
  assert.equal(probesDisposed, 2);
  provider.dispose();
});

test('Remote-SSH menu exposes recent folders and opens a new remote window without collector SSH preflight', async () => {
  const commands = [];
  let historyUnavailable = false;
  let remoteCommandUnavailable = false;
  const vscode = {
    env: { language: 'zh-cn' },
    Uri: { from: (parts) => parts },
    workspace: { getConfiguration: () => ({ get: () => null }) },
    commands: { async executeCommand(...args) {
      commands.push(args);
      if (args[0] === 'remote-internal.getSshFoldersHistory') {
        if (historyUnavailable) throw new Error('command not found');
        return [
        { remote: 'alice@campus', folder: '/home/alice' },
        { remote: 'alice@campus', folder: '/home/alice' },
        { remote: 'alice@campus', folder: 'relative' },
        { remote: 'alice@campus', folder: '/workspace' },
        ];
      }
      if (args[0] === 'opensshremotes.openEmptyWindow' && remoteCommandUnavailable) throw new Error('command opensshremotes.openEmptyWindow not found');
      return true;
    } },
  };
  let probes = 0;
  const provider = new MultiMonitorViewProvider({
    vscode,
    manager: { sync() {}, setConfigFile() {}, get() { return null; } },
    configStore: { getCurrent: () => normalizeConfig({}) },
    workspaceState: { get: () => ({}), update: async () => {} },
    localLinux: false, loadHosts: async () => ['campus'],
    createProbe: () => { probes++; throw new Error('collector SSH should not run'); },
  });
  await provider.refreshHosts();
  const messages = [];
  const source = { state: provider.sidebarState, ready: true, target: { webview: { postMessage: (message) => messages.push(message) } } };
  provider.sidebar = source;
  await provider.handleMessage({ version: 1, cmd: 'listRemoteFolders', host: 'campus' }, source);
  assert.deepEqual(messages.at(-1), { cmd: 'remoteFolders', host: 'campus', folders: [{ index: 0, folder: '/home/alice' }, { index: 1, folder: '/workspace' }] });
  await provider.handleMessage({ version: 1, cmd: 'openRemoteWindow', host: 'campus', folderIndex: 0 }, source);
  assert.deepEqual(commands.find(([name]) => name === 'vscode.openFolder'), [
    'vscode.openFolder', { scheme: 'vscode-remote', authority: 'ssh-remote+alice@campus', path: '/home/alice' }, { forceNewWindow: true },
  ]);
  await provider.handleMessage({ version: 1, cmd: 'openRemoteWindow', host: 'campus' }, source);
  assert.deepEqual(commands.find(([name]) => name === 'opensshremotes.openEmptyWindow'), ['opensshremotes.openEmptyWindow', { host: 'campus' }]);
  const before = commands.length;
  await provider.handleMessage({ version: 1, cmd: 'openRemoteWindow', host: 'campus', folderIndex: 99 }, source);
  assert.equal(commands.length, before);
  historyUnavailable = true;
  await provider.handleMessage({ version: 1, cmd: 'listRemoteFolders', host: 'campus' }, source);
  assert.deepEqual(messages.at(-1), { cmd: 'remoteFolders', host: 'campus', folders: [] });
  remoteCommandUnavailable = true;
  await provider.handleMessage({ version: 1, cmd: 'openRemoteWindow', host: 'campus' }, source);
  assert.deepEqual(commands.at(-1), ['vscode.newWindow', { remoteAuthority: 'ssh-remote+campus', reuseWindow: false }]);
  assert.equal(probes, 0);
  provider.dispose();
});
