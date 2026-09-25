'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { WEBVIEW_SCRIPT_FILES } = require('../src/view/webview-html');
const { formatStatusBarText } = require('../src/view/status-bar-controller');
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

test('disk breakdown, occupied ratio and bar segments use the same capacity snapshot', () => {
  const gib = 1024 ** 3;
  const snapshot = {
    diskTopology: { value: [{ mountPath: '/data', usedBytes: 70 * gib, availableBytes: 25 * gib, totalBytes: 100 * gib, usagePercent: 70 }] },
    accelerators: { status: 'ready', value: { devices: [], usagesByPid: new Map(), currentUserDeviceKeys: [] } },
  };
  const disk = buildMonitorViewModel(snapshot, 'en').performance.disks[0];
  assert.equal(disk.reservedStr, '5.0G');
  assert.equal(disk.usedStr, '70.0G');
  assert.equal(disk.availableStr, '25.0G');
  assert.equal(disk.occupiedStr, '75.0G');
  assert.equal(disk.totalStr, '100.0G');
  assert.equal(disk.reservedPct, 5);
  assert.equal(disk.occupiedPct, 75);
  assert.equal(disk.pct, 75);
  snapshot.diskTopology.value[0].usedBytes = 85 * gib;
  snapshot.diskTopology.value[0].availableBytes = 10 * gib;
  assert.equal(buildMonitorViewModel(snapshot, 'en').performance.disks[0].pct, 90);
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
