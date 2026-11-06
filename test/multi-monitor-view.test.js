'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { normalizeNavigation, normalizeEditorNavigation } = require('../src/view/multi-monitor-view-provider');
const { normalizeConfig } = require('../src/config/normalize-config');
const { createFakeVscode, createMemento } = require('./fake-vscode');
const { createSessionFixture } = require('./session-fixture');
const {
  READY, SIDEBAR_STATE_KEY, settle, readInitialConfig, savedConfigStore, fakeTimers, createDeviceManager, createReadyDevice,
  createMultiProvider, openSidebar, openEditor, commandsOf,
} = require('./view-fixture');

const MOVE_TO_WINDOW = 'workbench.action.moveEditorToNewWindow';
const campus = (page = 'perf') => ({ tabs: ['ssh:campus'], selected: 'ssh:campus', page });

function monitor(t, options) {
  const result = createMultiProvider(options);
  t.after(() => result.provider.dispose());
  return result;
}

function lastSidebarWrite(workspaceState) {
  const writes = workspaceState.writes.filter(([key]) => key === SIDEBAR_STATE_KEY);
  return writes.length ? writes.at(-1)[1] : null;
}

function surfaceActions(vscode) {
  return vscode.fake.journal.flatMap((entry) => {
    if (entry.type === 'command' && entry.command !== 'setContext') return [entry.command];
    if (entry.type === 'reveal' || entry.type === 'dispose' || entry.type === 'show') return [entry.type];
    return [];
  });
}

test('navigation restore preserves selected device and page, with a fixed local Linux tab', () => {
  assert.deepEqual(normalizeNavigation({ tabs: ['ssh:campus', 'ssh:campus', 'ssh:lab007'], selected: 'ssh:lab007', page: 'proc' }, true), {
    tabs: ['local', 'ssh:campus', 'ssh:lab007'], selected: 'ssh:lab007', page: 'proc',
  });
  assert.deepEqual(normalizeNavigation({}, false), { tabs: [], selected: null, page: 'servers' });
  assert.deepEqual(normalizeNavigation({ ...campus('proc'), processDisplay: { cpu: 'whole' } }, false), campus('proc'));
  assert.deepEqual(normalizeNavigation({ tabs: ['ssh:campus', 'local', 'ssh:lab007'], selected: 'local', page: 'perf' }, true).tabs, ['ssh:campus', 'local', 'ssh:lab007']);
});

test('Editor navigation keeps one device and only performance or process pages', () => {
  assert.deepEqual(normalizeEditorNavigation({ tabs: ['ssh:campus', 'ssh:lab007'], selected: 'ssh:lab007', page: 'servers' }, false), {
    tabs: ['ssh:lab007'], selected: 'ssh:lab007', page: 'perf',
  });
  assert.deepEqual(normalizeEditorNavigation({ tabs: ['local', 'ssh:campus'], selected: 'local', page: 'proc' }, true).tabs, ['local']);
  assert.equal(normalizeEditorNavigation({}, false), null);
});

test('sidebar pop-out moves an SSH tab but copies the fixed local device', async (t) => {
  async function popOut(localLinux, sidebarState, { floating = false, commands = {} } = {}) {
    const vscode = createFakeVscode({ language: 'zh-cn', commands });
    const result = monitor(t, { vscode, localLinux, sidebarState });
    const view = await openSidebar(result.provider, vscode);
    view.messages.length = 0;
    const moved = result.provider.moveSidebarDeviceToEditor(floating);
    return { ...result, view, moved };
  }

  const remote = await popOut(false, campus('proc'));
  await remote.moved;
  assert.deepEqual(readInitialConfig(remote.vscode.fake.panels[0].webview.html).navigation, campus('proc'));
  const emptied = { tabs: [], selected: null, page: 'servers' };
  assert.deepEqual(lastSidebarWrite(remote.workspaceState), emptied);
  assert.deepEqual(commandsOf(remote.view.messages, 'deviceState').at(-1).state, emptied);
  assert.deepEqual(remote.manager.syncs.at(-1).open, ['ssh:campus']);
  assert.equal(remote.vscode.fake.contexts.get('sysmonitor.sidebarSshActive'), false);
  assert.equal(remote.vscode.fake.contexts.get('sysmonitor.sidebarFixedActive'), false);

  const local = await popOut(true, { tabs: ['local'], selected: 'local', page: 'perf' });
  await local.moved;
  assert.deepEqual(readInitialConfig(local.vscode.fake.panels[0].webview.html).navigation.tabs, ['local']);
  assert.equal(lastSidebarWrite(local.workspaceState), null);
  assert.deepEqual(local.view.messages, []);

  const failed = await popOut(false, campus(), { floating: true, commands: { [MOVE_TO_WINDOW]: () => {
    throw new Error('window move failed');
  } } });
  await assert.rejects(failed.moved, /window move failed/);
  assert.equal(failed.vscode.fake.panels[0].disposed, true);
  assert.equal(lastSidebarWrite(failed.workspaceState), null);

  const listPage = await popOut(false, campus('servers'));
  await listPage.moved;
  assert.equal(listPage.vscode.fake.panels.length, 0);
  assert.equal(listPage.vscode.fake.contexts.get('sysmonitor.sidebarSshActive'), false);
  assert.equal(listPage.vscode.fake.contexts.get('sysmonitor.sidebarFixedActive'), false);
});

test('server-list Editor actions create duplicate views without moving sidebar tabs', async (t) => {
  const device = await createReadyDevice('ssh:campus');
  t.after(() => device.dispose());
  const vscode = createFakeVscode({ language: 'zh-cn' });
  const { provider, workspaceState } = monitor(t, {
    vscode, manager: createDeviceManager({ devices: new Map([['ssh:campus', device]]) }), sidebarState: campus('servers'), hosts: ['campus'],
  });
  await provider.refreshHosts();
  const view = await openSidebar(provider, vscode);
  await view.receive({ version: 1, cmd: 'openServer', host: 'campus', inEditor: true });
  await view.receive({ version: 1, cmd: 'openServer', host: 'campus', inEditor: true });
  assert.equal(vscode.fake.panels.length, 2);
  assert.deepEqual(readInitialConfig(vscode.fake.panels[0].webview.html).navigation, campus('perf'));
  assert.equal(lastSidebarWrite(workspaceState), null);
  assert.equal(readInitialConfig(view.webview.html).navigation.page, 'servers');
  assert.deepEqual(commandsOf(view.messages, 'navigation').map((message) => message.state), [campus('servers')]);
});

test('Editor title actions return the active device to the sidebar or move its window', async (t) => {
  let failMove = false;
  const vscode = createFakeVscode({ language: 'zh-cn', commands: { [MOVE_TO_WINDOW]: () => {
    if (failMove) throw new Error('move failed');
  } } });
  const { provider, workspaceState } = monitor(t, { vscode, localLinux: true, hosts: ['campus'] });
  await provider.refreshHosts();
  const editorContexts = () => vscode.fake.journal.filter((entry) => entry.command === 'setContext' && entry.args[0] === 'sysmonitor.editorSshActive');
  const view = await openSidebar(provider, vscode);
  const sshPanel = await openEditor(provider, vscode, campus('proc'), { active: true });
  const localPanel = await openEditor(provider, vscode, { tabs: ['local'], selected: 'local', page: 'perf' }, { active: false });
  assert.equal(vscode.fake.contexts.get('sysmonitor.editorSshActive'), true);
  const contextCount = editorContexts().length;
  sshPanel.setState({ active: false });
  assert.equal(editorContexts().length, contextCount);

  vscode.fake.journal.length = 0;
  await provider.moveActiveEditorToNewWindow();
  assert.deepEqual(surfaceActions(vscode), ['reveal', MOVE_TO_WINDOW, 'reveal']);
  assert.ok(vscode.fake.journal.filter((entry) => entry.type === 'reveal').every((entry) => entry.target === sshPanel));
  sshPanel.setState({ active: true });
  await provider.openTerminalForEditor();
  await provider.openRemoteWindowForEditor();
  assert.deepEqual(vscode.fake.terminals.map((terminal) => terminal.options), [{ name: 'SSH: campus', shellPath: 'ssh', shellArgs: ['campus'] }]);
  assert.deepEqual(vscode.fake.quickPicks.map(([, options]) => options.placeHolder), ['SSH: campus']);

  failMove = true;
  await assert.rejects(provider.moveActiveEditorToNewWindow(), /move failed/);
  assert.equal(sshPanel.disposed, false);
  failMove = false;
  vscode.fake.journal.length = 0;
  await provider.returnActiveEditorToSidebar();
  assert.deepEqual(lastSidebarWrite(workspaceState), { tabs: ['local', 'ssh:campus'], selected: 'ssh:campus', page: 'proc' });
  assert.deepEqual(surfaceActions(vscode), ['show', 'dispose']);
  assert.equal(sshPanel.disposed, true);
  assert.deepEqual(commandsOf(view.messages, 'deviceState').at(-1).state, { tabs: ['local', 'ssh:campus'], selected: 'ssh:campus', page: 'proc' });

  localPanel.setState({ active: true });
  assert.equal(vscode.fake.contexts.get('sysmonitor.editorSshActive'), false);
  await provider.openTerminalForEditor();
  await provider.openRemoteWindowForEditor();
  await provider.returnActiveEditorToSidebar();
  assert.deepEqual(lastSidebarWrite(workspaceState), { tabs: ['local', 'ssh:campus'], selected: 'local', page: 'perf' });
  assert.equal(vscode.fake.terminals.length, 1);
  assert.equal(vscode.fake.quickPicks.length, 1);

  const lastPanel = await openEditor(provider, vscode, campus(), { active: true });
  assert.equal(vscode.fake.contexts.get('sysmonitor.editorSshActive'), true);
  lastPanel.dispose();
  assert.equal(vscode.fake.contexts.get('sysmonitor.editorSshActive'), false);
});

test('server settings restore by default and normalize invalid values', () => {
  const actions = { editor: true, window: true, terminal: true, remoteWindow: true };
  assert.deepEqual(normalizeConfig({}).servers, { visibleOnly: false, restoreTabs: true, remoteWindowMode: 'menu', actions });
  assert.deepEqual(normalizeConfig({ servers: { visibleOnly: true, restoreTabs: false } }).servers, { visibleOnly: true, restoreTabs: false, remoteWindowMode: 'menu', actions });
  assert.deepEqual(normalizeConfig({ servers: { visibleOnly: 'yes', restoreTabs: null, actions: { editor: false, window: 'no' } } }).servers, {
    visibleOnly: false, restoreTabs: true, remoteWindowMode: 'menu', actions: { ...actions, editor: false },
  });
});

test('local sidebars show a one-time server guide and a status-bar scope tip', async (t) => {
  const vscode = createFakeVscode({ language: 'zh-cn' });
  const uiStateStore = createMemento();
  const { provider } = monitor(t, { vscode, uiStateStore });
  const view = await openSidebar(provider, vscode, { ready: false });
  const sidebar = view.webview.html;
  const panel = await openEditor(provider, vscode, campus(), { ready: false });
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
  const linux = monitor(t, { vscode, localLinux: true, uiStateStore: createMemento() });
  assert.equal(readInitialConfig((await openSidebar(linux.provider, vscode, { ready: false })).webview.html).showLocalIntro, true);
  await view.receive(READY);
  assert.equal(commandsOf(view.messages, 'localIntroDismissed').length, 0);
  await view.receive({ version: 1, cmd: 'dismissLocalIntro' });
  assert.deepEqual(uiStateStore.writes, [['sysmonitor.localIntroDismissed', true]]);
  assert.equal(view.messages.at(-1).cmd, 'localIntroDismissed');
  assert.equal(readInitialConfig((await openSidebar(provider, vscode, { ready: false })).webview.html).showLocalIntro, false);
});

test('device tab reorder persists per view and rejects unknown devices', async (t) => {
  const logs = [];
  const vscode = createFakeVscode();
  const { provider, workspaceState } = monitor(t, {
    vscode, sidebarState: { tabs: ['ssh:first', 'ssh:second'], selected: 'ssh:first', page: 'perf' }, logger: (message) => logs.push(message),
  });
  const view = await openSidebar(provider, vscode);
  await view.receive({ version: 1, cmd: 'reorderDevices', tabs: ['ssh:second', 'ssh:first'] });
  assert.deepEqual(lastSidebarWrite(workspaceState).tabs, ['ssh:second', 'ssh:first']);
  assert.deepEqual(commandsOf(view.messages, 'navigation').at(-1).state.tabs, ['ssh:second', 'ssh:first']);
  await view.receive({ version: 1, cmd: 'reorderDevices', tabs: ['ssh:second', 'ssh:other'] });
  assert.equal(workspaceState.writes.length, 1);
  assert.equal(logs.at(-1), 'ignored invalid webview message: reorderDevices');
});

test('closing an Editor while its HTML loads prevents a write to the disposed panel', async (t) => {
  const vscode = createFakeVscode();
  const { provider } = monitor(t, { vscode });
  const panel = vscode.fake.createPanel({ active: true });
  const attached = provider.attachEditor(panel, { tabs: ['ssh:lab'], selected: 'ssh:lab', page: 'perf' });
  panel.dispose();
  await attached;
  assert.deepEqual(panel.webview.htmlHistory, []);
  assert.equal(panel.title, '');
  assert.equal(provider.activeEditor(), null);
});

test('native Editor tab uses the selected SSH alias', async (t) => {
  const vscode = createFakeVscode();
  const { provider } = monitor(t, { vscode });
  const state = { tabs: ['ssh:lichenxi_lab007_vps'], selected: 'ssh:lichenxi_lab007_vps', page: 'perf' };
  const panel = await provider.openEditorPanel(state);
  assert.equal(panel, vscode.fake.panels[0]);
  assert.equal(panel.title, 'lichenxi_lab007_vps');
  assert.equal(panel.viewType, 'sysmonitor.editor');
});

test('floating monitor reuses the Editor view and moves it into a native window', async (t) => {
  const vscode = createFakeVscode();
  const { provider } = monitor(t, { vscode });
  const panel = await provider.openFloatingPanel(campus('proc'));
  assert.equal(readInitialConfig(panel.webview.html).navigation.selected, 'ssh:campus');
  assert.deepEqual(surfaceActions(vscode), ['reveal', MOVE_TO_WINDOW, 'reveal']);
});

test('sidebar and editor restore independent device/page state while sharing open device references', async (t) => {
  const vscode = createFakeVscode({ language: 'zh-cn' });
  const logs = [];
  const { provider, manager, workspaceState } = monitor(t, { vscode, sidebarState: campus('proc'), hosts: ['campus', 'lab007'], logger: (message) => logs.push(message) });
  assert.deepEqual(manager.syncs.at(-1).open, ['ssh:campus']);
  const panel = await openEditor(provider, vscode, { tabs: ['ssh:lab007'], selected: 'ssh:lab007', page: 'perf' });
  assert.equal(panel.title, 'lab007');
  assert.equal(path.basename(panel.iconPath.light), 'icon-tab-light.svg');
  assert.equal(path.basename(panel.iconPath.dark), 'icon-tab-dark.svg');
  assert.deepEqual(manager.syncs.at(-1).open, ['ssh:campus', 'ssh:lab007']);
  assert.equal(commandsOf(panel.messages, 'navigation').at(-1).state.selected, 'ssh:lab007');
  panel.messages.length = 0;
  await panel.receive({ version: 1, cmd: 'switchPage', page: 'servers' });
  assert.deepEqual(panel.messages, []);
  assert.equal(logs.at(-1), 'ignored invalid webview message: switchPage');
  await panel.receive({ version: 1, cmd: 'switchPage', page: 'proc' });
  assert.deepEqual(commandsOf(panel.messages, 'navigation').map((message) => message.state.page), ['proc']);
  assert.equal(lastSidebarWrite(workspaceState), null);
  panel.dispose();
  assert.deepEqual(manager.syncs.at(-1).open, ['ssh:campus']);
});

test('Remote-SSH menu exposes recent folders and opens a new remote window without collector SSH preflight', async (t) => {
  let historyUnavailable = false;
  let remoteCommandUnavailable = false;
  const vscode = createFakeVscode({
    language: 'zh-cn',
    window: { showQuickPick(choices) {
      assert.deepEqual(choices.map((choice) => choice.label), ['连接主机', '/home/alice', '/workspace']);
      return choices[1];
    } },
    commands: {
      'remote-internal.getSshFoldersHistory': () => {
        if (historyUnavailable) throw new Error('command not found');
        return [
          { remote: 'alice@campus', folder: '/home/alice' },
          { remote: 'alice@campus', folder: '/home/alice' },
          { remote: 'alice@campus', folder: 'relative' },
          { remote: 'alice@campus', folder: '/workspace' },
        ];
      },
      'opensshremotes.openEmptyWindow': () => {
        if (remoteCommandUnavailable) throw new Error('command opensshremotes.openEmptyWindow not found');
        return true;
      },
      'vscode.openFolder': () => true,
    },
  });
  const { provider } = monitor(t, { vscode, sidebarState: campus(), hosts: ['campus'] });
  await provider.refreshHosts();
  const view = await openSidebar(provider, vscode);
  const executed = (name) => vscode.fake.executed.filter(([command]) => command === name);
  const aliceHome = ['vscode.openFolder', { scheme: 'vscode-remote', authority: 'ssh-remote+alice@campus', path: '/home/alice' }, { forceNewWindow: true }];
  await view.receive({ version: 1, cmd: 'activateRemoteWindow', host: 'campus' });
  assert.deepEqual(view.messages.at(-1), { cmd: 'remoteFolders', host: 'campus', folders: [{ index: 0, folder: '/home/alice' }, { index: 1, folder: '/workspace' }] });
  await provider.openRemoteWindowForSidebar();
  assert.deepEqual(executed('vscode.openFolder'), [aliceHome]);
  await view.receive({ version: 1, cmd: 'openRemoteWindow', host: 'campus', folderIndex: 0 });
  assert.deepEqual(executed('vscode.openFolder'), [aliceHome, aliceHome]);
  await view.receive({ version: 1, cmd: 'openRemoteWindow', host: 'campus' });
  assert.deepEqual(executed('opensshremotes.openEmptyWindow'), [['opensshremotes.openEmptyWindow', { host: 'campus' }]]);
  const before = vscode.fake.executed.length;
  await view.receive({ version: 1, cmd: 'openRemoteWindow', host: 'campus', folderIndex: 99 });
  assert.equal(vscode.fake.executed.length, before);
  historyUnavailable = true;
  await view.receive({ version: 1, cmd: 'activateRemoteWindow', host: 'campus' });
  assert.deepEqual(view.messages.at(-1), { cmd: 'remoteFolders', host: 'campus', folders: [] });
  remoteCommandUnavailable = true;
  await view.receive({ version: 1, cmd: 'openRemoteWindow', host: 'campus' });
  assert.deepEqual(vscode.fake.executed.at(-1), ['vscode.newWindow', { remoteAuthority: 'ssh-remote+campus', reuseWindow: false }]);
});

for (const surface of ['list', 'sidebar', 'editor']) for (const mode of ['new', 'recent']) {
  test(`${surface} remote-window button follows ${mode} behavior without opening a picker`, async (t) => {
    const vscode = createFakeVscode({
      language: 'zh-cn',
      window: { showQuickPick: () => assert.fail('direct mode must not open a menu') },
      commands: {
        'remote-internal.getSshFoldersHistory': () => [
          { remote: 'campus', folder: 'invalid-relative-path' },
          { remote: 'user@campus', folder: '/first' },
          { remote: 'user@campus', folder: '/second' },
        ],
        'opensshremotes.openEmptyWindow': () => true,
        'vscode.openFolder': () => true,
      },
    });
    const { provider } = monitor(t, { vscode, configStore: savedConfigStore({ servers: { remoteWindowMode: mode } }), sidebarState: campus(), hosts: ['campus'] });
    await provider.refreshHosts();
    const view = await openSidebar(provider, vscode);
    view.messages.length = 0;
    vscode.fake.executed.length = 0;
    if (surface === 'list') {
      await view.receive({ version: 1, cmd: 'activateRemoteWindow', host: 'campus' });
      assert.deepEqual(view.messages, [{ cmd: 'remoteWindowActionDone', host: 'campus' }]);
    } else if (surface === 'sidebar') {
      await provider.openRemoteWindowForSidebar();
    } else {
      await openEditor(provider, vscode, campus(), { active: true });
      vscode.fake.executed.length = 0;
      await provider.openRemoteWindowForEditor();
    }
    if (mode === 'new') {
      assert.deepEqual(vscode.fake.executed, [['opensshremotes.openEmptyWindow', { host: 'campus' }]]);
    } else {
      assert.deepEqual(vscode.fake.executed, [
        ['remote-internal.getSshFoldersHistory', 'campus'],
        ['vscode.openFolder', { scheme: 'vscode-remote', authority: 'ssh-remote+user@campus', path: '/first' }, { forceNewWindow: true }],
      ]);
    }
  });
}

test('recent workspace falls back to an empty window when history is empty or unavailable', async (t) => {
  let unavailable = false;
  const vscode = createFakeVscode({ commands: { 'remote-internal.getSshFoldersHistory': () => {
    if (unavailable) throw new Error('history unavailable');
    return [];
  } } });
  const { provider } = monitor(t, { vscode, configStore: savedConfigStore({ servers: { remoteWindowMode: 'recent' } }), hosts: ['campus'] });
  await provider.refreshHosts();
  vscode.fake.executed.length = 0;
  await provider.activateRemoteWindow('campus');
  unavailable = true;
  await provider.activateRemoteWindow('campus');
  await provider.activateRemoteWindow('unknown');
  assert.deepEqual(vscode.fake.executed.filter(([name]) => name !== 'remote-internal.getSshFoldersHistory'), [
    ['opensshremotes.openEmptyWindow', { host: 'campus' }], ['opensshremotes.openEmptyWindow', { host: 'campus' }],
  ]);
});

test('local process display preferences are global, validated and broadcast to every ready view', async (t) => {
  const vscode = createFakeVscode();
  const uiStateStore = createMemento({ 'sysmonitor.processDisplay': { cpu: 'whole', ram: 'invalid' } });
  const { provider } = monitor(t, { vscode, uiStateStore, sidebarState: { ...campus('proc'), processDisplay: { cpu: 'both' } } });
  const initial = { cpu: 'whole', ram: 'size', expandName: false, expandCmd: false };
  const side = await openSidebar(provider, vscode, { ready: false });
  const editor = await openEditor(provider, vscode, campus(), { ready: false });
  for (const target of [side, editor]) assert.deepEqual(readInitialConfig(target.webview.html).processDisplay, initial);
  assert.deepEqual(readInitialConfig(side.webview.html).navigation, campus('proc'));
  await side.receive(READY);
  await editor.receive(READY);
  for (const target of [side, editor]) {
    assert.deepEqual(commandsOf(target.messages, 'uiState')[0].processDisplay, initial);
    target.messages.length = 0;
  }
  await editor.receive({ version: 1, cmd: 'setProcessDisplay', key: 'expandCmd', value: true });
  await side.receive({ version: 1, cmd: 'setProcessDisplay', key: 'cpu', value: 'invalid' });
  await settle();
  const expected = { ...initial, expandCmd: true };
  assert.deepEqual(side.messages, [{ cmd: 'uiState', processDisplay: expected }]);
  assert.deepEqual(editor.messages, [{ cmd: 'uiState', processDisplay: expected }]);
  assert.deepEqual(uiStateStore.writes, [['sysmonitor.processDisplay', expected]]);
});

test('local views use only the webview assets as resource roots', async (t) => {
  const vscode = createFakeVscode();
  const { provider } = monitor(t, { vscode, sidebarState: campus() });
  const options = { enableScripts: true, localResourceRoots: [path.join(__dirname, '..', 'src', 'view', 'assets')] };
  const view = await openSidebar(provider, vscode, { ready: false });
  const panel = await provider.openEditorPanel();
  assert.deepEqual(view.webview.options, options);
  assert.equal(panel, vscode.fake.panels[0]);
  assert.deepEqual(panel.webview.options, options);
});

test('process collection is demanded for devices shown on a visible process page', async (t) => {
  const vscode = createFakeVscode();
  const { provider, manager } = monitor(t, { vscode, sidebarState: { tabs: ['ssh:a', 'ssh:b'], selected: 'ssh:a', page: 'perf' } });
  const view = await openSidebar(provider, vscode);
  assert.deepEqual(manager.demands, []);
  await view.receive({ version: 1, cmd: 'switchPage', page: 'proc' });
  await view.receive({ version: 1, cmd: 'switchDevice', id: 'ssh:b' });
  view.setVisible(false);
  view.setVisible(true);
  assert.deepEqual(manager.demands, [['ssh:a'], ['ssh:b'], [], ['ssh:b']]);
  const panel = await openEditor(provider, vscode, { tabs: ['ssh:a'], selected: 'ssh:a', page: 'proc' }, { active: true });
  assert.deepEqual(manager.demands.slice(4), [['ssh:a', 'ssh:b']]);
  panel.setState({ visible: false });
  panel.dispose();
  await view.receive({ version: 1, cmd: 'switchPage', page: 'servers' });
  assert.deepEqual(manager.demands.slice(5), [['ssh:b'], []]);
});

test('a reshown local sidebar is restored by ready with its device, page, history and dismissed guide', async (t) => {
  const fixture = createSessionFixture({ id: 'ssh:campus', remote: true });
  const device = fixture.session;
  t.after(() => device.dispose());
  await fixture.transport.connect();
  device.start();
  fixture.commit();
  const vscode = createFakeVscode();
  const { provider } = monitor(t, {
    vscode, manager: createDeviceManager({ devices: new Map([['ssh:campus', device]]) }), sidebarState: campus('proc'), hosts: ['campus'],
    uiStateStore: createMemento({ 'sysmonitor.localIntroDismissed': true }),
  });
  await provider.refreshHosts();
  const view = await openSidebar(provider, vscode);
  view.setVisible(false);
  view.messages.length = 0;
  provider.onDeviceUpdate('ssh:campus', device);
  provider.pauseChanged(true);
  view.setVisible(true);
  provider.onDeviceUpdate('ssh:campus', device);
  assert.deepEqual(view.messages, []);
  await view.receive(READY);
  assert.deepEqual(view.messages.map((message) => message.cmd), ['config', 'navigation', 'uiState', 'localIntroDismissed', 'snapshot']);
  assert.deepEqual(view.messages[1].state, campus('proc'));
  const snapshot = view.messages[4];
  assert.equal(snapshot.deviceId, 'ssh:campus');
  assert.equal(snapshot.replaceSamples, true);
  assert.ok(snapshot.samples.length > 0);
  assert.deepEqual(snapshot.samples, device.chartSamples());
  assert.equal(snapshot.viewModel, device.model);
  view.messages.length = 0;
  await view.receive({ version: 1, cmd: 'switchPage', page: 'servers' });
  assert.deepEqual(commandsOf(view.messages, 'servers').map((message) => message.hosts.map((row) => row.host)), [['campus']]);
});

test('server rows are pushed only to a visible sidebar on the server page', async (t) => {
  const failures = ['first failure', 'second failure', 'third failure'];
  const manager = createDeviceManager({ open: () => ({ connect: async () => {
    throw new Error(failures.shift());
  } }) });
  const vscode = createFakeVscode();
  const { provider } = monitor(t, {
    vscode, manager, sidebarState: campus(), hosts: ['campus'],
    scheduleErrorClear: () => ({}), cancelErrorClear() {},
  });
  await provider.refreshHosts();
  const view = await openSidebar(provider, vscode);
  const rowErrors = () => commandsOf(view.messages, 'servers').map((message) => message.hosts[0].error).filter(Boolean);
  const failOpen = () => view.receive({ version: 1, cmd: 'openServer', host: 'campus', inEditor: true });
  await failOpen();
  assert.deepEqual(commandsOf(view.messages, 'servers'), []);
  await view.receive({ version: 1, cmd: 'switchPage', page: 'servers' });
  assert.deepEqual(rowErrors(), ['first failure']);
  await failOpen();
  assert.deepEqual(rowErrors(), ['first failure', 'second failure']);
  view.setVisible(false);
  const delivered = view.messages.length;
  await failOpen();
  assert.equal(view.messages.length, delivered);
  assert.deepEqual(failures, []);
});

test('local views that miss the ready handshake are reloaded once and failed deliveries mark them unready', async (t) => {
  const clock = fakeTimers();
  const logs = [];
  const vscode = createFakeVscode();
  const { provider } = monitor(t, { vscode, sidebarState: campus(), logger: (message) => logs.push(message), ...clock });
  const view = await openSidebar(provider, vscode, { ready: false });
  assert.deepEqual(clock.timers.map((timer) => timer.milliseconds), [10000]);
  const reloaded = view.webview.nextHtml();
  clock.timers[0].callback();
  await reloaded;
  assert.equal(view.webview.htmlHistory.length, 2);
  assert.equal(readInitialConfig(view.webview.html).surface, 'sidebar');
  assert.equal(readInitialConfig(view.webview.html).navigation.selected, 'ssh:campus');
  assert.match(logs.at(-1), /Webview sidebar did not report ready within 10 s/);
  await view.receive(READY);
  view.messages.length = 0;
  view.webview.delivery = () => false;
  provider.pauseChanged(false);
  await settle();
  provider.pauseChanged(false);
  assert.equal(commandsOf(view.messages, 'uiState').length, 1);
  assert.equal(clock.timers.length, 1);
  const panel = await openEditor(provider, vscode, { tabs: ['ssh:lab'], selected: 'ssh:lab', page: 'proc' }, { ready: false, active: true });
  assert.equal(clock.timers.length, 2);
  panel.setState({ visible: false });
  assert.equal(clock.timers[1].cancelled, true);
  panel.setState({ visible: true });
  const editorReloaded = panel.webview.nextHtml();
  clock.timers[2].callback();
  await editorReloaded;
  assert.equal(readInitialConfig(panel.webview.html).surface, 'editor');
  assert.deepEqual(readInitialConfig(panel.webview.html).navigation, { tabs: ['ssh:lab'], selected: 'ssh:lab', page: 'proc' });
});

test('local views log ignored and failed messages and receive retry errors', async (t) => {
  const logs = [];
  const device = {
    viewState: () => null,
    snapshotState: () => ({ deviceId: 'ssh:campus' }),
    retry: async () => {
      throw new Error('collect failed');
    },
  };
  const vscode = createFakeVscode({ commands: { 'workbench.action.openSettings': () => {
    throw new Error('settings unavailable');
  } } });
  const { provider } = monitor(t, {
    vscode, manager: createDeviceManager({ devices: new Map([['ssh:campus', device]]) }), sidebarState: campus(), logger: (message) => logs.push(message),
  });
  const replaced = await openSidebar(provider, vscode, { ready: false });
  const view = await openSidebar(provider, vscode, { ready: false });
  await replaced.receive(READY);
  assert.deepEqual(replaced.messages, []);
  assert.equal(logs.at(-1), 'ignored invalid webview message: ready');
  await view.receive(READY);
  view.messages.length = 0;
  await view.receive({ version: 1, cmd: 'bogus' });
  assert.equal(logs.at(-1), 'ignored invalid webview message: bogus');
  await view.receive({ version: 1, cmd: 'openSettings' });
  assert.equal(logs.at(-1), 'Webview message openSettings failed: settings unavailable');
  await view.receive({ version: 1, cmd: 'retrySampling', deviceId: 'ssh:campus' });
  assert.deepEqual(view.messages, [{ cmd: 'retryConnectionResult', deviceId: 'ssh:campus', error: 'collect failed' }]);
  assert.equal(logs.at(-1), 'Monitor retry ssh:campus: collect failed');
});

test('local pause requests go through the device manager, whose change is broadcast once', async (t) => {
  const vscode = createFakeVscode();
  const { provider, manager } = monitor(t, { vscode, sidebarState: campus() });
  const view = await openSidebar(provider, vscode);
  view.messages.length = 0;
  await view.receive({ version: 1, cmd: 'pause', value: true });
  await view.receive({ version: 1, cmd: 'pause', value: 'yes' });
  assert.deepEqual(manager.pauseRequests, [true]);
  assert.deepEqual(view.messages, []);
  provider.pauseChanged(true);
  assert.deepEqual(view.messages, [{ cmd: 'uiState', paused: true }]);
});

test('restored local editors accept both stored navigation shapes', async (t) => {
  const vscode = createFakeVscode();
  const { provider } = monitor(t, { vscode });
  const wrapped = vscode.fake.createPanel();
  await provider.restoreEditor(wrapped, { navigation: campus('proc') });
  assert.deepEqual(readInitialConfig(wrapped.webview.html).navigation, campus('proc'));
  assert.equal(wrapped.title, 'campus');
  const plain = vscode.fake.createPanel();
  await provider.restoreEditor(plain, { tabs: ['ssh:lab'], selected: 'ssh:lab', page: 'perf' });
  assert.equal(readInitialConfig(plain.webview.html).navigation.selected, 'ssh:lab');
  const empty = vscode.fake.createPanel();
  await provider.restoreEditor(empty, { navigation: {} });
  assert.equal(empty.disposed, true);
  assert.deepEqual(empty.webview.htmlHistory, []);
});
