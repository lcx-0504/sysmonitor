'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ConfigStore } = require('../src/config/config-store');
const { normalizeConfig } = require('../src/config/normalize-config');
const { DeviceMonitorManager } = require('../src/services/device-monitor-manager');
const { createFakeVscode, createMemento } = require('./fake-vscode');
const { createSessionFixture } = require('./session-fixture');
const {
  SIDEBAR_STATE_KEY, readInitialConfig, createDeviceManager, createReadyDevice, createMultiProvider, openSidebar, commandsOf,
} = require('./view-fixture');

const campus = (page = 'perf') => ({ tabs: ['ssh:campus'], selected: 'ssh:campus', page });

function monitor(t, options) {
  const result = createMultiProvider(options);
  t.after(() => result.provider.dispose());
  return result;
}

async function sidebarHtml(provider, vscode) {
  return (await openSidebar(provider, vscode, { ready: false })).webview.html;
}

test('residual-process warning copies PIDs and acknowledges without resuming monitoring', async (t) => {
  const choices = ['复制 PID', '我知道了'];
  const vscode = createFakeVscode({ language: 'zh-cn', window: { showWarningMessage: () => choices.shift() } });
  const { provider, manager } = monitor(t, { vscode, manager: createDeviceManager({ paused: true }) });
  const view = await openSidebar(provider, vscode);
  view.messages.length = 0;
  let acknowledged = 0;
  await provider.notifyResidualProcesses('campus', [1, 2, 3, 4, 5], () => acknowledged++);
  assert.equal(acknowledged, 1);
  assert.equal(manager.paused, true);
  assert.deepEqual(manager.pauseRequests, []);
  assert.deepEqual(vscode.fake.clipboard, ['1, 2, 3, 4, 5']);
  assert.deepEqual(view.messages, []);
  const message = '远程服务器性能采集多次超时，服务器「campus」有 5 个采集进程在超时或连接断开后仍未退出。监控已自动暂停，通常等待一段时间后这些采集进程会自动退出，但仍建议检查这些进程并按需清理。若服务器性能较低、频繁出现此类问题，建议增加刷新时间间隔（设置->刷新时间）。 PID：1, 2, 3, 4, 5';
  assert.deepEqual(vscode.fake.warnings, [[message, '复制 PID', '我知道了'], [message, '复制 PID', '我知道了']]);
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

test('paused one-shot metrics reach the view without adding a trend point', async (t) => {
  const id = 'ssh:fixture';
  const fixture = createSessionFixture({ id, paused: true });
  const device = fixture.session;
  t.after(() => device.dispose());
  const vscode = createFakeVscode();
  const { provider } = monitor(t, {
    vscode, manager: createDeviceManager({ paused: true, devices: new Map([[id, device]]) }), sidebarState: { tabs: [id], selected: id, page: 'perf' },
  });
  const view = await openSidebar(provider, vscode);
  view.messages.length = 0;
  fixture.commit();
  provider.onDeviceUpdate(id, device);
  const update = commandsOf(view.messages, 'snapshot')[0];
  assert.equal(update.viewModel, device.model);
  assert.equal(update.viewModel.performance.cpu.usagePercent, 12);
  assert.equal(update.sampleTime, device.modelAt);
  assert.deepEqual(update.samples, []);
  assert.deepEqual(device.chartSamples(), []);
});

test('changing action switches updates local native titles and all webviews immediately', async (t) => {
  const vscode = createFakeVscode({ language: 'zh-cn' });
  const configStore = new ConfigStore({ vscode });
  const { provider } = monitor(t, { vscode, configStore });
  const subscription = configStore.onDidChange(() => {
    provider.updateActionVisibility();
    provider.pushConfig();
  });
  t.after(() => subscription.dispose());
  const view = await openSidebar(provider, vscode);
  vscode.fake.journal.length = 0;
  await view.receive({ version: 1, cmd: 'setConfig', key: 'servers', changes: ['editor', 'window', 'terminal', 'remoteWindow'].map((key) => ({ path: ['actions', key], value: false })) });
  const actionContexts = vscode.fake.journal.filter((entry) => entry.command === 'setContext' && entry.args[0].startsWith('sysmonitor.action'));
  assert.deepEqual(actionContexts.map((entry) => entry.args), [
    ['sysmonitor.actionEditorVisible', false],
    ['sysmonitor.actionWindowVisible', false],
    ['sysmonitor.actionTerminalVisible', false],
    ['sysmonitor.actionRemoteWindowVisible', false],
  ]);
  assert.equal(commandsOf(view.messages, 'config').some((message) => message.serversCfg.actions.editor === false), true);
  await configStore.flush();
});

test('SSH default-install action is explicit, deduplicated, and writes the global Remote-SSH setting', async (t) => {
  const vscode = createFakeVscode({ language: 'zh-cn', settings: { 'remote.SSH': { defaultExtensions: ['example.other-extension'] } } });
  const { provider } = monitor(t, { vscode });
  const view = await openSidebar(provider, vscode);
  assert.equal(commandsOf(view.messages, 'config')[0].sshDefaultInstalled, false);
  assert.deepEqual(vscode.fake.settingWrites, []);
  await view.receive({ version: 1, cmd: 'addSshDefaultExtension' });
  assert.deepEqual(vscode.fake.settingWrites, [{ section: 'remote.SSH', key: 'defaultExtensions', value: ['example.other-extension', 'LiChenxi.sysmonitor'], target: true }]);
  assert.deepEqual(view.messages.at(-1), { cmd: 'sshDefaultExtensions', installed: true });
  await view.receive({ version: 1, cmd: 'addSshDefaultExtension' });
  assert.equal(vscode.fake.settingWrites.length, 1);
  const html = await sidebarHtml(provider, vscode);
  assert.match(html, /id="server-intro-ssh-default"/);
  assert.equal(readInitialConfig(html).sshDefaultInstalled, true);
});

test('joining default extensions from the first-use guide dismisses it only after success', async (t) => {
  const vscode = createFakeVscode({ language: 'zh-cn', settings: { 'remote.SSH': { defaultExtensions: [] } } });
  const uiStateStore = createMemento();
  const { provider } = monitor(t, { vscode, uiStateStore });
  const view = await openSidebar(provider, vscode);
  await view.receive({ version: 1, cmd: 'addSshDefaultExtension', dismissIntro: true });
  assert.deepEqual(uiStateStore.writes, [['sysmonitor.localIntroDismissed', true]]);
  assert.equal(commandsOf(view.messages, 'localIntroDismissed').length, 1);
  assert.equal(view.messages.some((message) => message.cmd === 'sshDefaultExtensions' && message.installed), true);
  assert.equal(readInitialConfig(await sidebarHtml(provider, vscode)).showLocalIntro, false);
});

test('SSH default-install errors are returned to the inline controls without changing settings', async (t) => {
  const vscode = createFakeVscode({ onSettingUpdate: () => {
    throw new Error('settings write denied');
  } });
  const uiStateStore = createMemento();
  const { provider } = monitor(t, { vscode, uiStateStore });
  const view = await openSidebar(provider, vscode);
  await view.receive({ version: 1, cmd: 'addSshDefaultExtension', dismissIntro: true });
  assert.deepEqual(view.messages.at(-1), { cmd: 'sshDefaultExtensions', installed: false, error: 'settings write denied' });
  assert.deepEqual(vscode.fake.settings['remote.SSH'], {});
  assert.deepEqual(uiStateStore.writes, []);
});

test('closing the final device tab immediately updates its server row to idle', async (t) => {
  const device = await createReadyDevice('ssh:campus');
  t.after(() => device.dispose());
  const devices = new Map([['ssh:campus', device]]);
  const manager = createDeviceManager({ devices, sync(open) {
    for (const id of devices.keys()) if (!open.has(id)) devices.delete(id);
  } });
  const vscode = createFakeVscode();
  const { provider, workspaceState } = monitor(t, { vscode, manager, sidebarState: campus(), hosts: ['campus'] });
  await provider.refreshHosts();
  const view = await openSidebar(provider, vscode);
  await view.receive({ version: 1, cmd: 'closeDevice', id: 'ssh:campus' });
  assert.deepEqual(workspaceState.writes.at(-1), [SIDEBAR_STATE_KEY, { tabs: [], selected: null, page: 'servers' }]);
  assert.equal(devices.has('ssh:campus'), false);
  assert.equal(view.messages.some((message) => message.cmd === 'servers' && message.hosts[0].state === 'idle'), true);
});

test('page switches retain the current snapshot while device switches hydrate atomically', async (t) => {
  const devices = new Map();
  for (const id of ['ssh:campus', 'ssh:lab007']) devices.set(id, await createReadyDevice(id));
  t.after(() => devices.forEach((device) => device.dispose()));
  const vscode = createFakeVscode({ language: 'zh-cn' });
  const { provider } = monitor(t, {
    vscode, manager: createDeviceManager({ devices }), sidebarState: { tabs: ['ssh:campus', 'ssh:lab007'], selected: 'ssh:campus', page: 'perf' },
  });
  const view = await openSidebar(provider, vscode);
  view.messages.length = 0;
  await view.receive({ version: 1, cmd: 'switchPage', page: 'servers' });
  assert.equal(commandsOf(view.messages, 'navigation').length, 1);
  assert.equal(commandsOf(view.messages, 'snapshot').length, 0);
  view.messages.length = 0;
  provider.onDeviceUpdate('ssh:campus', devices.get('ssh:campus'));
  assert.equal(commandsOf(view.messages, 'snapshot')[0].sampleTime, devices.get('ssh:campus').modelAt);
  view.messages.length = 0;
  await view.receive({ version: 1, cmd: 'switchDevice', id: 'ssh:lab007' });
  const lab = devices.get('ssh:lab007');
  const [hydrated] = commandsOf(view.messages, 'deviceState');
  assert.equal(commandsOf(view.messages, 'deviceState').length, 1);
  assert.equal(commandsOf(view.messages, 'snapshot').length, 0);
  assert.equal(hydrated.viewModel, lab.model);
  assert.deepEqual(hydrated.samples, lab.chartSamples());
  assert.equal(hydrated.sampleTime, lab.modelAt);
  view.messages.length = 0;
  await view.receive({ version: 1, cmd: 'ready' });
  assert.equal(commandsOf(view.messages, 'snapshot')[0].sampleTime, lab.modelAt);
});

test('monitor views wait for SSH while terminal opens without a preflight', async (t) => {
  const devices = new Map();
  const manager = createDeviceManager({
    devices,
    open(id) {
      const fixture = createSessionFixture({ id, remote: true });
      const device = fixture.session;
      t.after(() => device.dispose());
      fixture.transport.connect = async () => {
        if (id === 'ssh:bad') throw new Error('SSH exited (255)');
        device.setConnection('connected');
        fixture.commit();
      };
      devices.set(id, device);
      return device;
    },
    sync(open) {
      for (const id of devices.keys()) if (!open.has(id)) devices.delete(id);
    },
  });
  const scheduled = [];
  const vscode = createFakeVscode({ language: 'zh-cn' });
  const { provider, workspaceState } = monitor(t, {
    vscode, manager, hosts: ['good', 'bad'],
    scheduleErrorClear: (callback, milliseconds) => {
      scheduled.push({ callback, milliseconds });
      return scheduled.length;
    },
    cancelErrorClear() {},
  });
  await provider.refreshHosts();
  const view = await openSidebar(provider, vscode);
  const row = (host) => commandsOf(view.messages, 'servers').at(-1).hosts.find((entry) => entry.host === host);

  await view.receive({ version: 1, cmd: 'openServer', host: 'bad', inEditor: true });
  assert.equal(vscode.fake.panels.length, 0);
  assert.equal(devices.has('ssh:bad'), false);
  assert.match(row('bad').error, /255/);
  assert.equal(view.messages.some((message) => message.cmd === 'servers' && message.hosts.some((entry) => entry.host === 'bad' && entry.busy)), true);
  assert.equal(scheduled.at(-1).milliseconds, 10000);
  await view.receive({ version: 1, cmd: 'openTerminal', host: 'bad' });
  assert.equal(vscode.fake.terminals.length, 1);
  assert.match(row('bad').error, /255/);
  scheduled.at(-1).callback();
  assert.equal(row('bad').state, 'idle');
  assert.equal(row('bad').error, null);

  await view.receive({ version: 1, cmd: 'openServer', host: 'good', inWindow: true });
  assert.equal(vscode.fake.panels.length, 1);
  assert.deepEqual(readInitialConfig(vscode.fake.panels[0].webview.html).navigation.tabs, ['ssh:good']);
  assert.equal(vscode.fake.executed.some(([command]) => command === 'workbench.action.moveEditorToNewWindow'), true);
  assert.deepEqual(manager.preparing.slice(-2), [['ssh:good', true], ['ssh:good', false]]);
  await view.receive({ version: 1, cmd: 'openServer', host: 'good', inEditor: true });
  assert.equal(vscode.fake.panels.length, 2);
  devices.delete('ssh:good');
  await view.receive({ version: 1, cmd: 'openTerminal', host: 'good' });
  assert.equal(vscode.fake.terminals.length, 2);
  assert.deepEqual(workspaceState.writes, []);
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
