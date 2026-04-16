const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseBaseGpuCsv,
  mergeGpuPowerCsv,
  createGpuSnapshotCache,
  collectGpuSnapshot,
} = require('../lib/gpu-collector');

test('parseBaseGpuCsv trims comma-separated fields without depending on comma-space', () => {
  const rows = parseBaseGpuCsv('0, NVIDIA A100, 76, 40960, 81920, 48\n1,NVIDIA A100,0,0,81920,31');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    idx: 0,
    name: 'NVIDIA A100',
    util: 76,
    memUsed: 40960,
    memTotal: 81920,
    temp: 48,
    power: null,
  });
  assert.equal(rows[1].idx, 1);
  assert.equal(rows[1].util, 0);
});

test('mergeGpuPowerCsv enriches existing rows but does not replace base GPU data', () => {
  const gpus = [
    { idx: 0, name: 'GPU 0', util: 55, memUsed: 1000, memTotal: 2000, temp: 40, power: null },
  ];
  const merged = mergeGpuPowerCsv(gpus, '0, 125.30, 300.00');
  assert.deepEqual(merged[0], {
    idx: 0,
    name: 'GPU 0',
    util: 55,
    memUsed: 1000,
    memTotal: 2000,
    temp: 40,
    power: { draw: '125', limit: '300' },
  });
});

test('collectGpuSnapshot falls back to cache when the base query fails after a prior success', () => {
  const calls = [];
  const cache = createGpuSnapshotCache();
  const execFileSync = (file, args) => {
    calls.push([file, args]);
    if (args.includes('power.draw')) return Buffer.from('0, 125.30, 300.00');
    if (calls.length === 1) return Buffer.from('0, NVIDIA A100, 76, 40960, 81920, 48');
    throw new Error('nvidia-smi timeout');
  };
  const logs = [];
  const deps = { execFileSync, dbg: (msg) => logs.push(msg) };

  const fresh = collectGpuSnapshot(deps, cache);
  const fallback = collectGpuSnapshot(deps, cache);

  assert.equal(fresh.source, 'fresh');
  assert.equal(fallback.source, 'cache');
  assert.equal(fallback.gpus.length, 1);
  assert.equal(fallback.gpus[0].util, 76);
  assert.ok(logs.some((msg) => msg.includes('gpu snapshot fallback')));
});

test('collectGpuSnapshot keeps base GPU rows when the power query fails', () => {
  const cache = createGpuSnapshotCache();
  const execFileSync = (file, args) => {
    if (args.includes('power.draw')) throw new Error('power unavailable');
    return Buffer.from('0, NVIDIA A100, 12, 2048, 81920, 42');
  };
  const result = collectGpuSnapshot({ execFileSync, dbg: () => {} }, cache);
  assert.equal(result.source, 'fresh');
  assert.equal(result.gpus.length, 1);
  assert.equal(result.gpus[0].util, 12);
  assert.equal(result.gpus[0].power, null);
});

test('collectGpuSnapshot returns cloned cached rows so runtime mutation does not poison the cache', () => {
  const cache = createGpuSnapshotCache();
  let callCount = 0;
  const execFileSync = () => {
    callCount += 1;
    if (callCount === 1) return Buffer.from('0, NVIDIA A100, 90, 5000, 81920, 50');
    throw new Error('base query failed');
  };
  const first = collectGpuSnapshot({ execFileSync, dbg: () => {} }, cache);
  first.gpus[0].util = 0;
  const second = collectGpuSnapshot({ execFileSync, dbg: () => {} }, cache);
  assert.equal(second.gpus[0].util, 90);
});

test('collectGpuSnapshot calls nvidia-smi directly with split timeouts for base and power queries', () => {
  const calls = [];
  const cache = createGpuSnapshotCache();
  const execFileSync = (file, args, options) => {
    calls.push({ file, args, options });
    if (args.includes('power.draw')) return Buffer.from('0, 125.30, 300.00');
    return Buffer.from('0, NVIDIA A100, 66, 3072, 81920, 44');
  };

  const result = collectGpuSnapshot({ execFileSync, dbg: () => {} }, cache);

  assert.equal(result.source, 'fresh');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].file, 'nvidia-smi');
  assert.deepEqual(calls[0].args, [
    '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu',
    '--format=csv,noheader,nounits',
  ]);
  assert.equal(calls[0].options.timeout, 5000);
  assert.equal(calls[1].file, 'nvidia-smi');
  assert.deepEqual(calls[1].args, [
    '--query-gpu=index,power.draw,power.limit',
    '--format=csv,noheader,nounits',
  ]);
  assert.equal(calls[1].options.timeout, 1500);
});
