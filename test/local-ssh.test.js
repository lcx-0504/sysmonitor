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
const { normalizeNavigation, normalizeEditorNavigation } = require('../src/view/multi-monitor-view-provider');
const { MultiMonitorViewProvider } = require('../src/view/multi-monitor-view-provider');
const { normalizeConfig } = require('../src/config/normalize-config');
const { getWebviewHtml } = require('../src/view/webview-html');
const { MonitorService } = require('../src/services/monitor-service');
const { DeviceMonitorManager, updateDeviceConnection, canRecordDeviceSample } = require('../src/services/device-monitor-manager');
const { ServerDirectory } = require('../src/view/server-directory');

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

test('manual SSH retry bypasses the cooldown and reconnects immediately', async () => {
  const transport = new SshTransport({
    host: 'fixture', requireLinux: false,
    spawnProcess: () => spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  try {
    transport.retryAfter = Date.now() + 10000;
    transport.lastError = new Error('previous timeout');
    await assert.rejects(transport.connect(), /previous timeout/);
    await transport.retryNow();
    assert.ok(transport.child);
    assert.equal(transport.retryAfter, 0);
    assert.equal(transport.lastError, null);
  } finally { transport.dispose(); }
});

test('active SSH transport retries at cooldown expiry without a view timer', async () => {
  let attempts = 0;
  let connected = 0;
  let reconnectResolved;
  const reconnected = new Promise((resolve) => { reconnectResolved = resolve; });
  const transport = new SshTransport({
    host: 'fixture', requireLinux: false, retryDelayMilliseconds: 20,
    spawnProcess: () => { attempts++; return spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }); },
    onState: (state) => { if (state === 'connected' && ++connected === 2) reconnectResolved(); },
  });
  try {
    await transport.connect();
    transport.disconnect(new Error('temporary timeout'));
    let timeout;
    try {
      await Promise.race([reconnected, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('automatic retry did not start')), 1000); })]);
    } finally { clearTimeout(timeout); }
    assert.equal(attempts, 2);
  } finally { transport.dispose(); }
});

test('paused SSH transport does not automatically reconnect at cooldown expiry', async () => {
  let attempts = 0;
  const transport = new SshTransport({
    host: 'fixture', requireLinux: false, retryDelayMilliseconds: 20,
    shouldReconnect: () => false,
    spawnProcess: () => { attempts++; return spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }); },
  });
  try {
    await transport.connect();
    transport.disconnect(new Error('temporary timeout'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(attempts, 1);
  } finally { transport.dispose(); }
});

test('navigation restore preserves selected device and page, with a fixed local Linux tab', () => {
  assert.deepEqual(normalizeNavigation({ tabs: ['ssh:campus', 'ssh:campus', 'ssh:lab007'], selected: 'ssh:lab007', page: 'proc' }, true), {
    tabs: ['local', 'ssh:campus', 'ssh:lab007'], selected: 'ssh:lab007', page: 'proc', processDisplay: { cpu: 'core', ram: 'size' },
  });
  assert.deepEqual(normalizeNavigation({}, false), { tabs: [], selected: null, page: 'servers', processDisplay: { cpu: 'core', ram: 'size' } });
  assert.deepEqual(normalizeNavigation({ tabs: ['ssh:campus', 'local', 'ssh:lab007'], selected: 'local', page: 'perf' }, true).tabs, ['ssh:campus', 'local', 'ssh:lab007']);
});

test('disconnected SSH history freezes and resumes after a fresh complete sample', () => {
  const snapshot = Object.fromEntries(['cpu', 'memory', 'diskIo', 'diskTopology', 'accelerators'].map((key) => [key, { status: 'fresh', collectedAt: 199 }]));
  const device = { state: 'connected', error: null, history: [{ t: 90 }], resumeHistoryAfter: null };
  assert.equal(canRecordDeviceSample(device, snapshot, true), true);
  updateDeviceConnection(device, 'disconnected', new Error('SSH timed out'), 100);
  assert.equal(device.error, 'SSH timed out');
  assert.equal(canRecordDeviceSample(device, snapshot, true), false);
  updateDeviceConnection(device, 'connecting', null, 150);
  updateDeviceConnection(device, 'connected', null, 200);
  assert.equal(canRecordDeviceSample(device, snapshot, true), false);
  for (const part of Object.values(snapshot)) part.collectedAt = 201;
  assert.equal(canRecordDeviceSample(device, snapshot, true), true);
  assert.equal(device.resumeHistoryAfter, null);
  assert.equal(canRecordDeviceSample(device, snapshot, false), true);
});

test('a paused one-shot snapshot updates the model without appending chart history', () => {
  const config = normalizeConfig({});
  const manager = new DeviceMonitorManager({ configStore: { getCurrent: () => config }, language: 'en', localLinux: false });
  manager.paused = true;
  try {
    const device = manager.open('ssh:fixture');
    device.state = 'connected';
    device.service.onTick(device.service.readSnapshot());
    assert.ok(device.model);
    assert.equal(typeof device.modelAt, 'number');
    assert.deepEqual(device.history, []);
  } finally { manager.dispose(); }
});

test('paused one-shot metrics reach the view without adding a trend point', () => {
  const id = 'ssh:fixture';
  const device = {
    id, host: 'fixture', state: 'connected', error: null, model: { performance: {} }, modelAt: 500,
    history: [{ t: 100 }], service: { readSnapshot: () => ({}) }, transport: { retryAfter: 0 },
  };
  const provider = new MultiMonitorViewProvider({
    vscode: { workspace: { getConfiguration: () => ({ get: () => null }) } },
    manager: { paused: true, get: () => device, sync() {}, setConfigFile() {} },
    configStore: { getCurrent: () => normalizeConfig({}) },
    workspaceState: { get: () => ({ tabs: [id], selected: id, page: 'perf' }) },
    localLinux: false, loadHosts: async () => [],
  });
  const messages = [];
  provider.sidebar = { ready: true, state: provider.sidebarState, lastSnapshotAt: 100, target: { visible: true, webview: { postMessage: (message) => messages.push(message) } } };
  provider.onDeviceUpdate(id, device);
  assert.deepEqual(messages.find((message) => message.cmd === 'snapshot'), {
    cmd: 'snapshot', deviceId: id, viewModel: device.model, sampleTime: 500, skipHistory: true,
  });
  assert.deepEqual(device.history, [{ t: 100 }]);
  provider.dispose();
});

test('Editor navigation keeps one device and only performance or process pages', () => {
  assert.deepEqual(normalizeEditorNavigation({ tabs: ['ssh:campus', 'ssh:lab007'], selected: 'ssh:lab007', page: 'servers' }, false), {
    tabs: ['ssh:lab007'], selected: 'ssh:lab007', page: 'perf', processDisplay: { cpu: 'core', ram: 'size' },
  });
  assert.deepEqual(normalizeEditorNavigation({ tabs: ['local', 'ssh:campus'], selected: 'local', page: 'proc' }, true).tabs, ['local']);
  assert.equal(normalizeEditorNavigation({}, false), null);
});

test('sidebar pop-out moves an SSH tab but copies the fixed local device', async () => {
  async function makeProvider(localLinux, saved) {
    const syncs = [];
    const contexts = [];
    const provider = new MultiMonitorViewProvider({
      vscode: { env: { language: 'zh-cn' }, commands: { executeCommand: (...args) => contexts.push(args) }, workspace: { getConfiguration: () => ({ get: () => null }) } },
      manager: { paused: false, get() { return null; }, sync(open) { syncs.push([...open]); }, setConfigFile() {} },
      configStore: { getCurrent: () => normalizeConfig({}) },
      workspaceState: { get: () => saved, update: async () => {} },
      localLinux, loadHosts: async () => [],
    });
    await provider.refreshHosts();
    const messages = [];
    provider.sidebar = { state: provider.sidebarState, sidebar: true, ready: true, target: { visible: true, webview: { postMessage: (message) => messages.push(message) } } };
    const opened = [];
    provider.openEditorPanel = async (state) => {
      opened.push(state);
      const panel = {};
      provider.editors.set(panel, { state, ready: false, sidebar: false, target: { visible: true } });
      return panel;
    };
    return { provider, syncs, contexts, messages, opened };
  }

  const remote = await makeProvider(false, { tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'proc' });
  await remote.provider.moveSidebarDeviceToEditor();
  assert.deepEqual(remote.opened[0].tabs, ['ssh:campus']);
  assert.equal(remote.opened[0].page, 'proc');
  assert.deepEqual(remote.provider.sidebarState.tabs, []);
  assert.equal(remote.provider.sidebarState.page, 'servers');
  assert.deepEqual(remote.syncs.at(-1), ['ssh:campus']);
  assert.deepEqual(remote.contexts.slice(-3), [
    ['setContext', 'sysmonitor.sidebarDeviceActive', false],
    ['setContext', 'sysmonitor.sidebarSshActive', false],
    ['setContext', 'sysmonitor.sidebarFixedActive', false],
  ]);
  remote.provider.dispose();

  const local = await makeProvider(true, { tabs: ['local'], selected: 'local', page: 'perf' });
  await local.provider.moveSidebarDeviceToEditor();
  assert.deepEqual(local.opened[0].tabs, ['local']);
  assert.deepEqual(local.provider.sidebarState.tabs, ['local']);
  local.provider.dispose();

  const failed = await makeProvider(false, { tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'perf' });
  failed.provider.openFloatingPanel = async () => { throw new Error('window move failed'); };
  await assert.rejects(failed.provider.moveSidebarDeviceToEditor(true), /window move failed/);
  assert.deepEqual(failed.provider.sidebarState.tabs, ['ssh:campus']);
  failed.provider.dispose();

  const listPage = await makeProvider(false, { tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'servers' });
  await listPage.provider.moveSidebarDeviceToEditor();
  assert.equal(listPage.opened.length, 0);
  assert.deepEqual(listPage.contexts.filter(([, key]) => key.startsWith('sysmonitor.sidebar')).slice(0, 3), [
    ['setContext', 'sysmonitor.sidebarDeviceActive', false],
    ['setContext', 'sysmonitor.sidebarSshActive', false],
    ['setContext', 'sysmonitor.sidebarFixedActive', false],
  ]);
  listPage.provider.dispose();
});

test('server-list Editor actions create duplicate views without moving sidebar tabs', async () => {
  const provider = new MultiMonitorViewProvider({
    vscode: { env: { language: 'zh-cn' }, workspace: { getConfiguration: () => ({ get: () => null }) } },
    manager: { paused: false, get() { return null; }, sync() {}, setConfigFile() {} },
    configStore: { getCurrent: () => normalizeConfig({}) },
    workspaceState: { get: () => ({ tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'servers' }), update: async () => {} },
    localLinux: false, loadHosts: async () => ['campus'],
  });
  await provider.refreshHosts();
  provider.serverDirectory.runAction = async (_host, _kind, action) => action();
  const source = { state: provider.sidebarState, sidebar: true, ready: true, target: { visible: true, webview: { postMessage() {} } } };
  provider.sidebar = source;
  const opened = [];
  provider.openEditorPanel = async (state) => { opened.push(state); return {}; };
  await provider.handleMessage({ version: 1, cmd: 'openServer', host: 'campus', inEditor: true }, source);
  await provider.handleMessage({ version: 1, cmd: 'openServer', host: 'campus', inEditor: true }, source);
  assert.equal(opened.length, 2);
  assert.deepEqual(provider.sidebarState.tabs, ['ssh:campus']);
  assert.equal(provider.sidebarState.page, 'servers');
  provider.dispose();
});

test('manual retry samples once while globally paused and leaves pause enabled', async () => {
  const calls = [];
  const id = 'ssh:campus';
  const device = {
    state: 'disconnected',
    transport: { async retryNow() { calls.push('retry'); device.state = 'connected'; } },
    service: { readSnapshot: () => ({}), resume(options) { calls.push(['resume', options]); }, pause() { calls.push('pause'); } },
  };
  const manager = { paused: true, get: () => device, sync() {}, setConfigFile() {} };
  const provider = new MultiMonitorViewProvider({
    vscode: { workspace: { getConfiguration: () => ({ get: () => null }) } },
    manager, configStore: { getCurrent: () => normalizeConfig({}) },
    workspaceState: { get: () => ({ tabs: [id], selected: id, page: 'perf' }) },
    localLinux: false, loadHosts: async () => ['campus'],
  });
  provider.serverDirectory.waitForInitialSample = async (host, since, options) => {
    calls.push(['sample', host, Number.isFinite(since), options]);
  };
  const messages = [];
  const source = { ready: true, state: provider.sidebarState, target: { webview: { postMessage: (message) => messages.push(message) } } };
  provider.sidebar = source;
  await provider.handleMessage({ version: 1, cmd: 'retryConnection', deviceId: id }, source);
  assert.deepEqual(calls, [
    'retry', ['resume', { force: true }], ['sample', 'campus', true, { allowPaused: true }], 'pause',
  ]);
  assert.equal(manager.paused, true);
  assert.deepEqual(messages.at(-1), { cmd: 'retryConnectionResult', deviceId: id });
  provider.dispose();
});

test('simultaneous retry clicks from two views share one SSH attempt and both finish', async () => {
  const id = 'ssh:campus';
  let attempts = 0;
  let complete;
  const device = {
    state: 'disconnected',
    transport: { retryNow() {
      attempts++;
      device.state = 'connecting';
      return new Promise((resolve) => { complete = resolve; });
    } },
  };
  const provider = new MultiMonitorViewProvider({
    vscode: { workspace: { getConfiguration: () => ({ get: () => null }) } },
    manager: { paused: false, get: () => device, sync() {}, setConfigFile() {} },
    configStore: { getCurrent: () => normalizeConfig({}) },
    workspaceState: { get: () => ({ tabs: [id], selected: id, page: 'perf' }) },
    localLinux: false, loadHosts: async () => [],
  });
  const firstMessages = [], secondMessages = [];
  const state = { selected: id, page: 'perf' };
  const first = { ready: true, state, target: { webview: { postMessage: (message) => firstMessages.push(message) } } };
  const second = { ready: true, state, target: { webview: { postMessage: (message) => secondMessages.push(message) } } };
  provider.sidebar = first;
  provider.editors.set(second.target, second);
  const firstRetry = provider.retryConnection(first, id);
  const secondRetry = provider.retryConnection(second, id);
  assert.equal(attempts, 1);
  complete();
  await Promise.all([firstRetry, secondRetry]);
  assert.equal(firstMessages.at(-1).cmd, 'retryConnectionResult');
  assert.equal(secondMessages.at(-1).cmd, 'retryConnectionResult');
  provider.dispose();
});

test('a failed paused one-shot retry still returns the device to pause', async () => {
  const id = 'ssh:campus';
  const calls = [];
  const device = {
    state: 'disconnected',
    transport: { async retryNow() { device.state = 'connected'; } },
    service: { readSnapshot: () => ({}), resume() { calls.push('resume'); }, pause() { calls.push('pause'); } },
  };
  const provider = new MultiMonitorViewProvider({
    vscode: { workspace: { getConfiguration: () => ({ get: () => null }) } },
    manager: { paused: true, get: () => device, sync() {}, setConfigFile() {} },
    configStore: { getCurrent: () => normalizeConfig({}) },
    workspaceState: { get: () => ({ tabs: [id], selected: id, page: 'perf' }) },
    localLinux: false, loadHosts: async () => [],
  });
  provider.serverDirectory.waitForInitialSample = async () => { throw new Error('sample timed out'); };
  const messages = [];
  const source = { ready: true, state: provider.sidebarState, target: { webview: { postMessage: (message) => messages.push(message) } } };
  provider.sidebar = source;
  await provider.retryConnection(source, id);
  assert.deepEqual(calls, ['resume', 'pause']);
  assert.deepEqual(messages.at(-1), { cmd: 'retryConnectionResult', deviceId: id, error: 'sample timed out' });
  provider.dispose();
});

test('Editor title actions return the active device to the sidebar or move its window', async () => {
  const contexts = [];
  const commands = [];
  let failMove = false;
  const vscode = {
    env: { language: 'zh-cn' }, ViewColumn: { Active: 1 },
    workspace: { getConfiguration: () => ({ get: () => null }) },
    commands: { async executeCommand(...args) {
      if (args[0] === 'setContext') contexts.push(args);
      else {
        commands.push(args);
        if (failMove) throw new Error('move failed');
      }
    } },
  };
  const provider = new MultiMonitorViewProvider({
    vscode, manager: { paused: false, get() { return null; }, sync() {}, setConfigFile() {} },
    configStore: { getCurrent: () => normalizeConfig({}) },
    workspaceState: { get: () => ({}), update: async () => {} },
    localLinux: true, loadHosts: async () => [],
  });
  const sshPanel = { active: true, reveal() { commands.push(['reveal']); }, dispose() { commands.push(['dispose']); } };
  const localPanel = { active: false, dispose() { commands.push(['dispose-local']); } };
  const sshState = { tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'proc', processDisplay: { cpu: 'whole', ram: 'size' } };
  const localState = { tabs: ['local'], selected: 'local', page: 'perf', processDisplay: { cpu: 'core', ram: 'size' } };
  provider.editors.set(sshPanel, { target: sshPanel, state: sshState, ready: false, sidebar: false });
  provider.editors.set(localPanel, { target: localPanel, state: localState, ready: false, sidebar: false });
  provider.sidebar = { state: provider.sidebarState, sidebar: true, ready: true, target: { visible: true, show() { commands.push(['show-sidebar']); }, webview: { postMessage() {} } } };
  provider.openTerminal = async (host) => commands.push(['terminal', host]);
  provider.openRemoteWindowPicker = async (host) => commands.push(['remote', host]);
  provider.updateEditorTitleActions();
  assert.deepEqual(contexts.at(-1), ['setContext', 'sysmonitor.editorSshActive', true]);
  sshPanel.active = false;
  const contextCount = contexts.length;
  provider.updateEditorTitleActions();
  assert.equal(contexts.length, contextCount);
  await provider.moveActiveEditorToNewWindow();
  sshPanel.active = true;
  await provider.openTerminalForEditor();
  await provider.openRemoteWindowForEditor();
  assert.deepEqual(commands.slice(-5), [['reveal'], ['workbench.action.moveEditorToNewWindow'], ['reveal'], ['terminal', 'campus'], ['remote', 'campus']]);
  failMove = true;
  await assert.rejects(provider.moveActiveEditorToNewWindow(), /move failed/);
  assert.equal(commands.some(([command]) => command === 'dispose'), false);
  failMove = false;
  await provider.returnActiveEditorToSidebar();
  assert.deepEqual(provider.sidebarState.tabs, ['local', 'ssh:campus']);
  assert.equal(provider.sidebarState.selected, 'ssh:campus');
  assert.equal(provider.sidebarState.page, 'proc');
  assert.deepEqual(commands.slice(-2), [['show-sidebar'], ['dispose']]);
  sshPanel.active = false;
  localPanel.active = true;
  provider.updateEditorTitleActions();
  assert.deepEqual(contexts.at(-1), ['setContext', 'sysmonitor.editorSshActive', false]);
  await provider.openTerminalForEditor();
  await provider.openRemoteWindowForEditor();
  await provider.returnActiveEditorToSidebar();
  assert.deepEqual(provider.sidebarState.tabs, ['local', 'ssh:campus']);
  assert.equal(provider.sidebarState.selected, 'local');
  assert.equal(commands.filter(([command]) => command === 'terminal').length, 1);
  assert.equal(commands.filter(([command]) => command === 'remote').length, 1);
  sshPanel.active = true;
  localPanel.active = false;
  provider.updateEditorTitleActions();
  provider.editors.clear();
  provider.updateEditorTitleActions();
  assert.deepEqual(contexts.at(-1), ['setContext', 'sysmonitor.editorSshActive', false]);
  provider.dispose();
});

test('server settings restore by default and normalize invalid values', () => {
  const actions = { editor: true, window: true, terminal: true, remoteWindow: true };
  assert.deepEqual(normalizeConfig({}).servers, { visibleOnly: false, restoreTabs: true, actions });
  assert.deepEqual(normalizeConfig({ servers: { visibleOnly: true, restoreTabs: false } }).servers, { visibleOnly: true, restoreTabs: false, actions });
  assert.deepEqual(normalizeConfig({ servers: { visibleOnly: 'yes', restoreTabs: null, actions: { editor: false, window: 'no' } } }).servers, {
    visibleOnly: false, restoreTabs: true, actions: { ...actions, editor: false },
  });
});

test('changing action switches updates local native titles and all webviews immediately', async () => {
  const contexts = [];
  const messages = [];
  let current = normalizeConfig({});
  const provider = new MultiMonitorViewProvider({
    vscode: {
      env: { language: 'zh-cn' },
      commands: { executeCommand: (...args) => contexts.push(args) },
      workspace: { getConfiguration: () => ({ get: () => null }) },
    },
    manager: { paused: false, get() { return null; }, sync() {}, setConfigFile() {}, updateConfig() {} },
    configStore: {
      getCurrent: () => current,
      update(key, value) { current = normalizeConfig({ ...current, [key]: value }); },
    },
    workspaceState: { get: () => ({}), update: async () => {} },
    localLinux: false, loadHosts: async () => [],
  });
  provider.sidebar = { state: provider.sidebarState, ready: true, sidebar: true, target: { visible: true, webview: { postMessage: (message) => messages.push(message) } } };
  contexts.length = 0;
  await provider.handleMessage({ version: 1, cmd: 'setConfig', key: 'servers', value: {
    visibleOnly: false, restoreTabs: true,
    actions: { editor: false, window: false, terminal: false, remoteWindow: false },
  } }, provider.sidebar);
  assert.deepEqual(contexts.filter(([command, key]) => command === 'setContext' && key.startsWith('sysmonitor.action')), [
    ['setContext', 'sysmonitor.actionEditorVisible', false],
    ['setContext', 'sysmonitor.actionWindowVisible', false],
    ['setContext', 'sysmonitor.actionTerminalVisible', false],
    ['setContext', 'sysmonitor.actionRemoteWindowVisible', false],
  ]);
  assert.equal(messages.some((message) => message.cmd === 'config' && message.serversCfg.actions.editor === false), true);
  provider.dispose();
});

test('monitor cards start empty while a newly selected SSH server is loading', () => {
  const assets = path.join(__dirname, '..', 'src', 'view', 'assets');
  const css = fs.readFileSync(path.join(assets, 'webview.css'), 'utf8');
  const startup = fs.readFileSync(path.join(assets, 'webview-processes.js'), 'utf8');
  assert.match(css, /\.fill\s*\{\s*width:\s*0;/);
  assert.match(startup, /applyGroupVisibility\(\);\s*document\.getElementById\('ssh-card'\)\.style\.display = 'none';/);
});

test('connection banner keeps a fixed secondary retry control and stops chart animation while disconnected', async () => {
  const html = await getWebviewHtml({ initConfig: {}, nonce: 'test' });
  const assets = path.join(__dirname, '..', 'src/view/assets');
  const css = fs.readFileSync(path.join(assets, 'webview.css'), 'utf8');
  const navigation = fs.readFileSync(path.join(assets, 'webview-navigation.js'), 'utf8');
  const webview = fs.readFileSync(path.join(assets, 'webview.js'), 'utf8');
  assert.match(html, /id="connection-banner-text"[^>]*><\/span><button type="button" class="connection-retry" id="connection-retry" hidden>/);
  assert.match(css, /\.connection-banner\.show \{ display: flex; \}/);
  assert.match(css, /#connection-retry \{[^}]*--vscode-button-secondaryBackground/);
  assert.match(navigation, /sendToExtension\(\{ cmd: 'retryConnection', deviceId: currentDeviceId \}\)/);
  assert.match(webview, /!paused && connectionAllowsAnimation && displayCfg/);
});

test('retry button counts down without changing size and keeps manual retry available while paused', () => {
  const navigation = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview-navigation.js'), 'utf8');
  const functionCode = navigation.slice(navigation.indexOf('  function retryButtonState('), navigation.indexOf('  function refreshConnectionRetryButton('));
  const context = {};
  vm.runInNewContext(`${functionCode}\nthis.retryButtonState = retryButtonState;`, context);
  assert.equal(context.retryButtonState('disconnected', false, false, 10000, 2000, true).text, '重试 (8)');
  assert.equal(context.retryButtonState('disconnected', false, true, 10000, 2000, true).text, '重试');
  assert.equal(context.retryButtonState('connecting', false, false, 10000, 2000, true).text, '连接中');
  assert.equal(context.retryButtonState('connecting', false, false, 10000, 2000, true).disabled, true);
  assert.equal(context.retryButtonState('disconnected', false, false, 10000, 2000, false).text, 'Retry (8)');
});

test('retry countdown reaches zero without making the view own the SSH reconnect', () => {
  const navigation = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview-navigation.js'), 'utf8');
  const code = navigation.slice(navigation.indexOf('  var connectionBanner ='), navigation.indexOf('  function storeNavigation('));
  const button = { hidden: true, disabled: false, textContent: '', addEventListener() {} };
  const sent = [];
  let now = 2000, timer = null;
  const context = {
    document: { getElementById: (id) => id === 'connection-retry' ? button : {} },
    currentDeviceId: 'ssh:lab', navigation: { page: 'perf' }, paused: false, zh: true,
    Date: { now: () => now },
    setTimeout: (callback, delay) => { timer = { callback, delay }; return 1; },
    clearTimeout() {},
    sendToExtension: (message) => sent.push(message),
  };
  vm.runInNewContext(`${code}\nthis.refresh = refreshConnectionRetryButton;`, context);
  context.connectionState = 'disconnected';
  context.connectionRetryAfter = 10000;
  context.refresh();
  assert.equal(button.textContent, '重试 (8)');
  assert.equal(timer.delay, 1000);
  now = 10000;
  timer.callback();
  assert.equal(button.textContent, '重试');
  assert.equal(button.disabled, false);
  assert.equal(sent.length, 0);
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
  assert.match(sidebarHtml, /id="sett-actions-body"/);
  assert.match(sidebarHtml, /id="server-intro-close">我知道了<\/button><button type="button" class="tb on" id="server-intro-ssh-default">加入默认扩展<\/button>/);
  assert.match(sidebarHtml, /id="sett-servers-body"><\/div>\s*<div class="sett-hint ssh-default-error" id="ssh-default-error" hidden><\/div>/);
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

test('joining default extensions from the first-use guide dismisses it only after success', async () => {
  const updates = [];
  const entries = [];
  const provider = new MultiMonitorViewProvider({
    vscode: { env: { language: 'zh-cn' }, workspace: { getConfiguration: () => ({
      get: () => entries,
      update: async (_key, value) => { entries.push(...value); },
    }) } },
    manager: { sync() {}, setConfigFile() {}, get() { return null; } },
    configStore: { getCurrent: () => normalizeConfig({}) },
    workspaceState: { get: () => ({}) },
    uiStateStore: { get: () => updates.length > 0, update: async (...args) => updates.push(args) },
    localLinux: false, loadHosts: async () => [],
  });
  const messages = [];
  const source = { state: provider.sidebarState, ready: true, target: { webview: { postMessage: (message) => messages.push(message) } } };
  provider.sidebar = source;
  await provider.handleMessage({ version: 1, cmd: 'addSshDefaultExtension', dismissIntro: true }, source);
  assert.deepEqual(updates, [['sysmonitor.localIntroDismissed', true]]);
  assert.equal(messages.some((message) => message.cmd === 'localIntroDismissed'), true);
  assert.equal(messages.some((message) => message.cmd === 'sshDefaultExtensions' && message.installed), true);
  const initial = JSON.parse(Buffer.from((await provider.buildHtml(provider.sidebarState, { sidebar: true })).match(/data-config="([A-Za-z0-9+/=]+)"/)[1], 'base64').toString('utf8'));
  assert.equal(initial.showLocalIntro, false);
});

test('SSH default-install errors are returned to the inline controls without changing settings', async () => {
  const configuration = { get: () => [], update: async () => { throw new Error('settings write denied'); } };
  const updates = [];
  const provider = new MultiMonitorViewProvider({
    vscode: { workspace: { getConfiguration: () => configuration } },
    manager: { sync() {}, setConfigFile() {}, get() { return null; } },
    configStore: { getCurrent: () => normalizeConfig({}) },
    workspaceState: { get: () => ({}) },
    uiStateStore: { get: () => false, update: async (...args) => updates.push(args) },
    localLinux: false, loadHosts: async () => [],
  });
  const messages = [];
  const source = { state: provider.sidebarState, ready: true, target: { webview: { postMessage: (message) => messages.push(message) } } };
  provider.sidebar = source;
  await provider.handleMessage({ version: 1, cmd: 'addSshDefaultExtension', dismissIntro: true }, source);
  assert.deepEqual(messages.at(-1), { cmd: 'sshDefaultExtensions', installed: false, error: 'settings write denied' });
  assert.deepEqual(updates, []);
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
  assert.match(style, /\.server-intro-actions small\s*\{[^}]*flex:\s*0 0 100%;/);
  assert.match(navigation, /slot\.tab\.style\.transform = shift \? 'translateX\('/);
  assert.match(navigation, /var shouldReorder = drag\.active && drag\.targetIndex !== drag\.originIndex/);
  assert.doesNotMatch(navigation, /pointerInsideStrip/);
  assert.match(navigation, /vscode\.setState\(Object\.assign\(\{\}, vscode\.getState\(\) \|\| \{\}, \{ navigation: navigation \}\)\)/);
  assert.match(processes, /vscode\.setState\(Object\.assign\(\{\}, vscode\.getState\(\) \|\| \{\}, \{ hintDismissed: true \}\)\)/);
  assert.match(style, /\.gpu-info-popover\.sett-info-popover\s*\{\s*z-index:\s*260;/);
  assert.match(style, /body\[data-surface="editor"\]\s*\{\s*--card-bg:\s*var\(--vscode-editor-background/);
});

test('settings switches finish their transition before a config echo redraws the panel', () => {
  const assets = path.join(__dirname, '..', 'src/view/assets');
  const settings = fs.readFileSync(path.join(assets, 'webview-settings.js'), 'utf8');
  const webview = fs.readFileSync(path.join(assets, 'webview.js'), 'utf8');
  assert.match(settings, /settingsTransitionUntil = Date\.now\(\) \+ 190/);
  assert.match(settings, /if \(rerender\) renderSettingsAfterTransition\(\)/);
  assert.match(webview, /if \(modalOpen && !settingMenu\) renderSettingsAfterTransition\(\)/);
  assert.match(settings, /未显示的服务器会暂停采样，图表趋势可能中断，切换回来时加载会更慢/);
  assert.match(settings, /button\.classList\.toggle\('on', !sshDefaultInstalled\)/);
});

test('page navigation precedes flat device tabs and server actions use Codicons', async () => {
  const html = await getWebviewHtml({ initConfig: {}, nonce: 'test' });
  const assets = path.join(__dirname, '..', 'src', 'view', 'assets');
  const css = fs.readFileSync(path.join(assets, 'webview.css'), 'utf8');
  const navigation = fs.readFileSync(path.join(assets, 'webview-navigation.js'), 'utf8');
  const servers = fs.readFileSync(path.join(assets, 'webview-servers.js'), 'utf8');
  assert.ok(html.indexOf('class="topbar"') < html.indexOf('id="device-strip"'));
  assert.match(css, /\.device-tab\s*\{[^}]*border:\s*0;/);
  assert.match(css, /\.device-tab\s*\{[^}]*height:\s*25px;/);
  assert.match(css, /\.device-tab\s*\{[^}]*flex:\s*1 0 100px;\s*min-width:\s*100px;/);
  assert.match(css, /\*\s*\{[^}]*box-sizing:\s*border-box;/);
  assert.match(css, /\.device-tab\.active::after\s*\{[^}]*bottom:\s*0;[^}]*background:\s*var\(--accent\);/);
  assert.match(css, /\.device-tab-close\s*\{[^}]*cursor:\s*pointer;/);
  assert.match(css, /\.device-tab-close:hover\s*\{[^}]*background:/);
  assert.match(servers, /serverIcons = \{[\s\S]*editor: '<svg[\s\S]*window: '<svg[\s\S]*remote: '<svg[\s\S]*terminal: '<svg/);
  assert.match(servers, /editor: '<svg viewBox="0 0 16 16"[^']*M15 3\.5/);
  assert.match(servers, /window: '<svg viewBox="0 0 300 300"[^']*M281 225/);
  assert.match(servers, /remote: '<svg viewBox="0 0 300 300"[^']*M124 38/);
  assert.match(servers, /row\.querySelector\('\.server-open'\)\.disabled = !!server\.busy/);
  assert.match(servers, /row\.querySelector\('\.server-editor'\)\.hidden = actionsVisible\.editor === false/);
  assert.match(servers, /row\.querySelector\('\.server-window'\)\.hidden = actionsVisible\.window === false/);
  assert.match(servers, /row\.querySelector\('\.server-terminal'\)\.hidden = actionsVisible\.terminal === false/);
  assert.match(servers, /row\.querySelector\('\.server-remote'\)\.hidden = actionsVisible\.remoteWindow === false/);
  assert.match(servers, /server\.state === 'loading' \? \(zh \? '资源加载中…' : 'Loading resources…'\)/);
  assert.doesNotMatch(servers, /editor\.textContent = '↗'|terminal\.textContent = '>_'/);
  assert.match(navigation, /deviceStrip\.hidden = editorMode \|\| !hasTabs \|\| navigation\.page === 'servers'/);
  assert.match(navigation, /serverTabButton\.hidden = editorMode/);
  assert.match(navigation, /document\.getElementById\('updated'\)\.hidden = serverPageActive/);
  assert.match(navigation, /if \(tabsChanged \|\| deviceStrip\.childElementCount !== state\.tabs\.length\) renderDeviceTabs\(\);\s*else updateDeviceTabsPresentation\(\)/);
  const webview = fs.readFileSync(path.join(assets, 'webview.js'), 'utf8');
  assert.match(webview, /requestedPage = name;[\s\S]*?updateDeviceTabsPresentation\(\);[\s\S]*?sendToExtension\(\{cmd:'switchPage',page:name\}\)/);
  assert.match(navigation, /topbar\.hidden = false/);
  assert.match(navigation, /document\.getElementById\('tab-perf-btn'\)\.hidden = !hasTabs/);
  assert.match(navigation, /document\.getElementById\('topbar-server-refresh'\)\.hidden = editorMode \|\| !serverPageActive/);
  assert.match(servers, /open\.textContent = zh \? '打开' : 'Open'/);
  assert.match(servers, /open\.className = 'tb server-open'/);
  assert.match(servers, /editor\.className = 'server-action server-editor'/);
  assert.match(servers, /floating\.className = 'server-action server-window'/);
  assert.match(servers, /sendToExtension\(\{ cmd: 'openServer', host: server\.host, inWindow: true \}\)/);
  assert.match(servers, /remote\.className = 'server-action server-remote'/);
  assert.match(servers, /actions\.appendChild\(open\); actions\.appendChild\(editor\); actions\.appendChild\(floating\); actions\.appendChild\(terminal\); actions\.appendChild\(remote\)/);
  assert.match(servers, /connect\.textContent = zh \? '连接主机' : 'Connect to host'/);
  assert.doesNotMatch(servers, /最近打开的文件夹|暂无记录/);
  assert.match(servers, /if \(folders\.length\) \{\s*var divider = document\.createElement\('div'\)/);
  assert.match(servers, /sendToExtension\(\{ cmd: 'listRemoteFolders', host: host \}\)/);
  assert.doesNotMatch(servers, /renderRemoteMenu\(\[\]\)/);
  assert.match(navigation, /data\.cmd === 'remoteFolders' && remoteMenuHost === data\.host\) showRemoteMenu\(data\.folders \|\| \[\]\)/);
  assert.match(servers, /terminal\.className = 'server-action server-terminal'/);
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

test('native Editor tab uses the selected SSH alias', async () => {
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
  assert.equal(createdTitle, 'lichenxi_lab007_vps');
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
  calls.length = 0;
  await provider.openFloatingPanel({ tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'proc' });
  assert.deepEqual(calls, [['openEditor', 'ssh:campus'], ['reveal', undefined], ['command', 'workbench.action.moveEditorToNewWindow'], ['reveal', undefined]]);
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
  assert.match(script, /updAt:'更新'/);
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
  assert.equal(panel.title, 'lab007');
  assert.equal(path.basename(panel.iconPath.light), 'icon-tab-light.svg');
  assert.equal(path.basename(panel.iconPath.dark), 'icon-tab-dark.svg');
  assert.deepEqual(syncs.at(-1).open.sort(), ['ssh:campus', 'ssh:lab007']);
  await provider.handleMessage({ version: 1, cmd: 'ready' }, provider.editors.get(panel));
  assert.equal(messages.some((message) => message.cmd === 'navigation' && message.state.selected === 'ssh:lab007'), true);
  await provider.handleMessage({ version: 1, cmd: 'switchPage', page: 'servers' }, provider.editors.get(panel));
  assert.equal(provider.editors.get(panel).state.page, 'perf');
  await provider.handleMessage({ version: 1, cmd: 'switchPage', page: 'proc' }, provider.editors.get(panel));
  assert.equal(provider.editors.get(panel).state.page, 'proc');
  assert.equal(provider.sidebarState.page, 'proc');
  panel.dispose();
  assert.deepEqual(syncs.at(-1).open, ['ssh:campus']);
});

test('monitor views wait for SSH while terminal opens without a preflight', async () => {
  const devices = new Map();
  const prepared = [];
  const readyAt = Date.now() + 60000;
  const manager = {
    paused: false, configFile: null,
    get(id) { return devices.get(id) || null; },
    open(id) {
      const device = {
        id, host: id.slice(4), state: 'connecting', error: null,
        model: { performance: { cpu: { usagePercent: 10 }, memory: { usagePercent: 20 }, gpus: [] } },
        history: [{ t: readyAt }],
        transport: { connect: async () => { if (id === 'ssh:bad') throw new Error('SSH exited (255)'); device.state = 'connected'; } },
        service: { scheduler: { isPaused: false }, readSnapshot: () => Object.fromEntries(['cpu', 'memory', 'diskIo', 'diskTopology', 'accelerators'].map((key) => [key, { status: 'fresh', collectedAt: readyAt, value: key === 'accelerators' ? { devices: [] } : null }])) },
      };
      devices.set(id, device);
      return device;
    },
    sync(open) { for (const id of devices.keys()) if (!open.has(id)) devices.delete(id); },
    setConfigFile() {},
    setPreparing(id, value) { prepared.push([id, value]); },
  };
  let editorOpens = 0;
  let floatingOpens = 0;
  let terminalOpens = 0;
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
  await provider.handleMessage({ version: 1, cmd: 'openTerminal', host: 'bad' }, source);
  assert.equal(terminalOpens, 1);
  assert.match(provider.serverRows().find((row) => row.host === 'bad').error, /255/);
  scheduled.at(-1).callback();
  assert.equal(provider.serverRows().find((row) => row.host === 'bad').state, 'idle');
  assert.equal(provider.serverRows().find((row) => row.host === 'bad').error, null);

  await provider.handleMessage({ version: 1, cmd: 'openServer', host: 'good', inWindow: true }, source);
  assert.equal(floatingOpens, 1);
  assert.deepEqual(prepared.slice(-2), [['ssh:good', true], ['ssh:good', false]]);
  await provider.handleMessage({ version: 1, cmd: 'openServer', host: 'good', inEditor: true }, source);
  assert.equal(editorOpens, 1);
  devices.delete('ssh:good');
  await provider.handleMessage({ version: 1, cmd: 'openTerminal', host: 'good' }, source);
  assert.equal(terminalOpens, 2);
  provider.dispose();
});

test('monitor opens only after CPU, memory, disk and GPU data reach the rendered snapshot', async () => {
  const readyAt = Date.now() + 60000;
  const snapshot = Object.fromEntries(['cpu', 'memory', 'diskIo', 'diskTopology', 'accelerators'].map((key) => [key, { status: 'loading', collectedAt: null }]));
  const prepared = [];
  const phases = [];
  const device = {
    id: 'ssh:lab', host: 'lab', state: 'connecting', model: null, history: [],
    transport: { async connect() { device.state = 'connected'; } },
    service: { readSnapshot: () => snapshot, scheduler: { isPaused: true } },
  };
  const manager = {
    paused: false, get: () => device, open: () => device,
    setPreparing: (id, enabled) => prepared.push([id, enabled]),
  };
  const directory = new ServerDirectory({ vscode: {}, manager, onChange: (rows) => phases.push(rows[0] && rows[0].state) });
  directory.hosts = ['lab'];
  let opened = false;
  const action = directory.runAction('lab', 'monitor', async () => { opened = true; });
  await new Promise(setImmediate);
  assert.equal(opened, false);
  assert.deepEqual(prepared, [['ssh:lab', true]]);
  assert.deepEqual(phases.slice(0, 2), ['connecting', 'loading']);
  for (const key of ['cpu', 'memory', 'diskIo', 'diskTopology']) snapshot[key] = { status: 'fresh', collectedAt: readyAt };
  device.model = { performance: { cpu: { usagePercent: 10 }, memory: { usagePercent: 20 }, gpus: [] } };
  device.history.push({ t: readyAt });
  directory.onDeviceUpdate(device.id, device);
  assert.equal(opened, false);
  snapshot.accelerators = { status: 'fresh', collectedAt: readyAt, value: { devices: [] } };
  directory.onDeviceUpdate(device.id, device);
  await action;
  assert.equal(opened, true);
  assert.deepEqual(prepared.at(-1), ['ssh:lab', false]);
  directory.dispose();
});

test('a retry and a new monitor view can wait for the same fresh sample', async () => {
  const now = Date.now();
  const snapshot = Object.fromEntries(['cpu', 'memory', 'diskIo', 'diskTopology', 'accelerators'].map((key) => [key, { status: 'loading', collectedAt: null }]));
  const device = {
    id: 'ssh:lab', host: 'lab', state: 'connected', model: { performance: {} }, history: [{ t: now }],
    service: { readSnapshot: () => snapshot },
  };
  const directory = new ServerDirectory({ vscode: {}, manager: { paused: false, get: () => device } });
  const retryWait = directory.waitForInitialSample('lab', now, { allowPaused: true });
  const viewWait = directory.waitForInitialSample('lab', now);
  for (const part of Object.values(snapshot)) { part.status = 'fresh'; part.collectedAt = now; }
  directory.onDeviceUpdate(device.id, device);
  await Promise.all([retryWait, viewWait]);
  assert.equal(directory.initialSampleWaiters.size, 0);
  directory.dispose();
});

test('paused one-shot retry settles from the rendered model without a new history point', async () => {
  const now = Date.now();
  const snapshot = Object.fromEntries(['cpu', 'memory', 'diskIo', 'diskTopology', 'accelerators'].map((key) => [key, { status: 'fresh', collectedAt: now }]));
  const device = {
    id: 'ssh:lab', host: 'lab', state: 'connected', model: { performance: {} }, modelAt: now - 1,
    history: [{ t: now - 10000 }], service: { readSnapshot: () => snapshot },
  };
  const directory = new ServerDirectory({ vscode: {}, manager: { paused: true, get: () => device } });
  const wait = directory.waitForInitialSample('lab', now, { allowPaused: true });
  assert.equal(directory.initialSampleWaiters.size, 1);
  device.modelAt = now;
  directory.onDeviceUpdate(device.id, device);
  await wait;
  assert.deepEqual(device.history, [{ t: now - 10000 }]);
  directory.dispose();
});

test('an already connected server opens from cached data without transient loading', async () => {
  const collectedAt = Date.now();
  const snapshot = Object.fromEntries(['cpu', 'memory', 'diskIo', 'diskTopology', 'accelerators'].map((key) => [key, { status: 'fresh', collectedAt }]));
  let reconnects = 0;
  let preparing = 0;
  let opens = 0;
  const device = {
    state: 'connected', model: { performance: { cpu: { usagePercent: 12 }, memory: { usagePercent: 25 }, gpus: [] } },
    history: [{ t: collectedAt }], transport: { async connect() { reconnects++; } },
    service: { scheduler: { isPaused: false }, readSnapshot: () => snapshot },
  };
  const phases = [];
  const directory = new ServerDirectory({
    vscode: {}, manager: { paused: false, get: () => device, setPreparing() { preparing++; } },
    onChange: (rows) => phases.push(rows[0].state),
  });
  directory.hosts = ['lab'];
  await directory.runAction('lab', 'monitor', async () => { opens++; });
  assert.equal(opens, 1);
  assert.equal(reconnects, 0);
  assert.equal(preparing, 0);
  assert.deepEqual(phases, []);
  assert.equal(directory.rows()[0].state, 'connected');
  directory.dispose();
});

test('a later collector update does not restart initial loading for an open server', async () => {
  const collectedAt = Date.now();
  const snapshot = Object.fromEntries(['cpu', 'memory', 'diskIo', 'diskTopology', 'accelerators'].map((key) => [key, { status: 'fresh', collectedAt }]));
  const device = {
    id: 'ssh:lab', host: 'lab', state: 'connected',
    model: { performance: { cpu: { usagePercent: 12 }, memory: { usagePercent: 25 }, gpus: [] } },
    history: [{ t: collectedAt }], transport: { async connect() { throw new Error('already connected'); } },
    service: { scheduler: { isPaused: false }, readSnapshot: () => snapshot },
  };
  const phases = [];
  const directory = new ServerDirectory({
    vscode: {}, manager: { paused: false, get: () => device, setPreparing() { throw new Error('should not prepare again'); } },
    onChange: (rows) => phases.push(rows[0].state),
  });
  directory.hosts = ['lab'];
  directory.onDeviceUpdate(device.id, device);
  phases.length = 0;
  snapshot.diskIo.collectedAt = collectedAt + 1;
  assert.equal(directory.initialSampleReady(device, 0), false);
  let opened = false;
  await directory.runAction('lab', 'monitor', async () => { opened = true; });
  assert.equal(opened, true);
  assert.deepEqual(phases, []);
  assert.equal(directory.rows()[0].state, 'connected');
  directory.dispose();
});

test('a real reconnect waits for a new complete sample', async () => {
  const oldTime = Date.now() - 10000;
  const snapshot = Object.fromEntries(['cpu', 'memory', 'diskIo', 'diskTopology', 'accelerators'].map((key) => [key, { status: 'fresh', collectedAt: oldTime }]));
  const device = {
    id: 'ssh:lab', host: 'lab', state: 'connected',
    model: { performance: { cpu: { usagePercent: 12 }, memory: { usagePercent: 25 }, gpus: [] } },
    history: [{ t: oldTime }], transport: { async connect() {} },
    service: { scheduler: { isPaused: false }, readSnapshot: () => snapshot },
  };
  const phases = [];
  const directory = new ServerDirectory({
    vscode: {}, manager: { paused: false, get: () => device, setPreparing() {} },
    onChange: (rows) => phases.push(rows[0].state),
  });
  directory.hosts = ['lab'];
  directory.onDeviceUpdate(device.id, device);
  device.state = 'disconnected';
  directory.onDeviceUpdate(device.id, device);
  device.state = 'connected';
  directory.onDeviceUpdate(device.id, device);
  phases.length = 0;
  let opened = false;
  const action = directory.runAction('lab', 'monitor', async () => { opened = true; });
  await new Promise(setImmediate);
  assert.equal(opened, false);
  assert.equal(phases[0], 'loading');
  const newTime = Date.now() + 10000;
  for (const part of Object.values(snapshot)) part.collectedAt = newTime;
  device.history.push({ t: newTime });
  directory.onDeviceUpdate(device.id, device);
  await action;
  assert.equal(opened, true);
  assert.equal(directory.rows()[0].state, 'connected');
  directory.dispose();
});

test('a connected server with incomplete data shows loading without reconnecting', async () => {
  const collectedAt = Date.now();
  const snapshot = Object.fromEntries(['cpu', 'memory', 'diskIo', 'diskTopology', 'accelerators'].map((key) => [key, { status: 'fresh', collectedAt }]));
  snapshot.accelerators.status = 'loading';
  let reconnects = 0;
  let opened = false;
  const device = {
    id: 'ssh:lab', host: 'lab', state: 'connected',
    model: { performance: { cpu: { usagePercent: 12 }, memory: { usagePercent: 25 }, gpus: [] } },
    history: [{ t: collectedAt }], transport: { async connect() { reconnects++; } },
    service: { scheduler: { isPaused: false }, readSnapshot: () => snapshot },
  };
  const phases = [];
  const directory = new ServerDirectory({
    vscode: {}, manager: { paused: false, get: () => device, setPreparing() {} },
    onChange: (rows) => phases.push(rows[0].state),
  });
  directory.hosts = ['lab'];
  const action = directory.runAction('lab', 'monitor', async () => { opened = true; });
  await new Promise(setImmediate);
  assert.equal(opened, false);
  assert.equal(reconnects, 0);
  assert.deepEqual(phases, ['loading']);
  snapshot.accelerators.status = 'fresh';
  directory.onDeviceUpdate(device.id, device);
  await action;
  assert.equal(opened, true);
  assert.equal(phases.includes('connecting'), false);
  assert.equal(directory.rows()[0].state, 'connected');
  directory.dispose();
});

test('terminal and Remote-SSH actions leave the monitor row unchanged', async () => {
  const phases = [];
  const directory = new ServerDirectory({
    vscode: {}, manager: { get: () => null, configFile: null },
    onChange: (rows) => phases.push(rows[0].state),
  });
  directory.hosts = ['lab'];
  let opened = 0;
  await directory.runAction('lab', 'terminal', async () => { opened++; });
  await directory.runAction('lab', 'remoteWindow', async () => { opened++; });
  assert.equal(opened, 2);
  assert.deepEqual(phases, []);
  assert.equal(directory.rows()[0].state, 'idle');
  assert.equal(directory.rows()[0].busy, false);
  directory.dispose();
});

test('shortcut actions preserve monitor errors and report their own launch failures', async () => {
  const errors = [];
  const phases = [];
  const directory = new ServerDirectory({
    vscode: { window: { showErrorMessage: (message) => errors.push(message) } },
    manager: { get: () => null },
    onChange: (rows) => phases.push(rows[0].state),
  });
  directory.hosts = ['lab'];
  directory.hostErrors.set('lab', { message: 'monitor connection failed' });
  await directory.runAction('lab', 'terminal', async () => {});
  await directory.runAction('lab', 'remoteWindow', async () => { throw new Error('window could not open'); });
  assert.deepEqual(phases, []);
  assert.deepEqual(errors, ['window could not open']);
  assert.equal(directory.rows()[0].error, 'monitor connection failed');
  directory.dispose();
});

test('terminal shortcut does not reconnect a disconnected monitor device', async () => {
  let monitorReconnects = 0;
  const device = {
    state: 'disconnected', error: 'monitor SSH closed', model: null,
    transport: { async connect() { monitorReconnects++; } },
    service: { readSnapshot: () => ({}) },
  };
  const phases = [];
  const directory = new ServerDirectory({
    vscode: {}, manager: { get: () => device, configFile: null },
    onChange: (rows) => phases.push(rows[0].state),
  });
  directory.hosts = ['lab'];
  await directory.runAction('lab', 'terminal', async () => {});
  assert.equal(monitorReconnects, 0);
  assert.equal(device.state, 'disconnected');
  assert.deepEqual(phases, []);
  assert.equal(directory.rows()[0].state, 'disconnected');
  directory.dispose();
});

test('a hidden server stays sampled while its first monitor view is being prepared', () => {
  const config = normalizeConfig({ servers: { visibleOnly: true } });
  const manager = new DeviceMonitorManager({ configStore: { getCurrent: () => config }, language: 'en', localLinux: false });
  const calls = [];
  const service = {
    scheduler: { isPaused: true },
    resume() { this.scheduler.isPaused = false; calls.push('resume'); },
    pause() { this.scheduler.isPaused = true; calls.push('pause'); },
    dispose() { calls.push('dispose'); },
  };
  manager.devices.set('ssh:lab', { service });
  manager.setPreparing('ssh:lab', true);
  manager.sync(new Set(), new Set());
  assert.equal(manager.get('ssh:lab') !== null, true);
  assert.deepEqual(calls, ['resume']);
  manager.setPreparing('ssh:lab', false);
  manager.sync(new Set(), new Set());
  assert.deepEqual(calls, ['resume', 'pause', 'dispose']);
});

test('disposing during initial sampling cancels the pending open', async () => {
  const device = {
    id: 'ssh:lab', host: 'lab', state: 'connecting', model: null, history: [],
    transport: { async connect() { device.state = 'connected'; } },
    service: { readSnapshot: () => ({}), scheduler: { isPaused: false } },
  };
  const prepared = [];
  const directory = new ServerDirectory({ vscode: {}, manager: {
    paused: false, get: () => device, open: () => device,
    setPreparing: (id, enabled) => prepared.push([id, enabled]),
  } });
  let opened = false;
  const action = directory.runAction('lab', 'monitor', async () => { opened = true; });
  await new Promise(setImmediate);
  directory.dispose();
  await action;
  assert.equal(opened, false);
  assert.equal(directory.hostErrors.size, 0);
  assert.deepEqual(prepared.at(-1), ['ssh:lab', false]);
});

test('Remote-SSH menu exposes recent folders and opens a new remote window without collector SSH preflight', async () => {
  const commands = [];
  let historyUnavailable = false;
  let remoteCommandUnavailable = false;
  const vscode = {
    env: { language: 'zh-cn' },
    Uri: { from: (parts) => parts },
    workspace: { getConfiguration: () => ({ get: () => null }) },
    window: { async showQuickPick(choices) {
      assert.deepEqual(choices.map((choice) => choice.label), ['连接主机', '/home/alice', '/workspace']);
      return choices[1];
    } },
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
  const provider = new MultiMonitorViewProvider({
    vscode,
    manager: { sync() {}, setConfigFile() {}, get() { return null; } },
    configStore: { getCurrent: () => normalizeConfig({}) },
    workspaceState: { get: () => ({}), update: async () => {} },
    localLinux: false, loadHosts: async () => ['campus'],
  });
  await provider.refreshHosts();
  const messages = [];
  const source = { state: provider.sidebarState, sidebar: true, ready: true, target: { webview: { postMessage: (message) => messages.push(message) } } };
  provider.sidebar = source;
  await provider.handleMessage({ version: 1, cmd: 'listRemoteFolders', host: 'campus' }, source);
  assert.deepEqual(messages.at(-1), { cmd: 'remoteFolders', host: 'campus', folders: [{ index: 0, folder: '/home/alice' }, { index: 1, folder: '/workspace' }] });
  provider.sidebarState = { tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'perf', processDisplay: { cpu: 'core', ram: 'size' } };
  await provider.openRemoteWindowForSidebar();
  assert.deepEqual(commands.filter(([name]) => name === 'vscode.openFolder').at(-1), [
    'vscode.openFolder', { scheme: 'vscode-remote', authority: 'ssh-remote+alice@campus', path: '/home/alice' }, { forceNewWindow: true },
  ]);
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
  provider.dispose();
});
