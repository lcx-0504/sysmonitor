'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ConfigStore } = require('../src/config/config-store');
const { MonitorViewProvider } = require('../src/view/monitor-view-provider');
const { moveMonitorPanelToNewWindow, getMonitorEditorTitle } = require('../src/view/editor-panel');
const { formatStatusBarText } = require('../src/view/status-bar-controller');
const { createFakeVscode, createMemento } = require('./fake-vscode');
const { createSessionFixture } = require('./session-fixture');
const { READY, settle, readInitialConfig, savedConfigStore, fakeTimers, commandsOf } = require('./view-fixture');

const ASSET_ROOT = path.join(__dirname, '..', 'src', 'view', 'assets');
const DEFAULT_DISPLAY = { cpu: 'core', ram: 'size', expandName: false, expandCmd: false };
const MOVE_TO_WINDOW = 'workbench.action.moveEditorToNewWindow';

// A Remote-SSH (single session) monitor wired as extension.js wires it: session updates render the views.
function createRemoteMonitor(t, { vscode = createFakeVscode(), configStore = savedConfigStore(), service = {}, paused = false, ...options } = {}) {
  let provider = null;
  const fixture = createSessionFixture({ service, configStore, paused, onUpdate: () => provider && provider.renderSession() });
  provider = new MonitorViewProvider({ vscode, configStore, session: fixture.session, ...options });
  t.after(() => {
    provider.dispose();
    fixture.session.dispose();
  });
  return { provider, vscode, fixture, session: fixture.session };
}

async function openSidebar({ provider, vscode }, { ready = true, ...viewOptions } = {}) {
  const view = vscode.fake.createView(viewOptions);
  await provider.resolveWebviewView(view);
  if (ready) await view.receive(READY);
  return view;
}

async function openPanel({ provider, vscode }, state, { ready = true, ...panelOptions } = {}) {
  const panel = vscode.fake.createPanel(panelOptions);
  await provider.attachEditor(panel, state);
  if (ready) await panel.receive(READY);
  return panel;
}

// The journal entries that show how a monitor surface moved between the sidebar, editors and windows.
function surfaceActions(vscode) {
  return vscode.fake.journal.flatMap((entry) => {
    if (entry.type === 'command' && entry.command !== 'setContext') return [entry.command];
    if (entry.type === 'reveal' || entry.type === 'dispose' || entry.type === 'show') return [entry.type];
    if (entry.type === 'post' && entry.message.cmd === 'navigatePage') return [entry.message];
    return [];
  });
}

test('remote editor title uses the SSH alias even with no open workspace', async () => {
  const vscode = createFakeVscode({ remoteName: 'ssh-remote', commands: { 'remote-internal.getActiveSshRemote': () => ({ hostName: 'lichenxi_campus' }) } });
  assert.equal(await getMonitorEditorTitle(vscode), 'lichenxi_campus');
  assert.deepEqual(vscode.fake.executed, [['remote-internal.getActiveSshRemote']]);
});

test('remote editor title falls back to plain and encoded remote workspace authorities', async () => {
  for (const authority of ['user@campus', Buffer.from(JSON.stringify({ hostName: 'campus', user: 'user' })).toString('hex')]) {
    const vscode = createFakeVscode({ remoteName: 'ssh-remote', commands: { 'remote-internal.getActiveSshRemote': () => {
      throw new Error('unavailable');
    } } });
    vscode.workspace.workspaceFolders = [{ uri: { scheme: 'vscode-remote', authority: 'ssh-remote+' + authority } }];
    assert.equal(await getMonitorEditorTitle(vscode), 'campus');
  }
  assert.equal(await getMonitorEditorTitle(createFakeVscode()), os.hostname());
});

test('performance and process rows are sent as one snapshot', async (t) => {
  const monitor = createRemoteMonitor(t);
  const view = await openSidebar(monitor);
  view.messages.length = 0;
  monitor.fixture.values.processes = { rows: [{ pid: 42, processKey: '42:1', userName: 'alice', processName: 'python', commandLine: 'python train.py',
    cpuUsagePercent: 3, memoryUsedBytes: 1024, memoryUsagePercent: 1 }], totalCount: 1 };
  monitor.fixture.commit();
  assert.deepEqual(view.messages.map((message) => message.cmd), ['snapshot']);
  assert.equal(view.messages[0].viewModel.performance.cpu.usagePercent, 12);
  assert.deepEqual(view.messages[0].viewModel.processes.map((row) => row.pid), [42]);
});

test('Webview waits for its ready handshake before receiving the latest snapshot', async (t) => {
  const monitor = createRemoteMonitor(t);
  const view = await openSidebar(monitor, { ready: false });
  monitor.fixture.commit();
  assert.deepEqual(view.messages, []);
  await view.receive(READY);
  assert.equal(commandsOf(view.messages, 'snapshot').at(-1).viewModel.performance.cpu.usagePercent, 12);
});

test('ready delivers current configuration, save failure, UI and snapshot after HTML creation', async (t) => {
  const vscode = createFakeVscode({ onSettingUpdate: (section) => {
    if (section === 'sysmonitor') throw new Error('read only');
  } });
  const store = new ConfigStore({ vscode });
  const monitor = createRemoteMonitor(t, { vscode, configStore: store });
  const view = await openSidebar(monitor, { ready: false });
  assert.equal(readInitialConfig(view.webview.html).displayCfg.charts, true);
  store.update('display', [{ path: ['charts'], value: false }]);
  await assert.rejects(store.flush(), /read only/);
  await view.receive(READY);
  const config = commandsOf(view.messages, 'config')[0];
  assert.equal(config.displayCfg.charts, false);
  assert.equal(config.saveState.status, 'error');
  assert.equal(commandsOf(view.messages, 'uiState').length, 1);
  assert.equal(commandsOf(view.messages, 'snapshot').length, 1);
  const writes = vscode.fake.settingWrites.length;
  await view.receive({ version: 1, cmd: 'retryConfigSave' });
  assert.deepEqual(vscode.fake.settingWrites.slice(writes).map(({ section, key }) => [section, key]), [['sysmonitor', 'display']]);
});

test('editor panel preserves the original icon shape with light and dark variants', async (t) => {
  const monitor = createRemoteMonitor(t);
  const panel = await monitor.provider.openEditorPanel();
  assert.equal(panel, monitor.vscode.fake.panels[0]);
  assert.equal(panel.title, os.hostname());
  assert.equal(path.basename(panel.iconPath.light), 'icon-tab-light.svg');
  assert.equal(path.basename(panel.iconPath.dark), 'icon-tab-dark.svg');
  const icons = [panel.iconPath.light, panel.iconPath.dark].map((file) => fs.readFileSync(file, 'utf8'));
  const lineTags = (svg) => [...svg.matchAll(/<line[^>]+\/>/g)].map((match) => match[0]);
  assert.deepEqual(lineTags(icons[0]), lineTags(icons[1]));
  assert.deepEqual(lineTags(icons[0]), lineTags(fs.readFileSync(path.join(__dirname, '..', 'icon.svg'), 'utf8')));
  assert.match(icons[0], /stroke="#424242"/);
  assert.match(icons[1], /stroke="#c5c5c5"/);
});

test('remote Editor actions move the active panel or return to its sidebar', async (t) => {
  const monitor = createRemoteMonitor(t);
  const { provider, vscode } = monitor;
  await openSidebar(monitor);
  const first = await provider.openEditorPanel('proc');
  assert.equal(readInitialConfig(first.webview.html).page, 'proc');
  await first.receive(READY);
  await first.receive({ version: 1, cmd: 'switchPage', page: 'perf' });
  first.setState({ active: false });
  vscode.fake.journal.length = 0;
  await provider.moveActiveEditorToNewWindow();
  assert.deepEqual(surfaceActions(vscode), ['reveal', MOVE_TO_WINDOW, 'reveal']);
  vscode.fake.journal.length = 0;
  await provider.returnActiveEditorToSidebar();
  assert.deepEqual(surfaceActions(vscode), [{ cmd: 'navigatePage', page: 'perf' }, 'show', 'dispose']);
  assert.equal(vscode.fake.panels.length, 1);
});

test('remote Linux settings expose window action switches and update native title contexts', async (t) => {
  const vscode = createFakeVscode();
  const store = new ConfigStore({ vscode });
  const monitor = createRemoteMonitor(t, { vscode, configStore: store });
  const subscription = store.onDidChange(() => {
    monitor.provider.updateActionVisibility();
    monitor.provider.pushConfig();
  });
  t.after(() => subscription.dispose());
  const view = await openSidebar(monitor);
  vscode.fake.journal.length = 0;
  await view.receive({ version: 1, cmd: 'setConfig', key: 'servers', changes: ['editor', 'window'].map((key) => ({ path: ['actions', key], value: false })) });
  const actionContexts = vscode.fake.journal.filter((entry) => entry.command === 'setContext' && entry.args[0].startsWith('sysmonitor.action'));
  assert.deepEqual(actionContexts.map((entry) => entry.args), [
    ['sysmonitor.actionEditorVisible', false],
    ['sysmonitor.actionWindowVisible', false],
  ]);
  const reopened = await openSidebar(monitor, { ready: false });
  const init = readInitialConfig(reopened.webview.html);
  assert.equal(init.serversCfg.actions.editor, false);
  assert.equal(init.serversCfg.actions.window, false);
  await store.flush();
});

test('repeated Editor moves remain sequential and keep the panel in its current window until each move', async () => {
  const complete = [];
  const vscode = createFakeVscode({ commands: { [MOVE_TO_WINDOW]: () => new Promise((resolve) => complete.push(resolve)) } });
  const panel = vscode.fake.createPanel();
  const first = moveMonitorPanelToNewWindow(vscode, panel, { disposeOnError: false });
  const second = moveMonitorPanelToNewWindow(vscode, panel, { disposeOnError: false });
  await settle();
  assert.deepEqual(surfaceActions(vscode), ['reveal', MOVE_TO_WINDOW]);
  complete.shift()();
  await first;
  await settle();
  assert.deepEqual(surfaceActions(vscode), ['reveal', MOVE_TO_WINDOW, 'reveal', 'reveal', MOVE_TO_WINDOW]);
  assert.ok(vscode.fake.journal.filter((entry) => entry.type === 'reveal').every((entry) => entry.args.length === 0));
  complete.shift()();
  await second;
  assert.equal(panel.disposed, false);
});

test('a failed Editor move does not block a later move', async () => {
  let attempts = 0;
  const vscode = createFakeVscode({ commands: { [MOVE_TO_WINDOW]: () => {
    attempts++;
    if (attempts === 1) throw new Error('window move failed');
  } } });
  const panel = vscode.fake.createPanel();
  await assert.rejects(moveMonitorPanelToNewWindow(vscode, panel, { disposeOnError: false }), /window move failed/);
  await moveMonitorPanelToNewWindow(vscode, panel, { disposeOnError: false });
  assert.equal(attempts, 2);
  assert.equal(panel.disposed, false);
});

test('returning to an unready remote sidebar preserves the Editor page', async (t) => {
  const monitor = createRemoteMonitor(t);
  const { provider, vscode } = monitor;
  const view = await openSidebar(monitor, { ready: false });
  await provider.openEditorPanel('proc');
  vscode.fake.journal.length = 0;
  await provider.returnActiveEditorToSidebar();
  assert.deepEqual(surfaceActions(vscode), ['show', 'dispose']);
  assert.deepEqual(view.messages, []);
  await view.receive({ version: 1, cmd: 'ready', page: 'perf' });
  assert.deepEqual(view.messages.at(-1), { cmd: 'navigatePage', page: 'proc' });
  const reopened = await openSidebar(monitor, { ready: false });
  assert.equal(readInitialConfig(reopened.webview.html).page, 'proc');
});

test('returning an Editor without a resolved sidebar reveals the monitor container', async (t) => {
  const monitor = createRemoteMonitor(t);
  const { provider, vscode } = monitor;
  const panel = await provider.openEditorPanel('proc');
  vscode.fake.journal.length = 0;
  await provider.returnActiveEditorToSidebar();
  assert.deepEqual(surfaceActions(vscode), ['workbench.view.extension.sysmonitor-container', 'dispose']);
  assert.equal(panel.disposed, true);
  const view = await openSidebar(monitor, { ready: false });
  assert.equal(readInitialConfig(view.webview.html).page, 'proc');
});

test('remote monitor opens its current page in a native floating window', async (t) => {
  const monitor = createRemoteMonitor(t);
  const view = await openSidebar(monitor);
  await view.receive({ version: 1, cmd: 'switchPage', page: 'proc' });
  monitor.vscode.fake.journal.length = 0;
  const panel = await monitor.provider.openFloatingPanel();
  assert.equal(readInitialConfig(panel.webview.html).page, 'proc');
  assert.equal(readInitialConfig(panel.webview.html).surface, 'editor');
  assert.deepEqual(surfaceActions(monitor.vscode), ['reveal', MOVE_TO_WINDOW, 'reveal']);
});

test('multiple editor panels share snapshots and controls without sharing their lifecycle', async (t) => {
  const monitor = createRemoteMonitor(t);
  const { provider, vscode, fixture, session } = monitor;
  const side = await openSidebar(monitor);
  fixture.commit();
  const panels = [await provider.openEditorPanel(), await provider.openEditorPanel()];
  assert.equal(vscode.fake.panels.length, 2);
  for (const panel of panels) {
    assert.equal(readInitialConfig(panel.webview.html).surface, 'editor');
    await panel.receive(READY);
    assert.deepEqual(commandsOf(panel.messages, 'snapshot').map((message) => message.viewModel.performance.cpu.usagePercent), [12]);
  }
  const targets = [side, ...panels];
  const clear = () => targets.forEach((target) => {
    target.messages.length = 0;
  });

  clear();
  fixture.commit(['cpu']);
  for (const target of targets) assert.deepEqual(target.messages.map((message) => message.cmd), ['snapshot']);

  clear();
  await panels[0].receive({ version: 1, cmd: 'pause', value: true });
  assert.equal(session.isPaused(), true);
  for (const target of targets) assert.equal(target.messages.some((message) => message.cmd === 'uiState' && message.paused === true), true);

  clear();
  provider.pushConfig();
  for (const target of targets) assert.equal(commandsOf(target.messages, 'config').length, 1);

  clear();
  panels[0].dispose();
  fixture.commit(['cpu']);
  assert.deepEqual(panels[0].messages, []);
  assert.equal(commandsOf(panels[1].messages, 'snapshot').length, 1);
  assert.equal(panels[1].disposed, false);
});

test('process display preferences are shared across sidebar and editor clients', async (t) => {
  const uiStateStore = createMemento();
  const monitor = createRemoteMonitor(t, { uiStateStore });
  const view = await openSidebar(monitor);
  const panel = await openPanel(monitor, { page: 'perf' });
  for (const target of [view, panel]) assert.deepEqual(commandsOf(target.messages, 'uiState').map((message) => message.processDisplay), [DEFAULT_DISPLAY]);
  view.messages.length = 0;
  panel.messages.length = 0;
  await view.receive({ version: 1, cmd: 'setProcessDisplay', key: 'cpu', value: 'both' });
  await panel.receive({ version: 1, cmd: 'setProcessDisplay', key: 'ram', value: 'percent' });
  await panel.receive({ version: 1, cmd: 'setProcessDisplay', key: 'expandName', value: true });
  for (const [key, value] of [['cpu', 'bogus'], ['expandCmd', 'yes'], ['other', true], ['ram', true]]) {
    await view.receive({ version: 1, cmd: 'setProcessDisplay', key, value });
  }
  await settle();
  const expected = { cpu: 'both', ram: 'percent', expandName: true, expandCmd: false };
  assert.deepEqual(uiStateStore.writes.map(([key]) => key), ['sysmonitor.processDisplay', 'sysmonitor.processDisplay', 'sysmonitor.processDisplay']);
  assert.deepEqual(uiStateStore.writes.at(-1)[1], expected);
  for (const target of [view, panel]) {
    const broadcasts = commandsOf(target.messages, 'uiState');
    assert.equal(broadcasts.length, 3);
    assert.deepEqual(broadcasts.at(-1).processDisplay, expected);
  }
  const reopened = await openSidebar(monitor, { ready: false });
  assert.deepEqual(readInitialConfig(reopened.webview.html).processDisplay, expected);
});

test('stored process display preferences are validated before use', async (t) => {
  const uiStateStore = createMemento({ 'sysmonitor.processDisplay': { cpu: 'whole', ram: 'invalid', expandName: 'yes', expandCmd: true } });
  const monitor = createRemoteMonitor(t, { uiStateStore });
  const view = await openSidebar(monitor);
  const expected = { cpu: 'whole', ram: 'size', expandName: false, expandCmd: true };
  assert.deepEqual(readInitialConfig(view.webview.html).processDisplay, expected);
  assert.deepEqual(commandsOf(view.messages, 'uiState')[0].processDisplay, expected);
});

test('a process display change that cannot be stored still applies and is logged', async (t) => {
  const logs = [];
  const uiStateStore = createMemento({}, { failUpdate: new Error('global state unavailable') });
  const monitor = createRemoteMonitor(t, { uiStateStore, logger: (message) => logs.push(message) });
  const view = await openSidebar(monitor);
  view.messages.length = 0;
  await view.receive({ version: 1, cmd: 'setProcessDisplay', key: 'expandCmd', value: true });
  await settle();
  assert.deepEqual(view.messages, [{ cmd: 'uiState', processDisplay: { ...DEFAULT_DISPLAY, expandCmd: true } }]);
  assert.deepEqual(logs, ['global state unavailable']);
});

test('a new remote view remains paused while a one-shot retry is collecting', async (t) => {
  const monitor = createRemoteMonitor(t, { paused: true, service: { scheduler: { isPaused: false } } });
  const view = await openSidebar(monitor);
  assert.equal(readInitialConfig(view.webview.html).paused, true);
  assert.equal(commandsOf(view.messages, 'uiState')[0].paused, true);
});

test('remote views load only the webview assets and log unknown messages', async (t) => {
  const logs = [];
  const monitor = createRemoteMonitor(t, { logger: (message) => logs.push(message) });
  const view = await openSidebar(monitor);
  const options = { enableScripts: true, localResourceRoots: [ASSET_ROOT] };
  assert.deepEqual(view.webview.options, options);
  assert.ok(fs.existsSync(path.join(ASSET_ROOT, 'main.mjs')));
  const panel = await monitor.provider.openEditorPanel();
  assert.deepEqual(monitor.vscode.fake.panels.map((created) => created.column), [monitor.vscode.ViewColumn.Active]);
  assert.deepEqual(panel.webview.options, options);
  view.messages.length = 0;
  await view.receive({ version: 1, cmd: 'unknownCommand' });
  assert.deepEqual(view.messages, []);
  assert.equal(logs.at(-1), 'ignored invalid webview message: unknownCommand');
});

test('remote session terminals use the session of the current process row', async (t) => {
  const vscode = createFakeVscode({ language: 'zh-CN' });
  const monitor = createRemoteMonitor(t, { vscode });
  const row = (pid, session) => ({ pid, processKey: pid + ':1', userName: 'alice', processName: 'sh', commandLine: 'sh', cpuUsagePercent: 1,
    memoryUsedBytes: 1024, memoryUsagePercent: 1, session });
  monitor.fixture.values.processes = { rows: [row(7, { type: 'tmux', name: "it's", id: "it's" }), row(8, null)], totalCount: 2 };
  monitor.fixture.commit();
  const view = await openSidebar(monitor);
  await view.receive({ version: 1, cmd: 'openSessionTerminal', deviceId: 'ssh:other', pid: 7, session: { type: 'tmux', name: 'forged', id: 'forged' } });
  assert.equal(vscode.fake.terminals.length, 1);
  const [terminal] = vscode.fake.terminals;
  assert.equal(terminal.shown, true);
  assert.equal(terminal.options.name, "tmux: it's");
  assert.equal(terminal.options.shellPath, '/bin/sh');
  assert.deepEqual(terminal.options.env, { TMUX: null, TMUX_PANE: null });
  assert.match(terminal.options.shellArgs[1], /tmux attach-session -t '=it'\\''s' \|\| printf '%s\\n' '无法连接会话 it'\\''s，它可能已经结束。'/);
  assert.doesNotMatch(terminal.options.shellArgs[1], /forged/);
  for (const pid of [8, 99, '7']) await view.receive({ version: 1, cmd: 'openSessionTerminal', pid });
  assert.equal(vscode.fake.terminals.length, 1);
  assert.deepEqual(vscode.fake.warnings, Array(3).fill(['找不到该进程所在的终端会话，它可能已经结束。']));
});

test('a hidden remote view stops receiving updates and is fully restored by its next ready handshake', async (t) => {
  const monitor = createRemoteMonitor(t);
  const { provider, fixture, session } = monitor;
  session.start();
  const view = await openSidebar(monitor);
  await view.receive({ version: 1, cmd: 'switchPage', page: 'proc' });
  view.setVisible(false);
  view.messages.length = 0;
  fixture.commit();
  provider.pauseChanged(true);
  view.setVisible(true);
  fixture.commit(['cpu']);
  assert.deepEqual(view.messages, []);
  await view.receive({ version: 1, cmd: 'ready', page: 'perf' });
  assert.deepEqual(view.messages.slice(0, 4).map((message) => message.cmd), ['config', 'snapshot', 'uiState', 'navigatePage']);
  const snapshot = view.messages[1];
  assert.equal(snapshot.replaceSamples, true);
  assert.ok(snapshot.samples.length > 0);
  assert.deepEqual(snapshot.samples, session.chartSamples());
  assert.equal(snapshot.viewModel.performance.cpu.usagePercent, 12);
  assert.deepEqual(view.messages[3], { cmd: 'navigatePage', page: 'perf' });
});

test('undelivered messages mark a remote view unready until it reports ready again', async (t) => {
  const monitor = createRemoteMonitor(t);
  const { provider } = monitor;
  const view = await openSidebar(monitor);
  const uiStates = () => commandsOf(view.messages, 'uiState').length;
  view.messages.length = 0;
  view.webview.delivery = () => false;
  provider.pauseChanged(false);
  await settle();
  provider.pauseChanged(false);
  assert.equal(uiStates(), 1);

  view.webview.delivery = () => true;
  await view.receive(READY);
  view.messages.length = 0;
  view.webview.delivery = () => new Error('Webview is disposed');
  provider.pauseChanged(false);
  await settle();
  provider.pauseChanged(false);
  assert.equal(uiStates(), 1);

  let resolveLate;
  view.webview.delivery = () => true;
  await view.receive(READY);
  view.webview.delivery = () => new Promise((resolve) => {
    resolveLate = resolve;
  });
  provider.pauseChanged(false);
  view.webview.delivery = () => true;
  await view.receive(READY);
  resolveLate(false);
  await settle();
  view.messages.length = 0;
  provider.pauseChanged(false);
  assert.equal(uiStates(), 1);
});

test('a remote view that stays silent for ten seconds is reloaded once per visible period', async (t) => {
  const clock = fakeTimers();
  const logs = [];
  const monitor = createRemoteMonitor(t, { logger: (message) => logs.push(message), ...clock });
  const view = await openSidebar(monitor, { ready: false });
  const firstHtml = view.webview.html;
  assert.equal(view.webview.htmlHistory.length, 1);
  assert.deepEqual(clock.timers.map((timer) => timer.milliseconds), [10000]);
  const reloaded = view.webview.nextHtml();
  clock.timers[0].callback();
  await reloaded;
  assert.equal(view.webview.htmlHistory.length, 2);
  assert.notEqual(view.webview.html, firstHtml);
  assert.equal(readInitialConfig(view.webview.html).surface, 'sidebar');
  assert.equal(readInitialConfig(view.webview.html).page, 'perf');
  assert.match(logs.at(-1), /Webview sidebar did not report ready within 10 s/);
  assert.equal(clock.timers.length, 1);
  view.setVisible(false);
  view.setVisible(true);
  assert.equal(clock.timers.length, 2);
  await view.receive(READY);
  assert.equal(clock.timers[1].cancelled, true);
  const panel = await openPanel(monitor, { page: 'proc' }, { ready: false });
  const editorHtml = panel.webview.html;
  const editorReloaded = panel.webview.nextHtml();
  clock.timers[2].callback();
  await editorReloaded;
  assert.notEqual(panel.webview.html, editorHtml);
  assert.equal(readInitialConfig(panel.webview.html).surface, 'editor');
  assert.equal(readInitialConfig(panel.webview.html).page, 'proc');
  const background = await openPanel(monitor, { page: 'perf' }, { ready: false, visible: false });
  assert.equal(clock.timers.length, 3);
  background.setState({ visible: true });
  assert.equal(clock.timers.length, 4);
  background.dispose();
  assert.equal(clock.timers[3].cancelled, true);
});

test('disposing a replaced remote sidebar keeps the current view registered', async (t) => {
  const logs = [];
  const monitor = createRemoteMonitor(t, { logger: (message) => logs.push(message) });
  const first = await openSidebar(monitor, { ready: false });
  const second = await openSidebar(monitor, { ready: false });
  first.dispose();
  await first.receive(READY);
  assert.deepEqual(first.messages, []);
  assert.equal(logs.at(-1), 'ignored invalid webview message: ready');
  await second.receive(READY);
  assert.equal(commandsOf(second.messages, 'config').length, 1);
  second.dispose();
  second.messages.length = 0;
  monitor.provider.pauseChanged(true);
  assert.deepEqual(second.messages, []);
  monitor.vscode.fake.journal.length = 0;
  await monitor.provider.openEditorPanel();
  await monitor.provider.returnActiveEditorToSidebar();
  assert.deepEqual(surfaceActions(monitor.vscode), ['workbench.view.extension.sysmonitor-container', 'dispose']);
});

test('remote views log failed messages and receive retry errors', async (t) => {
  const logs = [];
  const vscode = createFakeVscode({ commands: { 'workbench.action.openSettings': () => {
    throw new Error('settings unavailable');
  } } });
  const monitor = createRemoteMonitor(t, {
    vscode, logger: (message) => logs.push(message),
    service: { async collectOnce() {
      throw new Error('collect failed');
    } },
  });
  const view = await openSidebar(monitor);
  view.messages.length = 0;
  await view.receive({ version: 1, cmd: 'openSettings' });
  assert.deepEqual(vscode.fake.executed, [['workbench.action.openSettings', 'sysmonitor']]);
  assert.equal(logs.at(-1), 'Webview message openSettings failed: settings unavailable');
  await view.receive({ version: 1, cmd: 'retrySampling', deviceId: 'local' });
  assert.deepEqual(commandsOf(view.messages, 'retryConnectionResult'), [{ cmd: 'retryConnectionResult', deviceId: 'local', error: 'collect failed' }]);
  assert.equal(logs.at(-1), 'Monitor retry local: collect failed');
});

test('status bar formatting leaves configured and current-user GPU lists unchanged', () => {
  const cards = [3, 1];
  const mine = [2, 0];
  const gpus = [0, 1, 2, 3].map((idx) => ({ idx, util: 10, memPct: 20, isIdle: false }));
  assert.equal(formatStatusBarText({ gpu: { mode: 'specify', cards, metric: 'util' } }, { gpus }), '$(circuit-board) #1 10% #3 10%');
  assert.equal(formatStatusBarText({ gpu: { mode: 'my', metric: 'util' } }, { gpus }, mine), '$(circuit-board) #0 10% #2 10%');
  assert.deepEqual(cards, [3, 1]);
  assert.deepEqual(mine, [2, 0]);
});
