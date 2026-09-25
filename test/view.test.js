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
function createProvider({ service = {}, configStore = {}, ...options }) {
  if (!configStore.getCurrent) configStore = { ...configStore, getCurrent: () => normalizeConfig({}) };
  const { session } = createSessionFixture({ service, configStore });
  return new MonitorViewProvider({ ...options, configStore, session });
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

test('performance and process rows are sent as one snapshot', () => {
  const messages = [];
  const provider = createProvider({
    vscode: {},
    service: {},
    configStore: {},
  });
  provider.view = { webview: { postMessage: async (message) => { messages.push(message); return true; } } };
  provider.isReady = true;
  const processes = [{ pid: 42 }];
  provider.session.model = { performance: { cpu: { usagePercent: 12 } }, processes };
  provider.renderSession();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].cmd, 'snapshot');
  assert.deepEqual(messages[0].viewModel, { performance: { cpu: { usagePercent: 12 } }, processes });
  const script = readWebviewScript();
  assert.match(script, /data\.cmd !== 'snapshot'/);
  assert.doesNotMatch(script, /cmd:'needProcs'|data\.cmd === 'procs'|data\.cmd !== 'update'/);
  const receiveSnapshot = script.slice(script.indexOf("    if (data.cmd !== 'snapshot')"), script.indexOf("    document.getElementById('cpu-val')"));
  assert.ok(receiveSnapshot.indexOf('setLang(performance.language)') < receiveSnapshot.indexOf('renderProcTable()'));
});

test('Webview waits for its ready handshake before receiving the latest snapshot', () => {
  const messages = [];
  const provider = createProvider({ vscode: {}, service: {}, configStore: {} });
  provider.view = { webview: { postMessage: async (message) => { messages.push(message); return true; } } };
  provider.session.model = { performance: { cpu: { usagePercent: 5 } }, processes: [] };
  provider.renderSession();
  assert.equal(messages.length, 0);
  provider.handleMessage({ version: 1, cmd: 'ready' });
  assert.equal(messages.some((message) => message.cmd === 'snapshot'), true);
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
  provider.view = { show() { commands.push('show-sidebar'); }, webview: { postMessage(message) { commands.push(message); } } };
  provider.isReady = true;
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
  const provider = createProvider({
    vscode: { commands: { executeCommand: (...args) => contexts.push(args) } },
    service: { scheduler: { isPaused: false }, readSnapshot: () => ({ accelerators: { value: null } }), updateConfig() {} },
    configStore: {
      getCurrent: () => current,
      update(key, value) { current = normalizeConfig({ ...current, [key]: value }); },
    },
  });
  contexts.length = 0;
  provider.handleMessage({ version: 1, cmd: 'setConfig', key: 'servers', value: { actions: { editor: false, window: false } } });
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

test('returning to an unready remote sidebar preserves the Editor page', () => {
  const messages = [];
  const provider = createProvider({ vscode: {}, service: { scheduler: { isPaused: false } }, configStore: {} });
  const view = { webview: { postMessage(message) { messages.push(message); } } };
  provider.view = view;
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
  provider.view = {};
  provider.handleMessage({ version: 1, cmd: 'switchPage', page: 'proc' }, provider.view);
  provider.buildHtml = async (page) => `<html>${page}</html>`;
  calls.length = 0;
  await provider.openFloatingPanel();
  assert.equal(panel.webview.html, '<html>proc</html>');
  assert.deepEqual(calls, [['reveal', undefined], ['command', 'workbench.action.moveEditorToNewWindow'], ['reveal', undefined]]);
});

test('multiple editor panels share snapshots and controls without sharing their lifecycle', async () => {
  const messages = [];
  const panels = [];
  const side = { webview: { postMessage: (message) => messages.push(['side', message]) } };
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
  provider.view = side;
  provider.isReady = true;
  provider.session.model = { performance: { cpu: { usagePercent: 5 } }, processes: [{ pid: 42 }] };

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
  assert.equal(provider.monitorService.scheduler.isPaused, true);
  for (const target of ['side', ...panels]) {
    assert.equal(messages.some(([recipient, message]) => recipient === target && message.cmd === 'uiState' && message.paused === true), true);
  }

  messages.length = 0;
  provider.pushConfig(panels[0]);
  assert.equal(messages.some(([recipient, message]) => recipient === panels[0] && message.cmd === 'config'), false);
  assert.equal(messages.some(([recipient, message]) => recipient === panels[1] && message.cmd === 'config'), true);

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
  provider.view = { webview: { postMessage: (message) => messages.push(['side', message]) } };
  provider.editorPanels.set({ webview: { postMessage: (message) => messages.push(['editor', message]) } }, true);
  provider.isReady = true;
  provider.handleMessage({ cmd: 'setProcessDisplay', key: 'cpu', value: 'both' });
  provider.handleMessage({ cmd: 'setProcessDisplay', key: 'ram', value: 'percent' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(provider.getUiState(), { cpu: 'both', ram: 'percent' });
  assert.equal(updates.length, 2);
  assert.equal(messages.filter(([, message]) => message.cmd === 'uiState').length, 4);
});

test('a new remote view remains paused while a one-shot retry is collecting', async () => {
  const provider = createProvider({ vscode: {} });
  provider.session.paused = true;
  provider.session.service.scheduler.isPaused = false;
  const html = await provider.buildHtml();
  const config = JSON.parse(Buffer.from(html.match(/data-config="([A-Za-z0-9+/=]+)"/)[1], 'base64').toString('utf8'));
  assert.equal(config.paused, true);
  const messages = [];
  provider.view = { webview: { postMessage: (message) => messages.push(message) } };
  provider.handleMessage({ version: 1, cmd: 'ready' }, provider.view);
  assert.equal(messages.find((message) => message.cmd === 'uiState').paused, true);
});
