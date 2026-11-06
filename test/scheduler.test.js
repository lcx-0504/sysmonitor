'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { MonitorScheduler } = require('../src/core/monitor-scheduler');
const { CollectorRunner } = require('../src/core/collector-runner');
const { SnapshotStore } = require('../src/core/snapshot-store');

test('re-enabling an occupied collector during a retry reports busy and finishes the round', { timeout:1000 }, async t => {
  const scheduler=new MonitorScheduler({refreshIntervalMilliseconds:2000,onTick() {}});
  scheduler.pause(); t.after(()=>scheduler.dispose());
  const store=new SnapshotStore(); let release, gpuCalls=0, processCalls=0;
  const gpu=new CollectorRunner({key:'accelerators',snapshotStore:store,cadenceMilliseconds:2000,timeoutMilliseconds:30,
    collector:{collect:()=>{gpuCalls++;return new Promise(resolve=>{release=resolve;});}}});
  scheduler.addRunner(gpu); const old=gpu.run(); scheduler.setRunnerDemand(gpu,[]);
  const processes=new CollectorRunner({key:'processes',snapshotStore:store,cadenceMilliseconds:2000,timeoutMilliseconds:100,
    collector:{async collect(){processCalls++;scheduler.setRunnerDemand(gpu,['accelerators']);return [];}}});
  scheduler.addRunner(processes);
  await scheduler.collectOnce();
  assert.equal(processCalls,1); assert.equal(gpuCalls,1);
  assert.equal(scheduler.isCollectingOnce,false); assert.equal(scheduler.refreshes.size,0);
  assert.equal(store.read().accelerators.lastError.code,'EBUSY');
  assert.equal(gpu.isRunning,true);
  release({devices:[],usagesByPid:new Map(),currentUserDeviceKeys:[]}); await old; await gpu.idle;
});

test('a disabled module is excluded from one-shot idle checks and execution', async t => {
  const scheduler=new MonitorScheduler({refreshIntervalMilliseconds:2000,onTick() {}});
  scheduler.pause(); t.after(()=>scheduler.dispose());
  scheduler.addRunner({enabled:false,invalidate() {},whenIdle() {assert.fail('disabled idle check');},run() {assert.fail('disabled run');}});
  let runs=0;
  scheduler.addRunner({enabled:true,invalidate() {},whenIdle:async()=>{},run:async()=>{runs++;}});
  await scheduler.collectOnce();
  assert.equal(runs,1);
});

test('disabling a module removes a pending configuration refresh from one-shot waits', async t => {
  const scheduler=new MonitorScheduler({refreshIntervalMilliseconds:2000,onTick() {}});
  scheduler.pause(); t.after(()=>scheduler.dispose());
  let release;
  const runner={enabled:true,idle:new Promise(resolve=>{release=resolve;}),invalidate() {},markDue() {},run() {assert.fail('disabled refresh');}};
  const oldRefresh=scheduler.refreshRunner(runner);
  runner.enabled=false;
  await scheduler.refreshRunner(runner);
  assert.equal(scheduler.refreshes.size,0);
  await scheduler.collectOnce();
  release(); await oldRefresh;
});

test('disabling a module while a retry waits for it immediately releases the healthy collectors', async t => {
  const scheduler=new MonitorScheduler({refreshIntervalMilliseconds:2000,onTick() {}});
  scheduler.pause(); t.after(()=>scheduler.dispose());
  let rejectIdle;
  const oldIdle=new Promise((_,reject)=>{rejectIdle=reject;});
  const gpu={enabled:true,idle:oldIdle,invalidate() {},markDue() {},whenIdle:()=>oldIdle,run() {assert.fail('disabled GPU run');}};
  let processRuns=0;
  scheduler.addRunner(gpu);
  scheduler.addRunner({enabled:true,invalidate() {},whenIdle:async()=>{},run:async()=>{processRuns++;}});
  const retry=scheduler.collectOnce(); await new Promise(setImmediate);
  gpu.enabled=false; await scheduler.refreshRunner(gpu);
  await retry;
  assert.equal(processRuns,1);
  rejectIdle(new Error('old collection is still running')); await new Promise(setImmediate);
});

test('MonitorScheduler uses one tick for due runners and pauses all collection', () => {
  let starts = 0; let renders = 0;
  const scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: 2000, onTick: () => { renders += 1; } });
  scheduler.addRunner({ minimumIntervalMilliseconds: 10000, advanceCycle() {}, startIfDue: () => { starts += 1; }, invalidate() {} });
  assert.equal(scheduler.runners[0].cadenceCycles, 5);
  scheduler.tick(); scheduler.pause(); scheduler.tick();
  assert.equal(starts, 1); assert.equal(renders, 1);
  scheduler.setRefreshInterval(4000);
  assert.equal(scheduler.runners[0].cadenceCycles, 3);
  scheduler.dispose();
});

const flush = () => new Promise(setImmediate);

async function advanceTimers(t, milliseconds) {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 100) {
    t.mock.timers.tick(100);
    await flush();
  }
}

function timedRunner(key, starts, { minimumIntervalMilliseconds = 0, duration = () => 300 } = {}) {
  return new CollectorRunner({ key, minimumIntervalMilliseconds, snapshotStore: new SnapshotStore(), timeoutMilliseconds: 60000,
    collector: { collect() {
      starts.push(Date.now());
      return new Promise(resolve => setTimeout(() => resolve(key === 'diskTopology' ? [] : {}), duration(starts.length)));
    } } });
}

test('due collectors follow scheduler cycles rather than timer timestamps', async t => {
  const scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: 2000, clock: () => 0, onTick() {} });
  t.after(() => scheduler.dispose());
  const starts = { cpu: 0, diskTopology: 0 };
  for (const [key, minimum] of [['cpu', 0], ['diskTopology', 10000]]) {
    scheduler.addRunner(new CollectorRunner({ key, minimumIntervalMilliseconds: minimum, snapshotStore: new SnapshotStore(), timeoutMilliseconds: 1000, clock: () => 0,
      collector: { async collect() { starts[key]++; return key === 'cpu' ? {} : []; } } }));
  }
  scheduler.start(); await flush();
  for (let cycle = 1; cycle <= 10; cycle++) { scheduler.tick(); await flush(); }
  assert.deepEqual(starts, { cpu: 11, diskTopology: 3 });
});

test('running regular collectors keep their cadence while disk collection is idle', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const starts = { cpu: [], disk: [] };
  const scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: 2000, onTick() {} });
  t.after(() => scheduler.dispose());
  scheduler.addRunner(timedRunner('cpu', starts.cpu));
  scheduler.addRunner(timedRunner('diskTopology', starts.disk, { minimumIntervalMilliseconds: 10000 }));
  scheduler.start(); await flush();
  await advanceTimers(t, 10000);
  assert.deepEqual(starts.cpu, [0, 2000, 4000, 6000, 8000, 10000]);
  assert.deepEqual(starts.disk, [0, 10000]);
});

test('disk collection waits for a global tick after its minimum interval', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const starts = { cpu: [], disk: [] };
  const scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: 8000, onTick() {} });
  t.after(() => scheduler.dispose());
  scheduler.addRunner(timedRunner('cpu', starts.cpu));
  scheduler.addRunner(timedRunner('diskTopology', starts.disk, { minimumIntervalMilliseconds: 10000 }));
  scheduler.start(); await flush();
  await advanceTimers(t, 8000);
  assert.deepEqual(starts.cpu, [0, 8000]);
  assert.deepEqual(starts.disk, [0]);
  await advanceTimers(t, 2000);
  assert.deepEqual(starts.disk, [0]);
  await advanceTimers(t, 6000);
  assert.deepEqual(starts.disk, [0, 16000]);
  scheduler.setRefreshInterval(15000);
  assert.equal(scheduler.runners[1].cadenceCycles, 1);
  await flush();
  assert.deepEqual(starts.disk, [0, 16000]);
  await advanceTimers(t, 15000);
  assert.deepEqual(starts.disk, [0, 16000, 31000]);
  scheduler.pause(); await advanceTimers(t, 30000);
  assert.equal(starts.disk.length, 3);
});

test('a slow collector skips occupied ticks and rejoins the common cadence', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const starts = { resources: [], gpu: [], disk: [] }, published = [];
  const scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: 8000, onTick: now => published.push(now) });
  t.after(() => scheduler.dispose());
  scheduler.addRunner(timedRunner('cpu', starts.resources, { duration: count => count === 1 ? 9000 : 300 }));
  scheduler.addRunner(timedRunner('accelerators', starts.gpu));
  scheduler.addRunner(timedRunner('diskTopology', starts.disk, { minimumIntervalMilliseconds: 10000 }));
  scheduler.start(); await flush();
  await advanceTimers(t, 24000);
  assert.deepEqual(starts.resources, [0, 16000, 24000]);
  assert.deepEqual(starts.gpu, [0, 8000, 16000, 24000]);
  assert.deepEqual(starts.disk, [0, 16000]);
  assert.deepEqual(published, [0, 8000, 16000, 24000]);
});

test('configuration collection does not shift the regular publication clock', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const published = [];
  const scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: 2000, onTick: now => published.push(now) });
  t.after(() => scheduler.dispose());
  const store = new SnapshotStore();
  const runner = new CollectorRunner({ key: 'diskTopology', snapshotStore: store, cadenceMilliseconds: 10000,
    timeoutMilliseconds: 1000, collector: { collect: async () => [] } });
  scheduler.addRunner(runner); scheduler.start(); await runner.idle;
  t.mock.timers.tick(500);
  await scheduler.refreshRunner(runner);
  t.mock.timers.tick(1500);
  assert.deepEqual(published, [0, 2000]);
});
