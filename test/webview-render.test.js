'use strict';
// Renders webview modules into a fake DOM to check what they draw from a real view model.
const assert = require('node:assert/strict');
const test = require('node:test');
const { catalogs } = require('../src/i18n');
const { SnapshotStore } = require('../src/core/snapshot-store');
const { buildMonitorViewModel } = require('../src/services/monitor-view-model');
const { installFakeDom } = require('./fake-dom');

const GIB = 1024 ** 3;
const { document } = installFakeDom();
let state, performance, processes, servers;

test.before(async () => {
  ({ state } = await import('../src/view/assets/state.mjs'));
  Object.assign(state, {
    bridge: { getState: () => ({}), setState() {}, postMessage() {} },
    initial: { sshDefaultInstalled: false },
    environment: { localMode: true, localLinux: false, editorMode: false },
    locale: { language: 'zh-CN' },
    config: { refreshInterval: 2, display: { charts: true, sparkMinutes: 5, hiddenGroups: {} }, servers: { actions: {} } },
    ui: { paused: false, page: 'perf', deviceId: 'ssh:lab', navigation: { page: 'servers' } },
  });
  (await import('../src/view/assets/charts.mjs')).initializeCharts();
  performance = await import('../src/view/assets/performance.mjs');
  performance.initializePerformance({ viewGpuProcesses() {} });
  processes = await import('../src/view/assets/processes.mjs');
  servers = await import('../src/view/assets/servers.mjs');
  servers.initializeServers();
});

// A view model built from a raw snapshot with the given GPUs; GPU 6 is 71.8 of 80 GiB used by one process.
function viewModelWithGpus(indices) {
  const store = new SnapshotStore();
  store.commit('cpu', { usagePercent: 5, coreCount: 8, loadAverage: { oneMinute: 0, fiveMinutes: 0, fifteenMinutes: 0 } });
  store.commit('processes', { rows: [{ pid: 6, processKey: '6:1', userName: 'alice', processName: 'python', commandLine: 'python', cpuUsagePercent: 1, memoryUsedBytes: GIB, memoryUsagePercent: 1 }], totalCount: 1 });
  const devices = indices.map((index) => ({ nativeIndex: index, deviceKey: 'gpu:' + index, name: 'A100', memory: { usedBytes: index === 6 ? 71.8 * GIB : 0, totalBytes: 80 * GIB }, utilizationPercent: 0 }));
  const usage = { nativeIndex: 6, deviceKey: 'gpu:6', processKey: '6:1', memoryUsedBytes: 71.8 * GIB, memoryTotalBytes: 80 * GIB };
  store.commit('accelerators', { devices, usagesByPid: new Map(indices.includes(6) ? [[6, [usage]]] : []), currentUserDeviceKeys: [] });
  return buildMonitorViewModel(store.read());
}

function render(viewModel) {
  state.data.viewModel = viewModel;
  performance.renderMonitorSnapshot(viewModel, true);
  return document.getElementById('gpu-body').children;
}

test('GPU cards are rebuilt when the GPU list becomes empty and then returns', () => {
  const first = [...render(viewModelWithGpus([0, 6]))];
  assert.equal(first.length, 2);
  assert.deepEqual([...render(viewModelWithGpus([]))], []);
  const restored = [...render(viewModelWithGpus([0, 6]))];
  assert.equal(restored.length, 2);
  assert.ok(restored.every((card) => !first.includes(card)));
  assert.deepEqual(restored.map((card) => card.querySelector('.gpu-name').textContent), ['GPU 0', 'GPU 6']);
  assert.deepEqual([...render(viewModelWithGpus([0, 6]))], restored);
});

test('GPU cards, user chips and process GPU tags show the rounded memory percentage of the view model', () => {
  const viewModel = viewModelWithGpus([6]);
  const [gpu] = viewModel.performance.gpus;
  assert.equal(gpu.memPct, 90);
  const [card] = [...render(viewModel)];
  assert.equal(card.querySelector('.gpu-pct').textContent, '90%');
  assert.equal(card.querySelector('.track .fill.danger') !== null, true);
  const chips = card.querySelectorAll('.gpu-user');
  assert.deepEqual(chips.map((chip) => [chip.className, chip.textContent]), [['gpu-user tag-danger', 'alice (71.8G)']]);
  assert.equal(gpu.users[0].percent, 90);
  assert.deepEqual(processes.gpuTags(viewModel.processes[0]), [{ className: 'gpu-tag tag-danger', text: '#6 71.8G/80.0G 90%' }]);
  const [unknown] = [...render({ ...viewModel, performance: { ...viewModel.performance, gpus: [{ ...gpu, memPct: null, users: [] }] } })];
  assert.equal(unknown.querySelector('.gpu-pct').textContent, '--');
});

test('server rows title their window buttons with the wording of the matching native commands', () => {
  servers.showServers({ hosts: [{ host: 'campus', state: 'idle', error: null, busy: false, metrics: [], summaryLoading: false }] });
  const row = document.getElementById('server-list').querySelector('.server-row');
  const manifest = catalogs['zh-CN'].manifest;
  const commandTitle = (key) => manifest[key].split(': ').at(-1);
  assert.equal(row.querySelector('.server-window').title, commandTitle('cmdCopyToWindow'));
  assert.equal(row.querySelector('.server-remote').title, commandTitle('cmdOpenRemoteWindow'));
  assert.equal(row.querySelector('.server-terminal').title, commandTitle('cmdOpenTerminal'));
  assert.equal(row.querySelector('.server-window').getAttribute('aria-label'), '在新窗口打开');
  assert.equal(row.querySelector('.server-remote').getAttribute('aria-label'), '打开远程窗口');
});
