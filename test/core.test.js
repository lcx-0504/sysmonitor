'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { SnapshotStore } = require('../src/core/snapshot-store');
const { CollectorRunner } = require('../src/core/collector-runner');
const { CommandRunner } = require('../src/core/command-runner');
const { MonitorScheduler } = require('../src/core/monitor-scheduler');

test('SnapshotStore distinguishes successful empty results from failures with stale data', () => {
  const store = new SnapshotStore();
  store.commit('accelerators', [], 10);
  assert.equal(store.read().accelerators.status, 'fresh');
  assert.deepEqual(store.read().accelerators.value, []);
  store.fail('accelerators', new Error('temporary'), 20);
  assert.equal(store.read().accelerators.status, 'stale');
  assert.deepEqual(store.read().accelerators.value, []);
});

test('CollectorRunner is single-flight and commits complete results', async () => {
  const store = new SnapshotStore(); let resolveCollection; let calls = 0;
  const collector = { collect: () => { calls += 1; return new Promise((resolve) => { resolveCollection = resolve; }); } };
  const runner = new CollectorRunner({ key: 'cpu', collector, snapshotStore: store, cadenceMilliseconds: 2000, timeoutMilliseconds: 1000, clock: () => 100 });
  assert.equal(runner.startIfDue(100), true);
  assert.equal(runner.startIfDue(101), false);
  assert.equal(calls, 1);
  resolveCollection({ usagePercent: 12 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.read().cpu.status, 'fresh');
  assert.equal(store.read().cpu.value.usagePercent, 12);
});

test('invalidated late collector results never overwrite the snapshot', async () => {
  const store = new SnapshotStore(); let resolveCollection;
  const runner = new CollectorRunner({ key: 'memory', collector: { collect: () => new Promise((resolve) => { resolveCollection = resolve; }) }, snapshotStore: store, cadenceMilliseconds: 2000, timeoutMilliseconds: 1000, clock: () => 100 });
  runner.startIfDue(100); runner.invalidate(); resolveCollection({ usagePercent: 99 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.read().memory.value, null);
});

test('MonitorScheduler uses one tick for due runners and pauses all collection', () => {
  let now = 0; let starts = 0; let renders = 0;
  const scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: 2000, clock: () => now, onTick: () => { renders += 1; } });
  scheduler.addRunner({ cadenceSource: 'refreshInterval', cadenceMilliseconds: 2000, startIfDue: () => { starts += 1; }, setCadence(value) { this.cadenceMilliseconds = value; }, invalidate() {} });
  scheduler.tick(); scheduler.pause(); scheduler.tick();
  assert.equal(starts, 1); assert.equal(renders, 1);
  scheduler.setRefreshInterval(5000);
  assert.equal(scheduler.runners[0].cadenceMilliseconds, 5000);
  scheduler.dispose();
});

test('CommandRunner executes without a shell and returns bounded command output', async () => {
  const runner = new CommandRunner();
  const result = await runner.execFile(process.execPath, ['-e', 'process.stdout.write("ok")']);
  assert.equal(result.stdout, 'ok'); runner.dispose();
});
