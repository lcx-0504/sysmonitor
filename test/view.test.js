'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { normalizeConfig } = require('../src/config/normalize-config');
const { WEBVIEW_SCRIPT_FILES } = require('../src/view/webview-html');
const { MonitorViewProvider } = require('../src/view/monitor-view-provider');
const { moveMonitorPanelToNewWindow, getMonitorEditorTitle } = require('../src/view/editor-panel');

const { createSessionFixture } = require('./session-fixture');
function createProvider({ service = {}, configStore = {}, vscode = {}, ...options }) {
  if (!configStore.getSaveState) configStore.getSaveState = () => ({ status: 'saved', error: null });
  if (!configStore.getCurrent) configStore = { ...configStore, getCurrent: () => normalizeConfig({}) };
  if (!vscode.Uri) vscode.Uri = { file: (file) => file };
  const { session } = createSessionFixture({ service, configStore });
  return new MonitorViewProvider({ ...options, vscode, configStore, session });
}

function fakeView({ post = () => {}, visible = true, ...extra } = {}) {
  const view = {
    visible,
    webview: {
      html: '',
      postMessage: (message) => { post(message); return Promise.resolve(true); },
      onDidReceiveMessage(handler) { view.receive = handler; },
    },
    onDidDispose(handler) { view.fireDispose = handler; },
    onDidChangeVisibility(handler) { view.fireVisibility = handler; },
    ...extra,
  };
  return view;
}

function fakePanel({ post = () => {}, visible = true, active = false } = {}) {
  const panel = {
    visible, active,
    webview: {
      html: '',
      postMessage: (message) => { post(message); return Promise.resolve(true); },
      onDidReceiveMessage(handler) { panel.receive = handler; },
    },
    onDidDispose(handler) { panel.fireDispose = handler; },
    onDidChangeViewState(handler) { panel.fireViewState = handler; },
    reveal() {},
    dispose() { panel.fireDispose(); },
  };
  return panel;
}

async function readySidebar(provider, view) {
  await provider.resolveWebviewView(view);
  provider.handleMessage({ version: 1, cmd: 'ready' }, view);
}

const readWebviewScript = () => WEBVIEW_SCRIPT_FILES.map((fileName) => fs.readFileSync(path.join(__dirname, '..', 'src/view/assets', fileName), 'utf8')).join('\n');

test('remote editor title uses the SSH alias even with no open workspace', async () => {
  const vscode = {
    env: { remoteName: 'ssh-remote' },
    commands: { async executeCommand(command) {
      assert.equal(command, 'remote-internal.getActiveSshRemote');
      return { hostName: 'lichenxi_campus' };
    } },
  };
  assert.equal(await getMonitorEditorTitle(vscode), 'lichenxi_campus');
});

test('remote editor title falls back to plain and encoded remote workspace authorities', async () => {
  for (const authority of ['user@campus', Buffer.from(JSON.stringify({ hostName: 'campus', user: 'user' })).toString('hex')]) {
    const title = await getMonitorEditorTitle({
      env: { remoteName: 'ssh-remote' },
      commands: { async executeCommand() { throw new Error('unavailable'); } },
      workspace: { workspaceFolders: [{ uri: { scheme: 'vscode-remote', authority: 'ssh-remote+' + authority } }] },
    });
    assert.equal(title, 'campus');
  }
  assert.equal(await getMonitorEditorTitle({}), os.hostname());
});

test('performance and process rows are sent as one snapshot', async () => {
  const messages = [];
  const provider = createProvider({
    vscode: {},
    service: {},
    configStore: {},
  });
  await readySidebar(provider, fakeView({ post: (message) => messages.push(message) }));
  messages.length = 0;
  const processes = [{ pid: 42 }];
  provider.session.ready = true;
  provider.session.model = { performance: { cpu: { usagePercent: 12 } }, processes };
  provider.renderSession();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].cmd, 'snapshot');
  assert.deepEqual(messages[0].viewModel, { performance: { cpu: { usagePercent: 12 } }, processes });
  const script = readWebviewScript();
  assert.match(script, /data\.cmd !== 'snapshot'/);
  assert.doesNotMatch(script, /cmd:'needProcs'|data\.cmd === 'procs'|data\.cmd !== 'update'/);
});

test('Webview waits for its ready handshake before receiving the latest snapshot', async () => {
  const messages = [];
  const provider = createProvider({ vscode: {}, service: {}, configStore: {} });
  const view = fakeView({ post: (message) => messages.push(message) });
  await provider.resolveWebviewView(view);
  provider.session.model = { performance: { cpu: { usagePercent: 5 } }, processes: [] };
  provider.renderSession();
  assert.equal(messages.length, 0);
  provider.handleMessage({ version: 1, cmd: 'ready' }, view);
  assert.equal(messages.some((message) => message.cmd === 'snapshot'), true);
});

test('ready delivers current configuration, save failure, UI and snapshot after HTML creation', async () => {
  const {ConfigStore}=require('../src/config/config-store');
  const vscode={env:{language:'en'},workspace:{getConfiguration:section=>section==='sysmonitor'?{inspect:()=>({globalValue:undefined}),update:async()=>{throw new Error('read only');}}:{get:()=>[]}}};
  const store=new ConfigStore({vscode});
  const provider=createProvider({vscode,configStore:store});
  await provider.buildHtml();
  store.update('display',[{path:['charts'],value:false}]);await assert.rejects(store.flush(),/read only/);
  const messages=[];
  await readySidebar(provider,fakeView({post:message=>messages.push(message)}));
  const config=messages.find(message=>message.cmd==='config');
  assert.equal(config.displayCfg.charts,false);assert.equal(config.saveState.status,'error');
  assert.ok(messages.some(message=>message.cmd==='uiState'));assert.ok(messages.some(message=>message.cmd==='snapshot'));
  let retry=0;store.flush=async()=>{retry++;};provider.handleMessage({version:1,cmd:'retryConfigSave'});assert.equal(retry,1);
});

test('editor panel preserves the original icon shape with light and dark variants', async () => {
  const panel = { webview: { onDidReceiveMessage() {} }, onDidDispose() {} };
  const provider = createProvider({
    vscode: {
      ViewColumn: { Active: 1 },
      Uri: { file: (file) => file },
      window: { createWebviewPanel: () => panel },
    },
    service: {},
    configStore: {},
  });
  provider.buildHtml = async () => '<html></html>';
  await provider.openEditorPanel();
  assert.equal(panel.title, os.hostname());
  assert.equal(path.basename(panel.iconPath.light), 'icon-tab-light.svg');
  assert.equal(path.basename(panel.iconPath.dark), 'icon-tab-dark.svg');
  const paths = [panel.iconPath.light, panel.iconPath.dark].map((file) => fs.readFileSync(file, 'utf8'));
  const lineTags = (svg) => [...svg.matchAll(/<line[^>]+\/>/g)].map((match) => match[0]);
  assert.deepEqual(lineTags(paths[0]), lineTags(paths[1]));
  assert.deepEqual(lineTags(paths[0]), lineTags(fs.readFileSync(path.join(__dirname, '..', 'icon.svg'), 'utf8')));
  assert.match(paths[0], /stroke="#424242"/);
  assert.match(paths[1], /stroke="#c5c5c5"/);
});

test('remote Editor actions move the active panel or return to its sidebar', async () => {
  const panels = [];
  const commands = [];
  const vscode = {
    ViewColumn: { Active: 1 }, Uri: { file: (file) => file },
    window: { createWebviewPanel: () => {
      const panel = { active: true, webview: { onDidReceiveMessage() {} }, onDidDispose() {}, reveal() { commands.push('reveal'); }, dispose() { commands.push('dispose'); } };
      panels.push(panel);
      return panel;
    } },
    commands: { async executeCommand(command) { commands.push(command); } },
  };
  const provider = createProvider({ vscode, service: {}, configStore: {} });
  provider.buildHtml = async () => '<html></html>';
  await readySidebar(provider, fakeView({ show() { commands.push('show-sidebar'); }, post: (message) => commands.push(message) }));
  const first = await provider.openEditorPanel('proc');
  assert.equal(provider.editorPages.get(first), 'proc');
  provider.handleMessage({ version: 1, cmd: 'switchPage', page: 'perf' }, first);
  assert.equal(provider.editorPages.get(first), 'perf');
  first.active = false;
  await provider.moveActiveEditorToNewWindow();
  assert.deepEqual(commands.slice(-3), ['reveal', 'workbench.action.moveEditorToNewWindow', 'reveal']);
  assert.equal(commands.includes('dispose'), false);
  await provider.returnActiveEditorToSidebar();
  assert.equal(provider.sidebarPage, 'perf');
  assert.deepEqual(commands.slice(-3), [{ cmd: 'navigatePage', page: 'perf' }, 'show-sidebar', 'dispose']);
  assert.equal(panels.length, 1);
});

test('remote Linux settings expose window action switches and update native title contexts', async () => {
  const contexts = [];
  let current = normalizeConfig({});
  let changed;
  const provider = createProvider({
    vscode: { commands: { executeCommand: (...args) => contexts.push(args) } },
    service: { scheduler: { isPaused: false }, readSnapshot: () => ({ accelerators: { value: null } }), updateConfig() {} },
    configStore: {
      getCurrent: () => current,
      update(key, changes) { for (const {path, value} of changes) current[key][path[0]][path[1]] = value; changed(); },
    },
  });
  changed = () => { provider.session.updateConfig(); provider.updateActionVisibility(); provider.pushConfig(); };
  contexts.length = 0;
  provider.handleMessage({ version: 1, cmd: 'setConfig', key: 'servers', changes: ['editor','window'].map(key => ({ path:['actions',key], value:false })) });
  assert.deepEqual(contexts.filter(([command, key]) => command === 'setContext' && key.startsWith('sysmonitor.action')), [
    ['setContext', 'sysmonitor.actionEditorVisible', false],
    ['setContext', 'sysmonitor.actionWindowVisible', false],
  ]);
  const html = await provider.buildHtml();
  const init = JSON.parse(Buffer.from(html.match(/data-config="([A-Za-z0-9+/=]+)"/)[1], 'base64').toString('utf8'));
  assert.equal(init.serversCfg.actions.editor, false);
  assert.equal(init.serversCfg.actions.window, false);
});

test('repeated Editor moves remain sequential and keep the panel in its current window until each move', async () => {
  const calls = [];
  const complete = [];
  const panel = { reveal(...args) { calls.push(['reveal', args.length]); }, dispose() { calls.push(['dispose']); } };
  const vscode = { commands: { executeCommand(command) {
    calls.push(['command', command]);
    return new Promise((resolve) => complete.push(resolve));
  } } };
  const first = moveMonitorPanelToNewWindow(vscode, panel, { disposeOnError: false });
  const second = moveMonitorPanelToNewWindow(vscode, panel, { disposeOnError: false });
  await new Promise(setImmediate);
  assert.deepEqual(calls, [['reveal', 0], ['command', 'workbench.action.moveEditorToNewWindow']]);
  complete.shift()();
  await first;
  await new Promise(setImmediate);
  assert.deepEqual(calls, [
    ['reveal', 0], ['command', 'workbench.action.moveEditorToNewWindow'],
    ['reveal', 0],
    ['reveal', 0], ['command', 'workbench.action.moveEditorToNewWindow'],
  ]);
  complete.shift()();
  await second;
  assert.equal(calls.some(([name]) => name === 'dispose'), false);
});

test('a failed Editor move does not block a later move', async () => {
  let attempts = 0;
  const panel = { reveal() {}, dispose() { throw new Error('existing Editor must stay open'); } };
  const vscode = { commands: { async executeCommand() {
    attempts++;
    if (attempts === 1) throw new Error('window move failed');
  } } };
  await assert.rejects(moveMonitorPanelToNewWindow(vscode, panel, { disposeOnError: false }), /window move failed/);
  await moveMonitorPanelToNewWindow(vscode, panel, { disposeOnError: false });
  assert.equal(attempts, 2);
});

test('returning to an unready remote sidebar preserves the Editor page', async () => {
  const messages = [];
  const provider = createProvider({ vscode: {}, service: { scheduler: { isPaused: false } }, configStore: {} });
  const view = fakeView({ post: (message) => messages.push(message) });
  await provider.resolveWebviewView(view);
  provider.sidebarPage = 'proc';
  provider.pendingSidebarPage = 'proc';
  provider.handleMessage({ version: 1, cmd: 'ready', page: 'perf' }, view);
  assert.equal(provider.sidebarPage, 'proc');
  assert.deepEqual(messages.at(-1), { cmd: 'navigatePage', page: 'proc' });
});

test('remote monitor opens its current page in a native floating window', async () => {
  const calls = [];
  const panel = {
    webview: { onDidReceiveMessage() {} }, onDidDispose() {},
    reveal: (column) => calls.push(['reveal', column]),
    dispose: () => calls.push(['dispose']),
  };
  const provider = createProvider({
    vscode: {
      ViewColumn: { Active: 1 }, Uri: { file: (file) => file },
      window: { createWebviewPanel: () => panel },
      commands: { executeCommand: async (command) => calls.push(['command', command]) },
    },
    service: {}, configStore: {},
  });
  const view = fakeView();
  await provider.resolveWebviewView(view);
  provider.handleMessage({ version: 1, cmd: 'switchPage', page: 'proc' }, view);
  provider.buildHtml = async (page) => `<html>${page}</html>`;
  calls.length = 0;
  await provider.openFloatingPanel();
  assert.equal(panel.webview.html, '<html>proc</html>');
  assert.deepEqual(calls, [['reveal', undefined], ['command', 'workbench.action.moveEditorToNewWindow'], ['reveal', undefined]]);
});

test('multiple editor panels share snapshots and controls without sharing their lifecycle', async () => {
  const messages = [];
  const panels = [];
  const side = fakeView({ post: (message) => messages.push(['side', message]) });
  const provider = createProvider({
    vscode: {
      ViewColumn: { Active: 1 },
      Uri: { file: (file) => file },
      window: {
        createWebviewPanel: () => {
          const panel = {
            webview: {
              onDidReceiveMessage(handler) { this.receive = handler; },
              postMessage: (message) => messages.push([panel, message]),
            },
            onDidDispose(handler) { this.dispose = handler; },
          };
          panels.push(panel);
          return panel;
        },
      },
    },
    service: {
      scheduler: { isPaused: false },
      readSnapshot: () => ({ accelerators: { value: null } }),
      pause() { this.scheduler.isPaused = true; },
      resume() { this.scheduler.isPaused = false; },
    },
    configStore: { getCurrent: () => ({ refreshInterval: 2, statusBar: {}, disk: {}, display: {} }) },
  });
  provider.buildHtml = async () => '<html></html>';
  await readySidebar(provider, side);
  provider.session.model = { performance: { cpu: { usagePercent: 5 } }, processes: [{ pid: 42 }] };
  provider.session.ready = true;

  await provider.openEditorPanel();
  await provider.openEditorPanel();
  assert.equal(panels.length, 2);
  assert.equal(provider.editorPanels.size, 2);
  assert.equal(panels[0].webview.html, '<html></html>');
  assert.equal(panels[1].webview.html, '<html></html>');
  panels[0].webview.receive({ version: 1, cmd: 'ready' });
  panels[1].webview.receive({ version: 1, cmd: 'ready' });
  for (const panel of panels) {
    assert.deepEqual(messages.filter(([target, message]) => target === panel && message.cmd === 'snapshot').map(([, message]) => message.viewModel.performance), [{ cpu: { usagePercent: 5 } }]);
  }

  messages.length = 0;
  provider.renderSession();
  for (const target of [side, ...panels]) {
    const name = target === side ? 'side' : target;
    assert.deepEqual(messages.filter(([recipient]) => recipient === name).map(([, message]) => message.cmd), ['snapshot']);
  }

  messages.length = 0;
  panels[0].webview.receive({ version: 1, cmd: 'pause', value: true });
  assert.equal(provider.session.service.scheduler.isPaused, true);
  for (const target of ['side', ...panels]) {
    assert.equal(messages.some(([recipient, message]) => recipient === target && message.cmd === 'uiState' && message.paused === true), true);
  }

  messages.length = 0;
  provider.pushConfig();
  for (const target of ['side', ...panels]) {
    assert.equal(messages.filter(([recipient, message]) => recipient === target && message.cmd === 'config').length, 1);
  }

  messages.length = 0;
  panels[0].dispose();
  assert.equal(provider.editorPanels.size, 1);
  provider.renderSession();
  assert.equal(messages.some(([recipient]) => recipient === panels[0]), false);
  assert.equal(messages.some(([recipient, message]) => recipient === panels[1] && message.cmd === 'snapshot'), true);
});

test('process display preferences are shared across sidebar and editor clients', async () => {
  const updates = [];
  const messages = [];
  const provider = createProvider({
    vscode: {}, service: {}, configStore: {},
    uiStateStore: { get: () => ({}), update: async (key, value) => { updates.push([key, value]); } },
  });
  provider.buildHtml = async () => '<html></html>';
  const view = fakeView({ post: (message) => messages.push(['side', message]) });
  await readySidebar(provider, view);
  const panel = fakePanel({ post: (message) => messages.push(['editor', message]) });
  await provider.attachEditorPanel(panel);
  panel.receive({ version: 1, cmd: 'ready' });
  assert.deepEqual(messages.filter(([, message]) => message.cmd === 'uiState').map(([, message]) => message.processDisplay), [
    { cpu: 'core', ram: 'size', expandName: false, expandCmd: false },
    { cpu: 'core', ram: 'size', expandName: false, expandCmd: false },
  ]);
  messages.length = 0;
  provider.handleMessage({ version:1, cmd: 'setProcessDisplay', key: 'cpu', value: 'both' }, view);
  provider.handleMessage({ version:1, cmd: 'setProcessDisplay', key: 'ram', value: 'percent' }, panel);
  provider.handleMessage({ version:1, cmd: 'setProcessDisplay', key: 'expandName', value: true }, panel);
  for (const [key, value] of [['cpu', 'bogus'], ['expandCmd', 'yes'], ['other', true], ['ram', true]]) {
    provider.handleMessage({ version:1, cmd: 'setProcessDisplay', key, value }, view);
  }
  await new Promise((resolve) => setImmediate(resolve));
  const expected = { cpu: 'both', ram: 'percent', expandName: true, expandCmd: false };
  assert.deepEqual(provider.processDisplay.get(), expected);
  assert.deepEqual(updates.map(([key]) => key), ['sysmonitor.processDisplay', 'sysmonitor.processDisplay', 'sysmonitor.processDisplay']);
  assert.deepEqual(updates.at(-1)[1], expected);
  const broadcasts = messages.filter(([, message]) => message.cmd === 'uiState');
  assert.equal(broadcasts.length, 6);
  assert.deepEqual(broadcasts.slice(-2).map(([target, message]) => [target, message.processDisplay]), [['side', expected], ['editor', expected]]);
  const html = await MonitorViewProvider.prototype.buildHtml.call(provider);
  assert.deepEqual(JSON.parse(Buffer.from(html.match(/data-config="([A-Za-z0-9+/=]+)"/)[1], 'base64').toString('utf8')).processDisplay, expected);
});

test('stored process display preferences are validated before use', () => {
  const provider = createProvider({
    vscode: {}, uiStateStore: { get: () => ({ cpu: 'whole', ram: 'invalid', expandName: 'yes', expandCmd: true }), update: async () => {} },
  });
  assert.deepEqual(provider.processDisplay.get(), { cpu: 'whole', ram: 'size', expandName: false, expandCmd: true });
});

test('a new remote view remains paused while a one-shot retry is collecting', async () => {
  const provider = createProvider({ vscode: {} });
  provider.session.paused = true;
  provider.session.service.scheduler.isPaused = false;
  const html = await provider.buildHtml();
  const config = JSON.parse(Buffer.from(html.match(/data-config="([A-Za-z0-9+/=]+)"/)[1], 'base64').toString('utf8'));
  assert.equal(config.paused, true);
  const messages = [];
  await readySidebar(provider, fakeView({ post: (message) => messages.push(message) }));
  assert.equal(messages.find((message) => message.cmd === 'uiState').paused, true);
});
