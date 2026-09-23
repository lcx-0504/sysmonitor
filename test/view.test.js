'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { formatStatusBarText } = require('../src/view/status-bar-controller');
const { getWebviewHtml } = require('../src/view/webview-html');
const { MonitorViewProvider } = require('../src/view/monitor-view-provider');
const { buildLegacyViewModel, displayDeviceName } = require('../src/services/legacy-view-model');

test('status bar consumes shared idle decisions instead of recomputing thresholds', () => {
  const text = formatStatusBarText({ cpu: false, ram: false, disk: false, diskIO: 'off', net: 'off', ssh: false, gpu: { summary: true, showIdleIds: true, mode: 'off' } }, {
    gpus: [{ idx: 0, isIdle: true }, { idx: 1, isIdle: false }],
  });
  assert.equal(text, '$(circuit-board) 1/2 (0)');
});

test('status bar uses client-perspective SSH upload and download strings consistently', () => {
  const text = formatStatusBarText({ cpu: false, ram: false, disk: false, diskIO: 'off', net: 'off', ssh: true, gpu: { summary: false, mode: 'off' } }, {
    ssh: { isSSH: true, txStr: '2 KB/s', rxStr: '3 KB/s' }, gpus: [],
  });
  assert.equal(text, 'SSH ↑2 KB/s ↓3 KB/s');
});

test('combined network mode displays the combined rate instead of upload only', () => {
  const text = formatStatusBarText({ cpu: false, ram: false, disk: false, diskIO: 'off', net: 'combined', ssh: false, gpu: { summary: false, mode: 'off' } }, {
    net: { txStr: '2 KB/s', rxStr: '3 KB/s', totalStr: '5 KB/s' }, gpus: [],
  });
  assert.equal(text, '↕5 KB/s');
});

test('Webview HTML loads split assets with a nonce and transports config without raw interpolation', async () => {
  const html = await getWebviewHtml({ initConfig: { unsafe: '\"><script>x</script>' }, nonce: 'test-nonce' });
  assert.match(html, /<style nonce="test-nonce">/);
  assert.match(html, /<script nonce="test-nonce">/);
  assert.match(html, /script-src 'nonce-test-nonce'/);
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /data-config="[A-Za-z0-9+/=]+"/);
  assert.match(html, /gpu-name-text-/);
});

test('performance and process rows are sent as separate messages', () => {
  const messages = [];
  const provider = new MonitorViewProvider({
    vscode: {},
    monitorService: {},
    configStore: {},
  });
  provider.view = { webview: { postMessage: async (message) => { messages.push(message); return true; } } };
  provider.isReady = true;
  const processes = [{ pid: 42 }];
  provider.renderViewModel({ payload: { cpu: 12 }, processes });
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], { cmd: 'update', payload: { cpu: 12 } });
  assert.deepEqual(messages[1], { cmd: 'procs', data: processes });
});

test('Webview waits for its ready handshake before receiving the latest snapshot', () => {
  const messages = [];
  const provider = new MonitorViewProvider({ vscode: {}, monitorService: {}, configStore: {} });
  provider.view = { webview: { postMessage: async (message) => { messages.push(message); return true; } } };
  provider.lastViewModel = { payload: { cpu: 5 }, processes: [] };
  provider.renderViewModel(provider.lastViewModel);
  assert.equal(messages.length, 0);
  provider.handleMessage({ version: 1, cmd: 'ready' });
  assert.equal(messages.some((message) => message.cmd === 'update'), true);
});

test('editor panel uses the extension icon in its tab', async () => {
  const panel = { webview: { onDidReceiveMessage() {} }, onDidDispose() {} };
  const provider = new MonitorViewProvider({
    vscode: {
      ViewColumn: { Active: 1 },
      Uri: { file: (filePath) => ({ fsPath: filePath }) },
      window: { createWebviewPanel: () => panel },
    },
    monitorService: {},
    configStore: {},
  });
  provider.buildHtml = async () => '<html></html>';
  await provider.openEditorPanel();
  assert.equal(panel.iconPath.fsPath, path.join(__dirname, '..', 'icon.svg'));
});

test('multiple editor panels share snapshots and controls without sharing their lifecycle', async () => {
  const messages = [];
  const panels = [];
  const side = { webview: { postMessage: (message) => messages.push(['side', message]) } };
  const provider = new MonitorViewProvider({
    vscode: {
      ViewColumn: { Active: 1 },
      Uri: { file: (filePath) => ({ fsPath: filePath }) },
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
    monitorService: {
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
  provider.lastViewModel = { payload: { cpu: 5 }, processes: [{ pid: 42 }] };

  await provider.openEditorPanel();
  await provider.openEditorPanel();
  assert.equal(panels.length, 2);
  assert.equal(provider.editorPanels.size, 2);
  assert.equal(panels[0].webview.html, '<html></html>');
  assert.equal(panels[1].webview.html, '<html></html>');
  panels[0].webview.receive({ version: 1, cmd: 'ready' });
  panels[1].webview.receive({ version: 1, cmd: 'ready' });
  for (const panel of panels) {
    assert.deepEqual(messages.filter(([target, message]) => target === panel && message.cmd === 'update').map(([, message]) => message.payload), [{ cpu: 5 }]);
  }

  messages.length = 0;
  provider.renderViewModel(provider.lastViewModel);
  for (const target of [side, ...panels]) {
    const name = target === side ? 'side' : target;
    assert.deepEqual(messages.filter(([recipient]) => recipient === name).map(([, message]) => message.cmd), ['update', 'procs']);
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
  provider.renderViewModel(provider.lastViewModel);
  assert.equal(messages.some(([recipient]) => recipient === panels[0]), false);
  assert.equal(messages.some(([recipient, message]) => recipient === panels[1] && message.cmd === 'update'), true);
});

test('view model combines GPU users, CPU denominator and SSH latency', () => {
  const gib = 1024 ** 3;
  const device = { nativeIndex: 0, name: 'NVIDIA H100 80GB HBM3', providerDeviceId: 'uuid', deviceKey: 'nvidia:uuid', utilizationPercent: 70, memory: { usedBytes: 3 * gib, totalBytes: 80 * gib }, temperatureCelsius: 45, power: null };
  const processes = [
    { pid: 7, processKey: '7:1', userName: 'alice', processName: 'python', commandLine: 'python train.py', cpuUsagePercent: 200, memoryUsedBytes: 2 * gib, memoryUsagePercent: 12.5 },
    { pid: 8, processKey: '8:1', userName: 'bob', processName: 'python', commandLine: 'python eval.py', cpuUsagePercent: 5, memoryUsedBytes: gib, memoryUsagePercent: 6.25 },
  ];
  const snapshot = {
    cpu: { value: { usagePercent: 10, coreCount: 16, loadAverage: { oneMinute: 1, fiveMinutes: 2, fifteenMinutes: 3 } } },
    memory: { value: { usagePercent: 20, usedBytes: 4 * gib, availableBytes: 16 * gib, totalBytes: 20 * gib } },
    processes: { value: processes },
    sshTraffic: { value: { isSsh: true, clientUploadBytesPerSecond: 1024, clientDownloadBytesPerSecond: 0, latencyMilliseconds: 12.25 } },
    accelerators: { value: { devices: [device], usagesByPid: new Map([[7, [{ nativeIndex: 0, deviceKey: 'nvidia:uuid', memoryUsedBytes: 2 * gib, memoryTotalBytes: 80 * gib, processKey: '7:1' }]], [8, [{ nativeIndex: 0, deviceKey: 'nvidia:uuid', memoryUsedBytes: gib, memoryTotalBytes: 80 * gib, processKey: '8:1' }]]]), currentUserDeviceKeys: ['nvidia:uuid'] } },
  };
  const model = buildLegacyViewModel(snapshot, 'en');
  assert.equal(model.payload.gpus[0].displayName, 'H100 80GB HBM3');
  assert.equal(model.payload.gpus[0].isMine, true);
  assert.equal(model.payload.gpus[0].memTotalStr, '80.0 G');
  assert.deepEqual(model.payload.gpus[0].users.map((user) => user.name), ['alice', 'bob']);
  assert.equal(model.payload.gpus[0].users[0].usedStr, '2.0G');
  assert.equal(model.payload.gpus[0].users[0].percent, 2.5);
  assert.equal(model.payload.ssh.latencyStr, '12.3 ms');
  assert.equal(model.processes.find((row) => row.pid === 7).cpuWhole, 12.5);
});

test('GPU display name removes only vendor and marketing prefixes', () => {
  assert.equal(displayDeviceName('NVIDIA A100-SXM4-80GB'), 'A100-SXM4-80GB');
  assert.equal(displayDeviceName('NVIDIA GeForce RTX 4090 D'), 'RTX 4090 D');
  assert.equal(displayDeviceName('NVIDIA Tesla V100-SXM2-32GB'), 'V100-SXM2-32GB');
  assert.equal(displayDeviceName('AMD Radeon RX 7900 XTX'), 'AMD Radeon RX 7900 XTX');
});

test('spark area grows from real samples, then interpolates the left boundary after the window fills', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview.js'), 'utf8');
  const geometry = script.slice(script.indexOf('  function sparkDisplayTime('), script.indexOf('  function renderSpark('));
  const history = script.slice(script.indexOf('  function pushHist('), script.indexOf('  // ── 消息处理'));
  let now = 2000;
  const context = { Date: { now: () => now }, curInterval: 2, SPARK_WINDOW: 600000 };
  vm.runInNewContext(`${geometry}\n${history}\nthis.geometry = { sparkPaths, pushHist };`, context);
  const warming = [{ t: 0, v: 20 }, { t: 2000, v: 40 }];
  assert.match(context.geometry.sparkPaths(warming, 100).area, /^M100\.0000,80\.0L/);
  now = 4000;
  assert.match(context.geometry.sparkPaths(warming, 100).area, /^M99\.6667,80\.0L/);

  context.SPARK_WINDOW = 1000;
  now = 5000;
  const points = [{ t: 1000, v: 10 }, { t: 3000, v: 30 }, { t: 5000, v: 50 }];
  assert.match(context.geometry.sparkPaths(points, 100).area, /^M0,80\.0L/);
  now = 7000;
  assert.match(context.geometry.sparkPaths(points, 100).area, /^M0,60\.0L/);
  now = 5000;
  assert.match(context.geometry.sparkPaths(points.slice(1), 100).area, /^M100\.0000,70\.0L/);

  now = 10000;
  context.SPARK_WINDOW = 6000;
  const retained = [{ t: 1000, v: 10 }, { t: 3000, v: 30 }, { t: 5000, v: 50 }, { t: 7000, v: 70 }, { t: 9000, v: 90 }];
  context.geometry.pushHist(retained, 100);
  assert.equal(retained[0].t, 1000);
});

test('process display preferences are shared across sidebar and editor clients', async () => {
  const updates = [];
  const messages = [];
  const provider = new MonitorViewProvider({
    vscode: {}, monitorService: {}, configStore: {},
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
