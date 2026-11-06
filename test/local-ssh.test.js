'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { normalizeNavigation, normalizeEditorNavigation, MultiMonitorViewProvider } = require('../src/view/multi-monitor-view-provider');
const { normalizeConfig } = require('../src/config/normalize-config');
const { DeviceMonitorManager } = require('../src/services/device-monitor-manager');
const { createSessionFixture } = require('./session-fixture');

async function sidebarHtml(provider) {
  const view = { visible: true, webview: { html: '', onDidReceiveMessage() {}, postMessage: async () => true }, onDidDispose() {} };
  await provider.resolveWebviewView(view);
  return view.webview.html;
}

test('residual-process warning copies PIDs and acknowledges without resuming monitoring', async () => {
  const choices = ['复制 PID', '我知道了'];
  const messages = [], copied = [], broadcasts = [];
  let acknowledged = 0;
  const provider = Object.create(MultiMonitorViewProvider.prototype);
  provider.manager = { paused: true, setPaused: () => assert.fail('notification must not resume monitoring') };
  provider.broadcast = (message) => broadcasts.push(message);
  provider.logger = () => {};
  provider.vscode = {
    env: { language: 'zh-cn', clipboard: { writeText: async (text) => copied.push(text) } },
    window: { showWarningMessage: async (message, ...buttons) => {
      messages.push(message);
      assert.deepEqual(buttons, ['复制 PID', '我知道了']);
      return choices.shift();
    } },
  };
  await provider.notifyResidualProcesses('campus', [1, 2, 3, 4, 5], () => acknowledged++);
  assert.equal(acknowledged, 1);
  assert.equal(provider.manager.paused, true);
  assert.deepEqual(copied, ['1, 2, 3, 4, 5']);
  assert.deepEqual(broadcasts, []);
  assert.equal(messages[0], '远程服务器性能采集多次超时，服务器「campus」有 5 个采集进程在超时或连接断开后仍未退出。监控已自动暂停，通常等待一段时间后这些采集进程会自动退出，但仍建议检查这些进程并按需清理。若服务器性能较低、频繁出现此类问题，建议增加刷新时间间隔（设置->刷新时间）。 PID：1, 2, 3, 4, 5');
});


test('residual threshold uses the existing global pause for every device', () => {
  const changes = [];
  const manager = new DeviceMonitorManager({ localLinux: false,
    configStore: { getSaveState: () => ({ status:'saved', error:null }), getCurrent: () => normalizeConfig({}) },
    onPauseChange: (paused) => changes.push(paused),
  });
  const paused = [];
  manager.devices.set('ssh:a', { running: true, pause: () => paused.push('a') });
  manager.devices.set('ssh:b', { running: true, pause: () => paused.push('b') });
  manager.setPaused(true);
  assert.deepEqual(paused, ['a', 'b']);
  assert.equal(manager.paused, true);
  assert.deepEqual(changes, [true]);
  manager.setPaused(true);
  assert.deepEqual(changes, [true]);
});


test('paused one-shot metrics reach the view without adding a trend point', () => {
  const id = 'ssh:fixture';
  const { session: device } = createSessionFixture({ id, paused: true });
  Object.assign(device, { ready: true, model: { performance: {} }, modelAt: 500, history: [{ t: 100 }] });
  const provider = new MultiMonitorViewProvider({
    vscode: { workspace: { getConfiguration: () => ({ get: () => null }) } },
    manager: { paused: true, get: () => device, sync() {}, setConfigFile() {} },
    configStore: { getSaveState: () => ({ status:'saved', error:null }), getCurrent: () => normalizeConfig({}) },
    workspaceState: { get: () => ({ tabs: [id], selected: id, page: 'perf' }) },
    localLinux: false, loadHosts: async () => [],
  });
  const messages = [];
  provider.sidebar = { ready: true, state: provider.sidebarState, target: { visible: true, webview: { postMessage: (message) => messages.push(message) } } };
  provider.onDeviceUpdate(id, device);
  const update = messages.find((message) => message.cmd === 'snapshot');
  assert.equal(update.viewModel, device.model);
  assert.equal(update.sampleTime, 500);
  assert.deepEqual(update.samples, []);
  assert.deepEqual(device.history, [{ t: 100 }]);
  provider.dispose();
  device.dispose();
});


test('changing action switches updates local native titles and all webviews immediately', async () => {
  const contexts = [];
  const messages = [];
  let current = normalizeConfig({});
  let changed;
  const provider = new MultiMonitorViewProvider({
    vscode: {
      env: { language: 'zh-cn' },
      commands: { executeCommand: (...args) => contexts.push(args) },
      workspace: { getConfiguration: () => ({ get: () => null }) },
    },
    manager: { paused: false, get() { return null; }, sync() {}, setConfigFile() {}, updateConfig() {} },
    configStore: {
      getSaveState: () => ({ status:'saved', error:null }), getCurrent: () => current,
      update(key, changes) { for (const {path, value} of changes) current[key][path[0]][path[1]] = value; changed(); },
    },
    workspaceState: { get: () => ({}), update: async () => {} },
    localLinux: false, loadHosts: async () => [],
  });
  changed = () => { provider.manager.updateConfig(); provider.updateActionVisibility(); provider.pushConfig(); };
  provider.sidebar = { state: provider.sidebarState, ready: true, sidebar: true, target: { visible: true, webview: { postMessage: (message) => messages.push(message) } } };
  contexts.length = 0;
  await provider.handleMessage({ version: 1, cmd: 'setConfig', key: 'servers', changes: ['editor','window','terminal','remoteWindow'].map(key => ({ path:['actions',key], value:false })) }, provider.sidebar);
  assert.deepEqual(contexts.filter(([command, key]) => command === 'setContext' && key.startsWith('sysmonitor.action')), [
    ['setContext', 'sysmonitor.actionEditorVisible', false],
    ['setContext', 'sysmonitor.actionWindowVisible', false],
    ['setContext', 'sysmonitor.actionTerminalVisible', false],
    ['setContext', 'sysmonitor.actionRemoteWindowVisible', false],
  ]);
  assert.equal(messages.some((message) => message.cmd === 'config' && message.serversCfg.actions.editor === false), true);
  provider.dispose();
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
    vscode: { env: { language: 'zh-cn' }, Uri: { file: (file) => file }, workspace: { getConfiguration: () => configuration } },
    manager: { sync() {}, setConfigFile() {}, get() { return null; } },
    configStore: { getSaveState: () => ({ status:'saved', error:null }), getCurrent: () => normalizeConfig({}) },
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
  assert.match(await sidebarHtml(provider), /id="server-intro-ssh-default"/);
});


test('joining default extensions from the first-use guide dismisses it only after success', async () => {
  const updates = [];
  const entries = [];
  const provider = new MultiMonitorViewProvider({
    vscode: { env: { language: 'zh-cn' }, Uri: { file: (file) => file }, workspace: { getConfiguration: () => ({
      get: () => entries,
      update: async (_key, value) => { entries.push(...value); },
    }) } },
    manager: { sync() {}, setConfigFile() {}, get() { return null; } },
    configStore: { getSaveState: () => ({ status:'saved', error:null }), getCurrent: () => normalizeConfig({}) },
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
  const initial = JSON.parse(Buffer.from((await sidebarHtml(provider)).match(/data-config="([A-Za-z0-9+/=]+)"/)[1], 'base64').toString('utf8'));
  assert.equal(initial.showLocalIntro, false);
});


test('SSH default-install errors are returned to the inline controls without changing settings', async () => {
  const configuration = { get: () => [], update: async () => { throw new Error('settings write denied'); } };
  const updates = [];
  const provider = new MultiMonitorViewProvider({
    vscode: { workspace: { getConfiguration: () => configuration } },
    manager: { sync() {}, setConfigFile() {}, get() { return null; } },
    configStore: { getSaveState: () => ({ status:'saved', error:null }), getCurrent: () => normalizeConfig({}) },
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


test('closing the final device tab immediately updates its server row to idle', async () => {
  const devices = new Map([['ssh:campus', { id: 'ssh:campus', state: 'connected', model: null, service: { readSnapshot: () => null } }]]);
  const manager = {
    get: (id) => devices.get(id) || null,
    setConfigFile() {},
    sync(open) { for (const id of devices.keys()) if (!open.has(id)) devices.delete(id); },
  };
  const provider = new MultiMonitorViewProvider({
    vscode: { workspace: { getConfiguration: () => ({ get: () => null }) } },
    manager, configStore: { getSaveState: () => ({ status:'saved', error:null }), getCurrent: () => normalizeConfig({}) },
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


test('page switches retain the current snapshot while device switches hydrate atomically', async () => {
  const config = normalizeConfig({});
  const model = { performance: { cpu: { usagePercent: 12 } }, processes: [] };
  const device = (id) => {
    const { session } = createSessionFixture({ id });
    Object.assign(session, { ready: true, model, modelAt: 1, history: [{ t: 1, cpu: 12 }] });
    return session;
  };
  const devices = new Map([['ssh:campus', device('ssh:campus')], ['ssh:lab007', device('ssh:lab007')]]);
  const manager = { paused: false, get: (id) => devices.get(id), sync() {}, setConfigFile() {} };
  const provider = new MultiMonitorViewProvider({
    vscode: { env: { language: 'zh-cn' }, workspace: { getConfiguration: () => ({ get: () => null }) } },
    manager, configStore: { getSaveState: () => ({ status:'saved', error:null }), getCurrent: () => config },
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


test('monitor views wait for SSH while terminal opens without a preflight', async () => {
  const devices = new Map();
  const prepared = [];
  const manager = {
    paused: false, configFile: null,
    get(id) { return devices.get(id) || null; },
    open(id) {
      const fixture = createSessionFixture({ id, remote: true });
      const device = fixture.session;
      device.transport.connect = async () => {
        if (id === 'ssh:bad') throw new Error('SSH exited (255)');
        device.setConnection('connected');
        fixture.commit();
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
    vscode, manager, configStore: { getSaveState: () => ({ status:'saved', error:null }), getCurrent: () => normalizeConfig({}) },
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
  assert.match(provider.serverDirectory.rows().find((row) => row.host === 'bad').error, /255/);
  assert.equal(messages.some((message) => message.cmd === 'servers' && message.hosts.some((row) => row.host === 'bad' && row.busy)), true);
  assert.equal(scheduled.at(-1).milliseconds, 10000);
  await provider.handleMessage({ version: 1, cmd: 'openTerminal', host: 'bad' }, source);
  assert.equal(terminalOpens, 1);
  assert.match(provider.serverDirectory.rows().find((row) => row.host === 'bad').error, /255/);
  scheduled.at(-1).callback();
  assert.equal(provider.serverDirectory.rows().find((row) => row.host === 'bad').state, 'idle');
  assert.equal(provider.serverDirectory.rows().find((row) => row.host === 'bad').error, null);

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


test('a hidden server stays sampled while its first monitor view is being prepared', () => {
  const config = normalizeConfig({ servers: { visibleOnly: true } });
  const manager = new DeviceMonitorManager({ configStore: { getSaveState: () => ({ status:'saved', error:null }), getCurrent: () => config }, localLinux: false });
  const calls = [];
  const service = {
    scheduler: { isPaused: true },
    resume() { this.scheduler.isPaused = false; calls.push('resume'); },
    pause() { this.scheduler.isPaused = true; calls.push('pause'); },
    dispose() { calls.push('dispose'); },
  };
  manager.devices.set('ssh:lab', {
    service, running: false,
    resume() { this.running = true; service.resume(); },
    pause() { this.running = false; service.pause(); },
    dispose() { service.dispose(); },
  });
  manager.setPreparing('ssh:lab', true);
  manager.sync(new Set(), new Set());
  assert.equal(manager.get('ssh:lab') !== null, true);
  assert.deepEqual(calls, ['resume']);
  manager.setPreparing('ssh:lab', false);
  manager.sync(new Set(), new Set());
  assert.deepEqual(calls, ['resume', 'pause', 'dispose']);
});
