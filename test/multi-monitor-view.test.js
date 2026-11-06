'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { normalizeNavigation, normalizeEditorNavigation, MultiMonitorViewProvider } = require('../src/view/multi-monitor-view-provider');
const { normalizeConfig } = require('../src/config/normalize-config');
const { DeviceMonitorManager } = require('../src/services/device-monitor-manager');
const { createSessionFixture } = require('./session-fixture');

const settle = () => new Promise((resolve) => setImmediate(resolve));
const readInitialConfig = (html) => JSON.parse(Buffer.from(html.match(/data-config="([A-Za-z0-9+/=]+)"/)[1], 'base64').toString('utf8'));
const savedConfig = () => ({ getSaveState: () => ({ status: 'saved', error: null }), getCurrent: () => normalizeConfig({}) });

function hostVscode() {
  return { env: { language: 'en' }, Uri: { file: (file) => file }, workspace: { getConfiguration: () => ({ get: () => null }) } };
}

function fakeTarget({ post = () => {}, visible = true, active = false } = {}) {
  const target = {
    visible, active,
    webview: {
      html: '',
      postMessage: (message) => { post(message); return Promise.resolve(true); },
      onDidReceiveMessage(handler) { target.receive = handler; },
    },
    onDidDispose(handler) { target.fireDispose = handler; },
    onDidChangeVisibility(handler) { target.fireVisibility = handler; },
    onDidChangeViewState(handler) { target.fireViewState = handler; },
    dispose() { target.fireDispose(); },
  };
  return target;
}

async function sidebarHtml(provider) {
  const view = fakeTarget();
  await provider.resolveWebviewView(view);
  return view.webview.html;
}

function fakeTimers() {
  const timers = [];
  return {
    timers,
    scheduleReadyCheck: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancelReadyCheck: (timer) => { timer.cancelled = true; },
  };
}

test('navigation restore preserves selected device and page, with a fixed local Linux tab', () => {
  assert.deepEqual(normalizeNavigation({ tabs: ['ssh:campus', 'ssh:campus', 'ssh:lab007'], selected: 'ssh:lab007', page: 'proc' }, true), {
    tabs: ['local', 'ssh:campus', 'ssh:lab007'], selected: 'ssh:lab007', page: 'proc',
  });
  assert.deepEqual(normalizeNavigation({}, false), { tabs: [], selected: null, page: 'servers' });
  assert.equal('processDisplay' in normalizeNavigation({ tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'proc', processDisplay: { cpu: 'whole' } }, false), false);
  assert.deepEqual(normalizeNavigation({ tabs: ['ssh:campus', 'local', 'ssh:lab007'], selected: 'local', page: 'perf' }, true).tabs, ['ssh:campus', 'local', 'ssh:lab007']);
});


test('Editor navigation keeps one device and only performance or process pages', () => {
  assert.deepEqual(normalizeEditorNavigation({ tabs: ['ssh:campus', 'ssh:lab007'], selected: 'ssh:lab007', page: 'servers' }, false), {
    tabs: ['ssh:lab007'], selected: 'ssh:lab007', page: 'perf',
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
      manager: { paused: false, get() { return null; }, sync(open) { syncs.push([...open]); }, setConfigFile() {}, setProcessDemand() {} },
      configStore: { getSaveState: () => ({ status:'saved', error:null }), getCurrent: () => normalizeConfig({}) },
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
  assert.deepEqual(remote.contexts.slice(-2), [
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
  assert.deepEqual(listPage.contexts.filter(([, key]) => key.startsWith('sysmonitor.sidebar')).slice(0, 2), [
    ['setContext', 'sysmonitor.sidebarSshActive', false],
    ['setContext', 'sysmonitor.sidebarFixedActive', false],
  ]);
  listPage.provider.dispose();
});


test('server-list Editor actions create duplicate views without moving sidebar tabs', async () => {
  const provider = new MultiMonitorViewProvider({
    vscode: { env: { language: 'zh-cn' }, workspace: { getConfiguration: () => ({ get: () => null }) } },
    manager: { paused: false, get() { return null; }, sync() {}, setConfigFile() {}, setProcessDemand() {} },
    configStore: { getSaveState: () => ({ status:'saved', error:null }), getCurrent: () => normalizeConfig({}) },
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
  assert.deepEqual(opened[0], { tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'perf' });
  assert.deepEqual(provider.sidebarState.tabs, ['ssh:campus']);
  assert.equal(provider.sidebarState.page, 'servers');
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
    vscode, manager: { paused: false, get() { return null; }, sync() {}, setConfigFile() {}, setProcessDemand() {} },
    configStore: { getSaveState: () => ({ status:'saved', error:null }), getCurrent: () => normalizeConfig({}) },
    workspaceState: { get: () => ({}), update: async () => {} },
    localLinux: true, loadHosts: async () => [],
  });
  const sshPanel = { active: true, reveal() { commands.push(['reveal']); }, dispose() { commands.push(['dispose']); } };
  const localPanel = { active: false, dispose() { commands.push(['dispose-local']); } };
  const sshState = { tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'proc' };
  const localState = { tabs: ['local'], selected: 'local', page: 'perf' };
  provider.editors.set(sshPanel, { target: sshPanel, state: sshState, ready: false, sidebar: false });
  provider.editors.set(localPanel, { target: localPanel, state: localState, ready: false, sidebar: false });
  provider.sidebar = { state: provider.sidebarState, sidebar: true, ready: true, target: { visible: true, show() { commands.push(['show-sidebar']); }, webview: { postMessage() {} } } };
  provider.openTerminal = async (host) => commands.push(['terminal', host]);
  provider.activateRemoteWindow = async (host) => commands.push(['remote', host]);
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
  assert.deepEqual(normalizeConfig({}).servers, { visibleOnly: false, restoreTabs: true, remoteWindowMode: 'menu', actions });
  assert.deepEqual(normalizeConfig({ servers: { visibleOnly: true, restoreTabs: false } }).servers, { visibleOnly: true, restoreTabs: false, remoteWindowMode: 'menu', actions });
  assert.deepEqual(normalizeConfig({ servers: { visibleOnly: 'yes', restoreTabs: null, actions: { editor: false, window: 'no' } } }).servers, {
    visibleOnly: false, restoreTabs: true, remoteWindowMode: 'menu', actions: { ...actions, editor: false },
  });
});


test('local sidebars show a one-time server guide and a status-bar scope tip', async () => {
  let dismissed = false;
  const updates = [];
  const vscode = { env: { language: 'zh-cn' }, Uri: { file: (file) => file }, workspace: { getConfiguration: () => ({ get: () => null }) } };
  const provider = new MultiMonitorViewProvider({
    vscode,
    manager: { sync() {}, setConfigFile() {}, setProcessDemand() {}, get() { return null; } },
    configStore: { getSaveState: () => ({ status:'saved', error:null }), getCurrent: () => normalizeConfig({}) },
    workspaceState: { get: () => ({}), update: async () => {} },
    uiStateStore: { get: () => dismissed, update: async (key, value) => { updates.push([key, value]); dismissed = value; } },
    localLinux: false, loadHosts: async () => [],
  });
  const messages = [];
  const view = fakeTarget({ post: (message) => messages.push(message) });
  await provider.resolveWebviewView(view);
  const sidebar = view.webview.html;
  const panel = fakeTarget();
  await provider.attachEditor(panel, { tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'perf' });
  const editor = panel.webview.html;
  assert.equal(readInitialConfig(sidebar).showLocalIntro, true);
  assert.equal(readInitialConfig(editor).showLocalIntro, false);
  assert.match(editor, /data-surface="editor"/);
  assert.match(sidebar, /data-surface="sidebar"/);
  assert.match(sidebar, /id="server-intro-hint"/);
  assert.match(sidebar, /id="sett-actions-body"/);
  assert.match(sidebar, /id="server-intro-close">我知道了<\/button><button type="button" class="tb on" id="server-intro-ssh-default">加入默认扩展<\/button>/);
  assert.match(sidebar, /id="sett-servers-body" class="settings-options"><\/div>\s*<div class="sett-hint ssh-default-error" id="ssh-default-error" hidden><\/div>/);
  assert.match(sidebar, /id="sett-bar-info"/);
  const linuxProvider = new MultiMonitorViewProvider({
    vscode,
    manager: { sync() {}, setConfigFile() {}, setProcessDemand() {}, get() { return null; } },
    configStore: { getSaveState: () => ({ status:'saved', error:null }), getCurrent: () => normalizeConfig({}) },
    workspaceState: { get: () => ({}) },
    uiStateStore: { get: () => false },
    localLinux: true, loadHosts: async () => [],
  });
  assert.equal(readInitialConfig(await sidebarHtml(linuxProvider)).showLocalIntro, true);
  await view.receive({ version: 1, cmd: 'ready' });
  assert.equal(messages.some((message) => message.cmd === 'localIntroDismissed'), false);
  await view.receive({ version: 1, cmd: 'dismissLocalIntro' });
  assert.deepEqual(updates, [['sysmonitor.localIntroDismissed', true]]);
  assert.equal(messages.at(-1).cmd, 'localIntroDismissed');
  assert.equal(readInitialConfig(await sidebarHtml(provider)).showLocalIntro, false);
  linuxProvider.dispose();
  provider.dispose();
});


test('device tab reorder persists per view and rejects unknown devices', async () => {
  const writes = [];
  const provider = new MultiMonitorViewProvider({
    vscode: { workspace: { getConfiguration: () => ({ get: () => null }) } },
    manager: { sync() {}, setConfigFile() {}, setProcessDemand() {}, get() { return null; } },
    configStore: { getSaveState: () => ({ status:'saved', error:null }), getCurrent: () => normalizeConfig({}) },
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


test('closing an Editor while its HTML loads prevents a write to the disposed panel', async () => {
  const provider = new MultiMonitorViewProvider({
    vscode: hostVscode(), manager: { paused: false, get() { return null; }, sync() {}, setConfigFile() {}, setProcessDemand() {} }, configStore: savedConfig(),
    workspaceState: { get: () => ({}), update: async () => {} }, localLinux: false, loadHosts: async () => [],
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
  assert.equal(provider.activeEditor(), null);
  assert.equal(panel.title, undefined);
  provider.dispose();
});


test('native Editor tab uses the selected SSH alias', async () => {
  let createdTitle = null;
  const provider = new MultiMonitorViewProvider({
    vscode: {
      ViewColumn: { Active: 1 }, Uri: { file: (file) => file },
      window: { createWebviewPanel: (_type, title) => { createdTitle = title; return {}; } },
      workspace: { getConfiguration: () => ({ get: () => null }) },
    },
    manager: { sync() {}, setConfigFile() {}, setProcessDemand() {}, get() { return null; } },
    configStore: { getSaveState: () => ({ status:'saved', error:null }), getCurrent: () => normalizeConfig({}) },
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
    manager: { sync() {}, setConfigFile() {}, setProcessDemand() {}, get() { return null; } },
    configStore: { getSaveState: () => ({ status:'saved', error:null }), getCurrent: () => normalizeConfig({}) },
    workspaceState: { get: () => ({}) }, localLinux: false, loadHosts: async () => [],
  });
  provider.openEditorPanel = async (state) => { calls.push(['openEditor', state.selected]); return panel; };
  calls.length = 0;
  await provider.openFloatingPanel({ tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'proc' });
  assert.deepEqual(calls, [['openEditor', 'ssh:campus'], ['reveal', undefined], ['command', 'workbench.action.moveEditorToNewWindow'], ['reveal', undefined]]);
});


test('sidebar and editor restore independent device/page state while sharing open device references', async () => {
  const syncs = [];
  const config = normalizeConfig({});
  const manager = {
    paused: false,
    sync(open, visible) { syncs.push({ open: [...open], visible: [...visible] }); },
    get() { return null; },
    setConfigFile() {},
    setProcessDemand() {},
  };
  const stored = { tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'proc' };
  const workspaceState = { get: () => stored, update: async () => {} };
  const vscode = {
    env: { language: 'zh-cn' },
    Uri: { file: (file) => file },
    workspace: { getConfiguration: () => ({ get: () => null }) },
  };
  const provider = new MultiMonitorViewProvider({ vscode, manager, configStore: { getSaveState: () => ({ status:'saved', error:null }), getCurrent: () => config }, workspaceState, localLinux: false, loadHosts: async () => ['campus', 'lab007'] });
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
  await provider.attachEditor(panel, { tabs: ['ssh:lab007'], selected: 'ssh:lab007', page: 'perf' });
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
    manager: { sync() {}, setConfigFile() {}, setProcessDemand() {}, get() { return null; } },
    configStore: { getSaveState: () => ({ status:'saved', error:null }), getCurrent: () => normalizeConfig({}) },
    workspaceState: { get: () => ({}), update: async () => {} },
    localLinux: false, loadHosts: async () => ['campus'],
  });
  await provider.refreshHosts();
  const messages = [];
  const source = { state: provider.sidebarState, sidebar: true, ready: true, target: { webview: { postMessage: (message) => messages.push(message) } } };
  provider.sidebar = source;
  await provider.handleMessage({ version: 1, cmd: 'activateRemoteWindow', host: 'campus' }, source);
  assert.deepEqual(messages.at(-1), { cmd: 'remoteFolders', host: 'campus', folders: [{ index: 0, folder: '/home/alice' }, { index: 1, folder: '/workspace' }] });
  provider.sidebarState = { tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'perf' };
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
  await provider.handleMessage({ version: 1, cmd: 'activateRemoteWindow', host: 'campus' }, source);
  assert.deepEqual(messages.at(-1), { cmd: 'remoteFolders', host: 'campus', folders: [] });
  remoteCommandUnavailable = true;
  await provider.handleMessage({ version: 1, cmd: 'openRemoteWindow', host: 'campus' }, source);
  assert.deepEqual(commands.at(-1), ['vscode.newWindow', { remoteAuthority: 'ssh-remote+campus', reuseWindow: false }]);
  provider.dispose();
});


for (const surface of ['list', 'sidebar', 'editor']) for (const mode of ['new', 'recent']) {
  test(`${surface} remote-window button follows ${mode} behavior without opening a picker`, async () => {
    const commands = [], messages = [];
    const provider = new MultiMonitorViewProvider({
      vscode: {
        env: { language: 'zh-cn' }, Uri: { from: (parts) => parts },
        workspace: { getConfiguration: () => ({ get: () => null }) },
        window: { showQuickPick: () => assert.fail('direct mode must not open a menu') },
        commands: { async executeCommand(...args) {
          commands.push(args);
          if (args[0] === 'remote-internal.getSshFoldersHistory') return [
            { remote: 'campus', folder: 'invalid-relative-path' },
            { remote: 'user@campus', folder: '/first' },
            { remote: 'user@campus', folder: '/second' },
          ];
          return true;
        } },
      },
      manager: { sync() {}, setConfigFile() {}, setProcessDemand() {}, get() { return null; } },
      configStore: { getSaveState: () => ({ status:'saved', error:null }), getCurrent: () => normalizeConfig({ servers: { remoteWindowMode: mode } }) },
      workspaceState: { get: () => ({}), update: async () => {} },
      localLinux: false, loadHosts: async () => ['campus'],
    });
    try {
      await provider.refreshHosts();
      commands.length = 0;
      const state = { tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'perf' };
      if (surface === 'list') {
        await provider.handleMessage({ version: 1, cmd: 'activateRemoteWindow', host: 'campus' },
          { sidebar: true, state, target: { webview: { postMessage: (message) => messages.push(message) } } });
        assert.deepEqual(messages, [{ cmd: 'remoteWindowActionDone', host: 'campus' }]);
      } else if (surface === 'sidebar') {
        provider.sidebarState = state;
        await provider.openRemoteWindowForSidebar();
      } else {
        const panel = { active: true };
        provider.editors.set(panel, { state, target: panel });
        await provider.openRemoteWindowForEditor();
      }
      if (mode === 'new') {
        assert.deepEqual(commands, [['opensshremotes.openEmptyWindow', { host: 'campus' }]]);
      } else {
        assert.deepEqual(commands, [
          ['remote-internal.getSshFoldersHistory', 'campus'],
          ['vscode.openFolder', { scheme: 'vscode-remote', authority: 'ssh-remote+user@campus', path: '/first' }, { forceNewWindow: true }],
        ]);
      }
    } finally { provider.dispose(); }
  });
}


test('recent workspace falls back to an empty window when history is empty or unavailable', async () => {
  const provider = Object.create(MultiMonitorViewProvider.prototype);
  provider.configStore = { getCurrent: () => normalizeConfig({ servers: { remoteWindowMode: 'recent' } }) };
  const commands = [];
  const { ServerDirectory } = require('../src/view/server-directory');
  let unavailable = false;
  provider.vscode = { commands: { async executeCommand(name) {
    if (name === 'remote-internal.getSshFoldersHistory') {
      if (unavailable) throw new Error('history unavailable');
      return [];
    }
    commands.push(name);
  } } };
  provider.serverDirectory = new ServerDirectory({ vscode: provider.vscode, manager: {} });
  provider.serverDirectory.hosts = ['campus'];
  await provider.activateRemoteWindow('campus');
  unavailable = true;
  await provider.activateRemoteWindow('campus');
  await provider.activateRemoteWindow('unknown');
  assert.deepEqual(commands, ['opensshremotes.openEmptyWindow', 'opensshremotes.openEmptyWindow']);
  provider.serverDirectory.dispose();
});


test('local process display preferences are global, validated and broadcast to every ready view', async () => {
  const stored = new Map([['sysmonitor.processDisplay', { cpu: 'whole', ram: 'invalid' }]]);
  const updates = [];
  const provider = new MultiMonitorViewProvider({
    vscode: hostVscode(), manager: { paused: false, get() { return null; }, sync() {}, setConfigFile() {}, setProcessDemand() {} }, configStore: savedConfig(),
    workspaceState: { get: () => ({ tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'proc', processDisplay: { cpu: 'both' } }), update: async () => {} },
    uiStateStore: { get: (key, fallback) => (stored.has(key) ? stored.get(key) : fallback), update: async (key, value) => { updates.push([key, value]); stored.set(key, value); } },
    localLinux: false, loadHosts: async () => [],
  });
  const initial = { cpu: 'whole', ram: 'size', expandName: false, expandCmd: false };
  assert.equal('processDisplay' in provider.sidebarState, false);
  const sideMessages = [];
  const editorMessages = [];
  const side = fakeTarget({ post: (message) => sideMessages.push(message) });
  const editor = fakeTarget({ post: (message) => editorMessages.push(message) });
  await provider.resolveWebviewView(side);
  await provider.attachEditor(editor, { tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'perf' });
  for (const target of [side, editor]) {
    assert.deepEqual(readInitialConfig(target.webview.html).processDisplay, initial);
    assert.equal('gpuCount' in readInitialConfig(target.webview.html), false);
  }
  await side.receive({ version: 1, cmd: 'ready' });
  await editor.receive({ version: 1, cmd: 'ready' });
  for (const messages of [sideMessages, editorMessages]) {
    assert.deepEqual(messages.find((message) => message.cmd === 'uiState').processDisplay, initial);
    assert.equal(messages.some((message) => message.cmd === 'config' && 'gpuCount' in message), false);
    messages.length = 0;
  }
  await editor.receive({ version: 1, cmd: 'setProcessDisplay', key: 'expandCmd', value: true });
  await side.receive({ version: 1, cmd: 'setProcessDisplay', key: 'cpu', value: 'invalid' });
  await side.receive({ version: 1, cmd: 'getConfig' });
  await settle();
  const expected = { ...initial, expandCmd: true };
  assert.deepEqual(sideMessages, [{ cmd: 'uiState', processDisplay: expected }]);
  assert.deepEqual(editorMessages, [{ cmd: 'uiState', processDisplay: expected }]);
  assert.deepEqual(updates, [['sysmonitor.processDisplay', expected]]);
  assert.equal('processDisplay' in provider.sidebarState, false);
  provider.dispose();
});


test('local views use only the webview assets as resource roots', async () => {
  const created = [];
  const vscode = { ...hostVscode(), ViewColumn: { Active: 1 }, window: { createWebviewPanel: (_type, _title, _column, options) => { created.push(options); return fakeTarget(); } } };
  const provider = new MultiMonitorViewProvider({
    vscode, manager: { paused: false, get() { return null; }, sync() {}, setConfigFile() {}, setProcessDemand() {} }, configStore: savedConfig(),
    workspaceState: { get: () => ({ tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'perf' }), update: async () => {} },
    localLinux: false, loadHosts: async () => [],
  });
  provider.buildHtml = async () => '<html></html>';
  const options = { enableScripts: true, localResourceRoots: [path.join(__dirname, '..', 'src', 'view', 'assets')] };
  const view = fakeTarget();
  await provider.resolveWebviewView(view);
  const panel = await provider.openEditorPanel();
  assert.deepEqual(view.webview.options, options);
  assert.deepEqual(created, [options]);
  assert.deepEqual(panel.webview.options, options);
  provider.dispose();
});


test('process collection is demanded for devices shown on a visible process page', async () => {
  const demands = [];
  const manager = { paused: false, get() { return null; }, sync() {}, setConfigFile() {}, setProcessDemand: (ids) => demands.push([...ids].sort()) };
  const provider = new MultiMonitorViewProvider({
    vscode: hostVscode(), manager, configStore: savedConfig(),
    workspaceState: { get: () => ({ tabs: ['ssh:a', 'ssh:b'], selected: 'ssh:a', page: 'perf' }), update: async () => {} },
    localLinux: false, loadHosts: async () => [],
  });
  provider.buildHtml = async () => '<html></html>';
  const view = fakeTarget();
  await provider.resolveWebviewView(view);
  await view.receive({ version: 1, cmd: 'ready' });
  assert.deepEqual(demands, []);
  await view.receive({ version: 1, cmd: 'switchPage', page: 'proc' });
  await view.receive({ version: 1, cmd: 'switchDevice', id: 'ssh:b' });
  view.visible = false;
  view.fireVisibility();
  view.visible = true;
  view.fireVisibility();
  assert.deepEqual(demands, [['ssh:a'], ['ssh:b'], [], ['ssh:b']]);
  const panel = fakeTarget({ active: true });
  await provider.attachEditor(panel, { tabs: ['ssh:a'], selected: 'ssh:a', page: 'proc' });
  provider.refreshReferences();
  assert.deepEqual(demands.slice(4), [['ssh:a', 'ssh:b']]);
  panel.visible = false;
  panel.fireViewState();
  panel.dispose();
  await view.receive({ version: 1, cmd: 'switchPage', page: 'servers' });
  assert.deepEqual(demands.slice(5), [['ssh:b'], []]);
  provider.dispose();
});


test('a reshown local sidebar is restored by ready with its device, page, history and dismissed guide', async () => {
  const { session: device } = createSessionFixture({ id: 'ssh:campus' });
  const model = { performance: { cpu: { usagePercent: 4 } }, processes: [], sources: { cpu: { state: 'loading' }, memory: { state: 'loading' }, accelerators: { state: 'loading' } } };
  Object.assign(device, { ready: true, model, modelAt: 5, chartSamples: () => [{ t: 1 }, { t: 2 }] });
  const provider = new MultiMonitorViewProvider({
    vscode: hostVscode(), manager: { paused: false, get: (id) => (id === 'ssh:campus' ? device : null), sync() {}, setConfigFile() {}, setProcessDemand() {} }, configStore: savedConfig(),
    workspaceState: { get: () => ({ tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'proc' }), update: async () => {} },
    uiStateStore: { get: (key, fallback) => (key === 'sysmonitor.localIntroDismissed' ? true : fallback), update: async () => {} },
    localLinux: false, loadHosts: async () => ['campus'],
  });
  await provider.refreshHosts();
  provider.buildHtml = async () => '<html></html>';
  const messages = [];
  const view = fakeTarget({ post: (message) => messages.push(message) });
  await provider.resolveWebviewView(view);
  await view.receive({ version: 1, cmd: 'ready' });
  view.visible = false;
  view.fireVisibility();
  messages.length = 0;
  provider.onDeviceUpdate('ssh:campus', device);
  provider.broadcast({ cmd: 'uiState', paused: true });
  view.visible = true;
  view.fireVisibility();
  provider.onDeviceUpdate('ssh:campus', device);
  assert.deepEqual(messages, []);
  await view.receive({ version: 1, cmd: 'ready' });
  assert.deepEqual(messages.map((message) => message.cmd), ['config', 'navigation', 'uiState', 'localIntroDismissed', 'snapshot']);
  assert.deepEqual(messages[1].state, { tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'proc' });
  assert.equal(messages[4].deviceId, 'ssh:campus');
  assert.equal(messages[4].replaceSamples, true);
  assert.deepEqual(messages[4].samples, [{ t: 1 }, { t: 2 }]);
  assert.equal(messages[4].viewModel, model);
  messages.length = 0;
  await view.receive({ version: 1, cmd: 'switchPage', page: 'servers' });
  assert.deepEqual(messages.filter((message) => message.cmd === 'servers').map((message) => message.hosts.map((row) => row.host)), [['campus']]);
  provider.dispose();
});


test('server rows are pushed only to a visible sidebar on the server page', async () => {
  const provider = new MultiMonitorViewProvider({
    vscode: hostVscode(), manager: { paused: false, get() { return null; }, sync() {}, setConfigFile() {}, setProcessDemand() {} }, configStore: savedConfig(),
    workspaceState: { get: () => ({ tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'perf' }), update: async () => {} },
    localLinux: false, loadHosts: async () => ['campus'],
    scheduleErrorClear: () => ({}), cancelErrorClear() {},
  });
  await provider.refreshHosts();
  const messages = [];
  const source = { state: provider.sidebarState, sidebar: true, ready: true, target: { visible: true, webview: { postMessage: (message) => messages.push(message) } } };
  provider.sidebar = source;
  const rowErrors = () => messages.filter((message) => message.cmd === 'servers').map((message) => message.hosts[0].error);
  provider.serverDirectory.setHostError('campus', 'first failure');
  provider.serverDirectory.notify();
  assert.deepEqual(rowErrors(), []);
  await provider.handleMessage({ version: 1, cmd: 'switchPage', page: 'servers' }, source);
  assert.deepEqual(rowErrors(), ['first failure']);
  provider.serverDirectory.notify();
  provider.serverDirectory.setHostError('campus', 'second failure');
  provider.serverDirectory.notify();
  assert.deepEqual(rowErrors(), ['first failure', 'second failure']);
  source.target.visible = false;
  provider.serverDirectory.setHostError('campus', 'third failure');
  provider.serverDirectory.notify();
  assert.deepEqual(rowErrors(), ['first failure', 'second failure']);
  provider.dispose();
});


test('local views that miss the ready handshake are reloaded once and failed deliveries mark them unready', async () => {
  const clock = fakeTimers();
  const logs = [];
  const provider = new MultiMonitorViewProvider({
    vscode: hostVscode(), manager: { paused: false, get() { return null; }, sync() {}, setConfigFile() {}, setProcessDemand() {} }, configStore: savedConfig(),
    workspaceState: { get: () => ({ tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'perf' }), update: async () => {} },
    localLinux: false, loadHosts: async () => [], logger: (message) => logs.push(message), ...clock,
  });
  let builds = 0;
  provider.buildHtml = async (record) => `<html>${record.label} ${record.state.selected} ${++builds}</html>`;
  const view = fakeTarget();
  await provider.resolveWebviewView(view);
  assert.deepEqual(clock.timers.map((timer) => timer.milliseconds), [10000]);
  clock.timers[0].callback();
  await settle();
  assert.equal(view.webview.html, '<html>sidebar ssh:campus 2</html>');
  assert.match(logs.at(-1), /Webview sidebar did not report ready within 10 s/);
  await view.receive({ version: 1, cmd: 'ready' });
  view.webview.postMessage = () => Promise.resolve(false);
  provider.broadcast({ cmd: 'uiState', paused: false });
  await settle();
  assert.equal(provider.sidebar.ready, false);
  assert.equal(clock.timers.length, 1);
  const panel = fakeTarget({ active: true });
  await provider.attachEditor(panel, { tabs: ['ssh:lab'], selected: 'ssh:lab', page: 'proc' });
  assert.equal(clock.timers.length, 2);
  panel.visible = false;
  panel.fireViewState();
  assert.equal(clock.timers[1].cancelled, true);
  panel.visible = true;
  panel.fireViewState();
  clock.timers[2].callback();
  await settle();
  assert.equal(panel.webview.html, `<html>editor ssh:lab ${builds}</html>`);
  provider.dispose();
});


test('local views log ignored and failed messages and receive retry errors', async () => {
  const logs = [];
  const device = {
    viewState: () => null,
    snapshotMessage: () => ({ cmd: 'snapshot', deviceId: 'ssh:campus' }),
    retry: async () => { throw new Error('collect failed'); },
  };
  const vscode = { ...hostVscode(), commands: { async executeCommand(command) {
    if (command === 'workbench.action.openSettings') throw new Error('settings unavailable');
  } } };
  const provider = new MultiMonitorViewProvider({
    vscode, manager: { paused: false, get: (id) => (id === 'ssh:campus' ? device : null), sync() {}, setConfigFile() {}, setProcessDemand() {} }, configStore: savedConfig(),
    workspaceState: { get: () => ({ tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'perf' }), update: async () => {} },
    localLinux: false, loadHosts: async () => [], logger: (message) => logs.push(message),
  });
  provider.buildHtml = async () => '<html></html>';
  const replacedMessages = [];
  const replaced = fakeTarget({ post: (message) => replacedMessages.push(message) });
  await provider.resolveWebviewView(replaced);
  const messages = [];
  const view = fakeTarget({ post: (message) => messages.push(message) });
  await provider.resolveWebviewView(view);
  await replaced.receive({ version: 1, cmd: 'ready' });
  assert.deepEqual(replacedMessages, []);
  assert.equal(logs.at(-1), 'ignored invalid webview message: ready');
  await view.receive({ version: 1, cmd: 'ready' });
  messages.length = 0;
  await view.receive({ version: 1, cmd: 'bogus' });
  assert.equal(logs.at(-1), 'ignored invalid webview message: bogus');
  await view.receive({ version: 1, cmd: 'openSettings' });
  assert.equal(logs.at(-1), 'Webview message openSettings failed: settings unavailable');
  await view.receive({ version: 1, cmd: 'retrySampling', deviceId: 'ssh:campus' });
  assert.deepEqual(messages, [{ cmd: 'retryConnectionResult', deviceId: 'ssh:campus', error: 'collect failed' }]);
  assert.equal(logs.at(-1), 'Monitor retry ssh:campus: collect failed');
  provider.dispose();
});


test('local pause requests go through the device manager, whose change is broadcast once', async () => {
  const changes = [];
  const manager = {
    paused: false, get() { return null; }, sync() {}, setConfigFile() {}, setProcessDemand() {},
    setPaused(paused) { this.paused = paused; changes.push(paused); },
  };
  const provider = new MultiMonitorViewProvider({
    vscode: hostVscode(), manager, configStore: savedConfig(),
    workspaceState: { get: () => ({ tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'perf' }), update: async () => {} },
    localLinux: false, loadHosts: async () => [],
  });
  provider.buildHtml = async () => '<html></html>';
  const messages = [];
  const view = fakeTarget({ post: (message) => messages.push(message) });
  await provider.resolveWebviewView(view);
  await view.receive({ version: 1, cmd: 'ready' });
  messages.length = 0;
  await view.receive({ version: 1, cmd: 'pause', value: true });
  await view.receive({ version: 1, cmd: 'pause', value: 'yes' });
  assert.deepEqual(changes, [true]);
  assert.deepEqual(messages, []);
  provider.pauseChanged(true);
  assert.deepEqual(messages, [{ cmd: 'uiState', paused: true }]);
  provider.dispose();
});


test('restored local editors accept both stored navigation shapes', async () => {
  const provider = new MultiMonitorViewProvider({
    vscode: hostVscode(), manager: { paused: false, get() { return null; }, sync() {}, setConfigFile() {}, setProcessDemand() {} }, configStore: savedConfig(),
    workspaceState: { get: () => ({}), update: async () => {} }, localLinux: false, loadHosts: async () => [],
  });
  const wrapped = fakeTarget();
  await provider.restoreEditor(wrapped, { navigation: { tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'proc' } });
  assert.deepEqual(readInitialConfig(wrapped.webview.html).navigation, { tabs: ['ssh:campus'], selected: 'ssh:campus', page: 'proc' });
  assert.equal(wrapped.title, 'campus');
  const plain = fakeTarget();
  await provider.restoreEditor(plain, { tabs: ['ssh:lab'], selected: 'ssh:lab', page: 'perf' });
  assert.equal(readInitialConfig(plain.webview.html).navigation.selected, 'ssh:lab');
  let disposed = false;
  const empty = { dispose() { disposed = true; } };
  await provider.restoreEditor(empty, { navigation: {} });
  assert.equal(disposed, true);
  provider.dispose();
});
