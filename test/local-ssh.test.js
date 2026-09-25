'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { normalizeNavigation, normalizeEditorNavigation, MultiMonitorViewProvider } = require('../src/view/multi-monitor-view-provider');
const { normalizeConfig } = require('../src/config/normalize-config');
const { MonitorService } = require('../src/services/monitor-service');
const { DeviceMonitorManager, updateDeviceConnection, canRecordDeviceSample } = require('../src/services/device-monitor-manager');

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
  provider.serverDirectory.runMonitorAction = async (_host, action) => action();
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

test('closing an Editor while its HTML loads prevents a write to the disposed panel', async () => {
  const provider = Object.create(MultiMonitorViewProvider.prototype);
  Object.assign(provider, {
    localLinux: false, editors: new Map(),
    vscode: { env: { language: 'en' }, Uri: { file: (value) => value } },
    refreshReferences() {}, updateEditorTitleActions() {},
  });
  let finishHtml;
  let disposePanel;
  provider.buildHtml = () => new Promise((resolve) => { finishHtml = resolve; });
  const panel = {
    active: true,
    webview: {
      onDidReceiveMessage() {},
      set html(_value) { assert.fail('wrote HTML to a disposed panel'); },
    },
    onDidDispose(callback) { disposePanel = callback; },
  };
  const attached = provider.attachEditor(panel, { tabs: ['ssh:lab'], selected: 'ssh:lab', page: 'perf' });
  disposePanel();
  finishHtml('<html></html>');
  await attached;
  assert.equal(provider.editors.size, 0);
  assert.equal(provider.lastFocusedEditor, null);
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
