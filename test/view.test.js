'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { formatStatusBarText } = require('../src/view/status-bar-controller');
const { getWebviewHtml, WEBVIEW_SCRIPT_FILES } = require('../src/view/webview-html');
const { MonitorViewProvider } = require('../src/view/monitor-view-provider');
const { buildMonitorViewModel, displayDeviceName } = require('../src/services/monitor-view-model');
const readWebviewScript = () => WEBVIEW_SCRIPT_FILES.map((fileName) => fs.readFileSync(path.join(__dirname, '..', 'src/view/assets', fileName), 'utf8')).join('\n');

test('status bar consumes shared idle decisions instead of recomputing thresholds', () => {
  const text = formatStatusBarText({ cpu: false, ram: false, disk: false, diskIO: 'off', net: 'off', ssh: false, gpu: { summary: true, showIdleIds: true, mode: 'off' } }, {
    gpus: [{ idx: 0, isIdle: true }, { idx: 1, isIdle: false }],
  });
  assert.equal(text, '$(circuit-board) 1/2 (0)');
});

test('status bar uses client-perspective SSH upload and download strings consistently', () => {
  const text = formatStatusBarText({ cpu: false, ram: false, disk: false, diskIO: 'off', net: 'off', ssh: true, gpu: { summary: false, mode: 'off' } }, {
    sshTraffic: { isSsh: true, uploadText: '2 KB/s', downloadText: '3 KB/s' }, gpus: [],
  });
  assert.equal(text, 'SSH ↑2 KB/s ↓3 KB/s');
});

test('combined network mode displays the combined rate instead of upload only', () => {
  const text = formatStatusBarText({ cpu: false, ram: false, disk: false, diskIO: 'off', net: 'combined', ssh: false, gpu: { summary: false, mode: 'off' } }, {
    network: { transmitText: '2 KB/s', receiveText: '3 KB/s', totalText: '5 KB/s' }, gpus: [],
  });
  assert.equal(text, '↕5 KB/s');
});

test('status bar GPU detail uses the shared rounded memory percentage', () => {
  const text = formatStatusBarText({ cpu: false, ram: false, disk: false, diskIO: 'off', net: 'off', ssh: false, gpu: { summary: false, mode: 'all', metric: 'vram' } }, {
    gpus: [{ idx: 6, memPct: 90, isIdle: false }],
  });
  assert.equal(text, '$(circuit-board) #6 90%V');
});

test('Webview HTML loads split assets with a nonce and transports config without raw interpolation', async () => {
  const html = await getWebviewHtml({ initConfig: { unsafe: '\"><script>x</script>' }, nonce: 'test-nonce' });
  assert.match(html, /<style nonce="test-nonce">/);
  assert.match(html, /<script nonce="test-nonce">/);
  assert.match(html, /script-src 'nonce-test-nonce'/);
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /data-config="[A-Za-z0-9+/=]+"/);
  assert.match(html, /gpu-name-text-/);
  assert.match(html, /id="modal-scrollbar" aria-hidden="true" hidden/);
  assert.equal((html.match(/<script nonce="test-nonce">/g) || []).length, 1);
  assert.ok(html.indexOf('function applyGroupVisibility') < html.indexOf('function openModal'));
  assert.ok(html.indexOf('function openModal') < html.indexOf('function renderProcTable'));
  assert.doesNotThrow(() => new vm.Script(html.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/)[1]));
});

test('settings use content-sized controls and an overlay scrollbar', () => {
  const style = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview.css'), 'utf8');
  const script = readWebviewScript();
  assert.match(style, /\.setting-control\s*\{[^}]*flex:\s*0 0 auto;/);
  assert.match(style, /\.setting-control\.wide\s*\{[^}]*width:\s*55%;/);
  assert.match(style, /\.modal-body\s*\{[^}]*scrollbar-width:\s*none;/);
  assert.match(style, /\.modal-body::-webkit-scrollbar\s*\{[^}]*width:\s*0;/);
  assert.match(style, /\.modal-scrollbar\s*\{[^}]*position:\s*absolute;\s*right:\s*0;/);
  assert.match(style, /\.modal-scrollbar-thumb\s*\{[^}]*margin-right:\s*0;/);
  assert.match(script, /T\.diskExcludePath[^\n]*T\.diskExcludePathTip, true\)/);

  const scrollbarCode = script.slice(script.indexOf("  var modalBody = document.getElementById('modal-body');"), script.indexOf('  function openModal()'));
  const body = { clientHeight: 100, scrollHeight: 400, scrollTop: 0, offsetTop: 30, addEventListener() {} };
  const handlers = {};
  const track = { hidden: true, style: {}, classList: { add() {}, remove() {} }, addEventListener(name, handler) { handlers[name] = handler; }, getBoundingClientRect: () => ({ top: 30, height: 100 }), setPointerCapture() {}, hasPointerCapture: () => false };
  const thumb = { style: {}, offsetHeight: 28, getBoundingClientRect: () => ({ top: 30, height: 28 }) };
  const elements = { 'modal-body': body, 'modal-scrollbar': track, 'modal-scrollbar-thumb': thumb };
  const context = { document: { getElementById: (id) => elements[id] }, window: { addEventListener() {} }, modalOpen: true };
  vm.runInNewContext(`${scrollbarCode}\nthis.updateModalScrollbar = updateModalScrollbar;`, context);
  context.updateModalScrollbar();
  assert.equal(track.hidden, false);
  assert.equal(track.style.top, '30px');
  assert.equal(track.style.height, '100px');
  assert.equal(thumb.style.height, '28px');
  body.scrollTop = 150;
  context.updateModalScrollbar();
  assert.equal(thumb.style.transform, 'translateY(36px)');
  handlers.pointerdown({ target: thumb, clientY: 35, pointerId: 1, preventDefault() {} });
  handlers.pointermove({ clientY: 71, pointerId: 1 });
  assert.equal(body.scrollTop, 150);
  handlers.pointerup({ pointerId: 1 });
  body.scrollHeight = 100;
  context.updateModalScrollbar();
  assert.equal(track.hidden, true);
});

test('performance and process rows are sent as one snapshot', () => {
  const messages = [];
  const provider = new MonitorViewProvider({
    vscode: {},
    monitorService: {},
    configStore: {},
  });
  provider.view = { webview: { postMessage: async (message) => { messages.push(message); return true; } } };
  provider.isReady = true;
  const processes = [{ pid: 42 }];
  provider.renderViewModel({ performance: { cpu: { usagePercent: 12 } }, processes });
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { cmd: 'snapshot', viewModel: { performance: { cpu: { usagePercent: 12 } }, processes } });
  const script = readWebviewScript();
  assert.match(script, /data\.cmd !== 'snapshot'/);
  assert.doesNotMatch(script, /cmd:'needProcs'|data\.cmd === 'procs'|data\.cmd !== 'update'/);
  const receiveSnapshot = script.slice(script.indexOf("    if (data.cmd !== 'snapshot')"), script.indexOf("    document.getElementById('cpu-val')"));
  assert.ok(receiveSnapshot.indexOf('setLang(performance.language)') < receiveSnapshot.indexOf('renderProcTable()'));
});

test('Webview waits for its ready handshake before receiving the latest snapshot', () => {
  const messages = [];
  const provider = new MonitorViewProvider({ vscode: {}, monitorService: {}, configStore: {} });
  provider.view = { webview: { postMessage: async (message) => { messages.push(message); return true; } } };
  provider.lastViewModel = { performance: { cpu: { usagePercent: 5 } }, processes: [] };
  provider.renderViewModel(provider.lastViewModel);
  assert.equal(messages.length, 0);
  provider.handleMessage({ version: 1, cmd: 'ready' });
  assert.equal(messages.some((message) => message.cmd === 'snapshot'), true);
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
  provider.lastViewModel = { performance: { cpu: { usagePercent: 5 } }, processes: [{ pid: 42 }] };

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
  provider.renderViewModel(provider.lastViewModel);
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
  provider.renderViewModel(provider.lastViewModel);
  assert.equal(messages.some(([recipient]) => recipient === panels[0]), false);
  assert.equal(messages.some(([recipient, message]) => recipient === panels[1] && message.cmd === 'snapshot'), true);
});

test('view model combines GPU users, CPU denominator and SSH latency', () => {
  const gib = 1024 ** 3;
  const device = { nativeIndex: 0, name: 'NVIDIA H100 80GB HBM3', providerDeviceId: 'uuid', deviceKey: 'nvidia:uuid', utilizationPercent: 70, memory: { usedBytes: 3 * gib, totalBytes: 80 * gib }, temperatureCelsius: 45, power: null };
  const processes = [
    { pid: 7, processKey: '7:1', userName: 'alice', processName: 'python', commandLine: 'python train.py', cpuUsagePercent: 200, memoryUsedBytes: 2 * gib, memoryUsagePercent: 12.5 },
    { pid: 8, processKey: '8:1', userName: 'bob', processName: 'python', commandLine: 'python eval.py', cpuUsagePercent: 5, memoryUsedBytes: gib, memoryUsagePercent: 6.25 },
  ];
  const snapshot = {
    cpu: { value: { usagePercent: 10, coreCount: 16, loadAverage: { oneMinute: 1.24, fiveMinutes: 2.56, fifteenMinutes: 3.96 } } },
    memory: { value: { usagePercent: 20, usedBytes: 4 * gib, availableBytes: 16 * gib, totalBytes: 20 * gib } },
    processes: { value: processes },
    sshTraffic: { value: { isSsh: true, clientUploadBytesPerSecond: 1024, clientDownloadBytesPerSecond: 0, latencyMilliseconds: 12.25 } },
    accelerators: { value: { devices: [device], usagesByPid: new Map([[7, [{ nativeIndex: 0, deviceKey: 'nvidia:uuid', memoryUsedBytes: 2 * gib, memoryTotalBytes: 80 * gib, processKey: '7:1' }]], [8, [{ nativeIndex: 0, deviceKey: 'nvidia:uuid', memoryUsedBytes: gib, memoryTotalBytes: 80 * gib, processKey: '8:1' }]]]), currentUserDeviceKeys: ['nvidia:uuid'] } },
  };
  const model = buildMonitorViewModel(snapshot, 'en');
  assert.deepEqual(model.performance.cpu.loadAverage, { oneMinute: '1.2', fiveMinutes: '2.6', fifteenMinutes: '4.0' });
  assert.equal(model.performance.gpus[0].displayName, 'H100 80GB HBM3');
  assert.equal(model.performance.gpus[0].isMine, true);
  assert.equal(model.performance.gpus[0].memTotalStr, '80.0 G');
  assert.equal(model.performance.gpus[0].memPairStr, '3.0 / 80.0G');
  assert.deepEqual(model.performance.gpus[0].users.map((user) => user.name), ['alice', 'bob']);
  assert.equal(model.performance.gpus[0].users[0].usedStr, '2.0G');
  assert.equal(model.performance.gpus[0].users[0].percent, 3);
  assert.equal(model.performance.sshTraffic.latencyText, '12.3 ms');
  assert.equal(model.processes.find((row) => row.pid === 7).cpuWhole, 12.5);
  assert.equal(formatStatusBarText({ cpu: true, ram: true, disk: false, diskIO: 'off', net: 'off', ssh: false, gpu: { summary: true, mode: 'off' } }, model.performance), '$(dashboard) 10%  $(server) 20%  $(circuit-board) 0/1');
});

test('mount filtering is applied once before both views consume a snapshot', () => {
  const snapshot = {
    diskTopology: { value: [
      { mountPath: '/', usedBytes: 1024, totalBytes: 2048, usagePercent: 50 },
      { mountPath: '/data', usedBytes: 1024, totalBytes: 2048, usagePercent: 50 },
      { mountPath: '/data/child', usedBytes: 1024, totalBytes: 2048, usagePercent: 50 },
    ] },
    accelerators: { value: { devices: [], usagesByPid: new Map(), currentUserDeviceKeys: [] } },
  };
  assert.deepEqual(buildMonitorViewModel(snapshot, 'en').performance.disks.map((disk) => disk.mount), ['/', '/data/child']);
  assert.deepEqual(buildMonitorViewModel(snapshot, 'en', { hideParentMounts: false }).performance.disks.map((disk) => disk.mount), ['/', '/data', '/data/child']);
});

test('GPU card, process tag and user capsule use the same rounded memory percentage', () => {
  const gib = 1024 ** 3;
  const usedBytes = 71.8 * gib;
  const totalBytes = 80 * gib;
  const snapshot = {
    cpu: { value: { usagePercent: 0, coreCount: 8, loadAverage: { oneMinute: 0, fiveMinutes: 0, fifteenMinutes: 0 } } },
    processes: { value: [{ pid: 6, processKey: '6:1', userName: 'alice', processName: 'python', commandLine: 'python', cpuUsagePercent: 1, memoryUsedBytes: gib, memoryUsagePercent: 1 }] },
    accelerators: { status: 'ready', value: {
      devices: [{ nativeIndex: 6, deviceKey: 'gpu:6', name: 'A100', memory: { usedBytes, totalBytes }, utilizationPercent: 0 }],
      usagesByPid: new Map([[6, [{ nativeIndex: 6, deviceKey: 'gpu:6', processKey: '6:1', memoryUsedBytes: usedBytes, memoryTotalBytes: totalBytes }]]]),
      currentUserDeviceKeys: [],
    } },
  };
  const model = buildMonitorViewModel(snapshot, 'en');
  assert.equal(model.performance.gpus[0].memPct, 90);
  assert.equal(model.performance.gpus[0].users[0].percent, 90);
  assert.equal(model.processes[0].gpus[0].pct, 90);
  const script = readWebviewScript();
  assert.match(script, /var memPct = g\.memPct;/);
  assert.match(script, /var pct = g\.pct;/);
  assert.match(script, /chip\.className = 'gpu-user ' \+ tagColorClass\(user\.percent\)/);
});

test('GPU display name removes only vendor and marketing prefixes', () => {
  assert.equal(displayDeviceName('NVIDIA A100-SXM4-80GB'), 'A100-SXM4-80GB');
  assert.equal(displayDeviceName('NVIDIA GeForce RTX 4090 D'), 'RTX 4090 D');
  assert.equal(displayDeviceName('NVIDIA Tesla V100-SXM2-32GB'), 'V100-SXM2-32GB');
  assert.equal(displayDeviceName('AMD Radeon RX 7900 XTX'), 'AMD Radeon RX 7900 XTX');
});

test('chart fill color follows the metric bar transition', () => {
  const style = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview.css'), 'utf8');
  const script = readWebviewScript();
  assert.match(style, /--metric-transition:\s*\.5s ease;/);
  assert.match(style, /\.spark-bg path\s*\{\s*transition:\s*fill var\(--metric-transition\);\s*\}/);
  assert.match(style, /\.fill\s*\{[^}]*transition:\s*width var\(--metric-transition\), background var\(--metric-transition\);/);
  assert.doesNotMatch(script, /spark-color-duration/);
});

test('GPU footer shows users with a compact info button or falls back to stats', () => {
  const style = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview.css'), 'utf8');
  const script = readWebviewScript();
  const footer = script.slice(script.indexOf('  function gpuStatsDescription('), script.indexOf('  var gpuInfoPopover ='));
  const line = { style: {}, clientWidth: 180, scrollWidth: 100, children: [1], replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); } };
  const info = { style: {}, setAttribute(name, value) { this[name] = value; } };
  const stats = { style: {} };
  const elements = { 'gpu-users-0': line, 'gpu-info-0': info, 'gpu-stats-0': stats };
  const context = { document: { getElementById: (id) => elements[id], createElement: () => ({}) }, displayCfg: { showGpuUsers: true }, T: { tempLabel: '温度', pwLabel: '功耗' }, activeGpuInfoButton: null, hideGpuInfoPopover() {} };
  const colors = script.slice(script.indexOf('  function colorClass('), script.indexOf('  function setBar('));
  vm.runInNewContext(`${colors}\n${footer}\nthis.renderGpuUsers = renderGpuUsers; this.gpuStatsMarkup = gpuStatsMarkup;`, context);
  context.renderGpuUsers({ idx: 0, users: [] });
  assert.equal(line.style.display, 'none');
  assert.equal(info.style.display, 'none');
  assert.equal(stats.style.display, 'flex');
  assert.deepEqual(line.children, []);
  const gpu = { idx: 0, temp: 35, power: { draw: 100, limit: 250 }, users: [{ name: 'alice', usedStr: '5.0G', percent: 10 }] };
  context.renderGpuUsers(gpu);
  assert.equal(line.style.display, 'flex');
  assert.equal(info.style.display, 'inline-flex');
  assert.equal(stats.style.display, 'none');
  assert.equal(info['aria-label'], '温度 35°C · 功耗 100/250W');
  assert.equal(info.title, undefined);
  assert.equal(line.children[0].textContent, 'alice (5.0G)');
  context.renderGpuUsers({ ...gpu, users: [{ name: 'alice', usedStr: '71.8G', percent: 90 }] });
  assert.equal(line.children[0].className, 'gpu-user tag-danger');
  assert.match(context.gpuStatsMarkup({ ...gpu, temp: 36 }), /36°C/);
  assert.match(context.gpuStatsMarkup(gpu), /100\/250W/);
  const restoredChip = line.children[0];
  line.clientWidth = 0;
  context.renderGpuUsers(gpu);
  assert.equal(line.children[0], restoredChip);
  line.clientWidth = 180;
  context.displayCfg.showGpuUsers = false;
  context.renderGpuUsers(gpu);
  assert.equal(line.style.display, 'none');
  assert.equal(stats.style.display, 'flex');
  assert.match(style, /\.gpu-footer\s*\{[^}]*min-height:\s*18px;/);
  assert.match(style, /\.gpu-stats\s*\{[^}]*flex:\s*1 1 auto;[^}]*height:\s*18px;/);
  assert.match(style, /\.gpu-users\s*\{[^}]*font-size:\s*9px;/);
  assert.match(style, /\.gpu-user\s*\{[^}]*height:\s*14px;/);
  assert.match(style, /\.gpu-info\s*\{[^}]*border:\s*0;[^}]*opacity:\s*\.55;/);
  assert.match(style, /\.gpu-info-popover\s*\{[^}]*position:\s*fixed;/);
  assert.match(script, /class="gpu-info"[^>]*>ⓘ<\/button>/);
  assert.doesNotMatch(script, /class="gpu-info"[^>]*title=/);
  assert.match(script, /button\.addEventListener\('mouseenter', function\(\) \{ showGpuInfoPopover\(button\); \}\)/);
  assert.ok(script.indexOf('class="gpu-users" id="gpu-users-') < script.indexOf('class="gpu-stats" id="gpu-stats-'));
  assert.ok(script.indexOf('class="gpu-stats" id="gpu-stats-') < script.indexOf('class="gpu-info"'));
  assert.match(script, /statsElement\.innerHTML = gpuStatsMarkup\(g\)/);
});

test('GPU info appears immediately and refreshes while hovered', () => {
  const script = readWebviewScript();
  const popoverCode = script.slice(script.indexOf('  var gpuInfoPopover ='), script.indexOf("  window.addEventListener('resize'"));
  const popover = { style: {}, hidden: true, offsetWidth: 150, offsetHeight: 20 };
  const button = { dataset: { gpuInfo: '0' }, style: { display: 'inline-flex' }, isConnected: true, getClientRects: () => [{}], getBoundingClientRect: () => ({ right: 180, top: 100, bottom: 114 }) };
  const gpu = { idx: 0, temp: 35 };
  const context = {
    document: { createElement: () => popover, body: { appendChild() {} } },
    window: { innerWidth: 300 },
    lastGpuPayload: [gpu],
    gpuStatsDescription: (device) => `温度 ${device.temp}°C`,
  };
  vm.runInNewContext(`${popoverCode}\nthis.show = showGpuInfoPopover; this.hide = hideGpuInfoPopover; this.refresh = refreshGpuInfoPopover; this.popover = gpuInfoPopover;`, context);
  context.show(button);
  assert.equal(popover.hidden, false);
  assert.equal(popover.textContent, '温度 35°C');
  assert.equal(popover.style.top, '74px');
  gpu.temp = 36;
  context.refresh();
  assert.equal(popover.textContent, '温度 36°C');
  context.hide(button);
  assert.equal(popover.hidden, true);
});

test('returning to the performance tab redraws GPU user capsules', () => {
  const script = readWebviewScript();
  const switchTab = script.slice(script.indexOf('  function switchTab('), script.indexOf("  document.getElementById('tab-perf-btn').addEventListener"));
  const elements = { 'tab-perf': { classList: { add() {}, remove() {} } }, 'tab-proc': { classList: { add() {}, remove() {} } }, 'tab-perf-btn': { classList: { toggle() {} } }, 'tab-proc-btn': { classList: { toggle() {} } } };
  const rendered = [];
  let scheduled;
  const context = {
    document: { querySelectorAll: () => [elements['tab-perf'], elements['tab-proc']], getElementById: (id) => elements[id] },
    requestAnimationFrame: (callback) => { scheduled = callback; },
    lastGpuPayload: [{ idx: 0 }],
    renderGpuUsers: (gpu) => rendered.push(gpu.idx),
  };
  vm.runInNewContext(`${switchTab}\nthis.switchTab = switchTab;`, context);
  context.switchTab('perf');
  assert.equal(typeof scheduled, 'function');
  scheduled();
  assert.deepEqual(rendered, [0]);
});

test('spark area grows from real samples, then interpolates the left boundary after the window fills', () => {
  const script = readWebviewScript();
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

test('rate chart scale follows only the visible viewport, including interpolated edges', () => {
  const script = readWebviewScript();
  for (const pair of ['netTxHist, netRxHist', 'sshTxHist, sshRxHist', 'diskRHist, diskWHist']) {
    assert.equal(script.split(`renderRatePair(${pair},`).length - 1, 2);
  }
  const geometry = script.slice(script.indexOf('  function sparkDisplayTime('), script.indexOf('  function renderSpark('));
  const maximum = script.slice(script.indexOf('  function sparkVisibleMaximum('), script.indexOf('  var lastSparkFrame'));
  let now = 5000;
  const context = { Date: { now: () => now }, curInterval: 2, SPARK_WINDOW: 2000 };
  vm.runInNewContext(`${geometry}\n${maximum}\nthis.maximum = sparkMaximum; this.paths = sparkPaths;`, context);

  const enteringPeak = [{ t: 1000, v: 10 }, { t: 3000, v: 10 }, { t: 5000, v: 100 }];
  assert.equal(context.maximum(enteringPeak, []), 10);
  now = 6000;
  assert.equal(context.maximum(enteringPeak, []), 55);
  assert.match(context.paths(enteringPeak, 55).area, /L100,0\.0L100,100/);
  now = 7000;
  assert.equal(context.maximum(enteringPeak, []), 100);

  const leavingPeak = [{ t: 1000, v: 100 }, { t: 3000, v: 10 }, { t: 5000, v: 10 }];
  now = 5000;
  assert.equal(context.maximum(leavingPeak, []), 100);
  now = 6000;
  assert.equal(context.maximum(leavingPeak, []), 55);
  now = 7000;
  assert.equal(context.maximum(leavingPeak, []), 10);

  assert.equal(context.maximum([{ t: 1000, v: 2 }, { t: 3000, v: 2 }, { t: 5000, v: 2 }], enteringPeak), 100);
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
