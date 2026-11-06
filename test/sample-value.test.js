'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { SnapshotStore } = require('../src/core/snapshot-store');
const { buildMonitorViewModel } = require('../src/services/monitor-view-model');
const { SshTrafficCollector } = require('../src/collectors/ssh-traffic-collector');
const { DiskTopologyCollector } = require('../src/collectors/disk-topology-collector');
const { AcceleratorCollector } = require('../src/collectors/accelerator-collector');
const { parseNvidiaCards, parseNvidiaProcesses } = require('../src/accelerators/nvidia-provider');
const { parseCpuStat, parseMemoryInfo, parseProcessOutput, parseNetworkCounters, parseDiskIoCounters } = require('../src/domain/linux-parsers');

test('numeric fields share missing-value retention while genuine zero values update', () => {
  const cases = { cpu: ['usagePercent'], memory: ['usagePercent', 'usedBytes', 'availableBytes', 'totalBytes'], network: ['receiveBytesPerSecond', 'transmitBytesPerSecond'], diskIo: ['readBytesPerSecond', 'writeBytesPerSecond'], sshTraffic: ['latencyMilliseconds', 'clientUploadBytesPerSecond', 'clientDownloadBytesPerSecond'] };
  for (const [key, fields] of Object.entries(cases)) {
    const store = new SnapshotStore();
    const good = Object.fromEntries(fields.map((field) => [field, 25]));
    store.commit(key, good);
    const before = store.read()[key].value;
    store.commit(key, Object.fromEntries(fields.map((field, i) => [field, i % 2 ? NaN : null])));
    for (const field of fields) assert.equal(store.read()[key].value[field], 25, key + ':' + field);
    assert.deepEqual(before, good);
    store.commit(key, Object.fromEntries(fields.map((field) => [field, 0])));
    for (const field of fields) assert.equal(store.read()[key].value[field], 0);
    store.fail(key, new Error('timeout'));
    for (const field of fields) assert.equal(store.read()[key].value[field], 0);
  }
});

test('nested CPU load fields retain independently without mutating the old snapshot', () => {
  const store = new SnapshotStore();
  store.commit('cpu', { usagePercent: 25, coreCount: 8, loadAverage: { oneMinute: 1, fiveMinutes: 2, fifteenMinutes: 3 } });
  const previous = store.read().cpu.value;
  store.commit('cpu', { usagePercent: null, coreCount: 8, loadAverage: { oneMinute: 0, fiveMinutes: null, fifteenMinutes: NaN } });
  assert.deepEqual(store.read().cpu.value.loadAverage, { oneMinute: 0, fiveMinutes: 2, fifteenMinutes: 3 });
  assert.equal(previous.loadAverage.oneMinute, 1);
  const view = buildMonitorViewModel(store.read(), 'en');
  assert.equal(view.performance.cpu.usagePercent, 25);
  assert.equal(Object.hasOwn(view.performance.cpu, 'sampled'), false);
});

test('missing SSH RTT and counters retain last values only for the same connection', async () => {
  const store = new SnapshotStore();
  let port = 50000, omit = false, seconds = 1;
  const collector = new SshTrafficCollector({ isSsh: true,
    connectionInfo: () => ({ serverIp: '10.0.0.2', serverPort: 22, clientIp: '10.0.0.1', clientPort: port }),
    commandRunner: { async execFile() { return { stdout: `__SYSMON_SSH_SAMPLE_START__ ${seconds}\n0 0 10.0.0.2:22 10.0.0.1:${port}\n cubic ${omit ? '' : 'rtt:12.5/1 bytes_sent:100 bytes_received:50'}\n__SYSMON_SSH_SAMPLE_END__ ${seconds}\n` }; } },
  });
  store.commit('sshTraffic', await collector.collect());
  omit = true; seconds++;
  store.commit('sshTraffic', await collector.collect());
  assert.equal(store.read().sshTraffic.value.latencyMilliseconds, 12.5);
  assert.equal(buildMonitorViewModel(store.read(), 'en').performance.sshTraffic.latencyText, '12.5 ms');
  port++; seconds++;
  store.commit('sshTraffic', await collector.collect());
  assert.equal(store.read().sshTraffic.value.latencyMilliseconds, null);
  assert.equal(buildMonitorViewModel(store.read(), 'en').performance.sshTraffic.latencyText, '—');
});

test('interface changes and counter resets invalidate old rates', () => {
  const store = new SnapshotStore();
  store.commit('network', { sampleIdentity: 'eth0', receiveBytesPerSecond: 10, transmitBytesPerSecond: 20 });
  store.commit('network', { sampleIdentity: 'eth1', receiveBytesPerSecond: null, transmitBytesPerSecond: null });
  assert.equal(store.read().network.value.receiveBytesPerSecond, null);
  store.commit('diskIo', { readBytesPerSecond: 10, writeBytesPerSecond: 20 });
  store.commit('diskIo', { readBytesPerSecond: null, writeBytesPerSecond: null, resetFields: ['readBytesPerSecond', 'writeBytesPerSecond'] });
  assert.equal(store.read().diskIo.value.readBytesPerSecond, null);
  const view = buildMonitorViewModel(store.read(), 'en');
  assert.equal(view.performance.network.receiveText, '—');
  assert.equal(view.performance.diskIo.totalText, '--');
  assert.equal(view.performance.diskIo.readText, '--');
  assert.equal(view.performance.diskIo.writeText, '--');
});

test('GPU fields retain by device identity, while absent and replaced devices clear', () => {
  const store = new SnapshotStore();
  const gpu = parseNvidiaCards('0, A100, 1, 10, 80, 45, 50, 250, GPU-A')[0];
  const data = (devices) => ({ devices, usagesByPid: new Map(), currentUserDeviceKeys: [] });
  store.commit('accelerators', data([gpu]));
  store.commit('accelerators', data(parseNvidiaCards('0, A100, N/A, N/A, 80, N/A, N/A, N/A, GPU-A')));
  const held = buildMonitorViewModel(store.read(), 'en').performance.gpus[0];
  assert.equal(held.util, 1); assert.equal(held.temp, 45); assert.equal(held.power.draw, '50');
  assert.equal(Object.hasOwn(held, 'utilSampled'), false); assert.equal(held.isIdle, true);
  store.commit('accelerators', data(parseNvidiaCards('0, A100, N/A, N/A, 80, N/A, N/A, N/A, GPU-B')));
  const replaced = buildMonitorViewModel(store.read(), 'en').performance.gpus[0];
  assert.equal(replaced.util, null); assert.equal(replaced.temp, null); assert.equal(replaced.power, null);
  store.commit('accelerators', data([]));
  assert.deepEqual(store.read().accelerators.value.devices, []);
});

test('GPU process memory retains only for a matching process identity', () => {
  const store = new SnapshotStore();
  const data = (processKey, memoryUsedBytes) => ({ devices: [], currentUserDeviceKeys: [], usagesByPid: new Map([[7, [{ deviceKey: 'gpu', processKey, memoryUsedBytes, memoryTotalBytes: 100 }]]]) });
  store.commit('accelerators', data('7:old', 10));
  store.commit('accelerators', data('7:old', null));
  assert.equal(store.read().accelerators.value.usagesByPid.get(7)[0].memoryUsedBytes, 10);
  store.commit('accelerators', data('7:new', null));
  assert.equal(store.read().accelerators.value.usagesByPid.get(7)[0].memoryUsedBytes, null);
  store.commit('processes', { rows: [{ pid: 7 }], totalCount: 1 }); store.commit('processes', { rows: [], totalCount: 0 });
  assert.deepEqual(store.read().processes.value, { rows: [], totalCount: 0 });
});

test('a successful disk query with no usable capacities clears the disk list', async () => {
  let valid = true;
  const collector = new DiskTopologyCollector({ getDiskConfig: () => ({ mountFilter: 'all' }),
    fileReader: { readFile: async () => '10 0 8:0 / /data rw - ext4 source rw' },
    commandRunner: { execFile: async () => ({ stdout: JSON.stringify({ filesystems: [{ target: '/data', fstype: 'ext4', size: valid ? 102400 : null, used: valid ? 40960 : null, avail: valid ? 61440 : null, 'use%': '40%' }] }) }) },
  });
  assert.equal((await collector.collect())[0].totalBytes, 102400); valid = false;
  assert.deepEqual(await collector.collect(), []);
});

test('GPU provider failures preserve known devices and a successful empty result clears them', async () => {
  const gpu = parseNvidiaCards('0, A100, 1, 10, 80, 45, 50, 250, GPU-A')[0];
  let mode = 'good';
  const collector = new AcceleratorCollector({ providers: [{ id: 'nvidia', async collect() {
    if (mode === 'error') throw Object.assign(new Error('query unavailable'), { code: 'ENOENT' });
    return { devices: mode === 'empty' ? [] : [gpu], usagesByPid: new Map(), currentUserDeviceKeys: [] };
  } }] });
  await collector.collect(); mode = 'error';
  let partial;
  await assert.rejects(collector.collect({ onPartial:value => { partial = value; } }), { code:'ENOENT' });
  assert.equal(partial.value.devices[0].deviceKey, 'nvidia:GPU-A');
  mode = 'empty'; assert.deepEqual((await collector.collect()).devices, []);
});

test('malformed queries fail instead of replacing data with zero or an empty result', () => {
  assert.throws(() => parseCpuStat('cpu bad input'), { code: 'EINCOMPLETE' });
  assert.throws(() => parseMemoryInfo('MemTotal: 0 kB\nMemAvailable: 0 kB'));
  assert.throws(() => parseNvidiaCards('unrecognized output'), { code: 'EINCOMPLETE' });
  assert.throws(() => parseProcessOutput('unrecognized output', 100), { code: 'EINCOMPLETE' });
  assert.throws(() => parseNetworkCounters('unrecognized output'), { code: 'EINCOMPLETE' });
  assert.throws(() => parseDiskIoCounters('unrecognized output'), { code: 'EINCOMPLETE' });
  assert.throws(() => parseNvidiaProcesses('unrecognized output', new Map()), { code: 'EINCOMPLETE' });
  assert.deepEqual(parseProcessOutput('', 100), []);
});
