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
  const runner={enabled:true,idle:new Promise(resolve=>{release=resolve;}),invalidate() {},run() {assert.fail('disabled refresh');}};
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
  const gpu={enabled:true,idle:oldIdle,invalidate() {},whenIdle:()=>oldIdle,run() {assert.fail('disabled GPU run');}};
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
  let now = 0; let starts = 0; let renders = 0;
  const scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: 2000, clock: () => now, onTick: () => { renders += 1; } });
  scheduler.addRunner({ cadenceSource: 'refreshInterval', cadenceMilliseconds: 2000, startIfDue: () => { starts += 1; }, setCadence(value) { this.cadenceMilliseconds = value; }, invalidate() {} });
  scheduler.tick(); scheduler.pause(); scheduler.tick();
  assert.equal(starts, 1); assert.equal(renders, 1);
  scheduler.setRefreshInterval(5000);
  assert.equal(scheduler.runners[0].cadenceMilliseconds, 5000);
  scheduler.dispose();
});


test('running regular collectors keep their next due time while disk collection is idle', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const starts = { cpu: [], disk: [] };
  const scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: 2000, onTick() {} });
  for (const [key, cadenceMilliseconds] of [['cpu', 2000], ['disk', 10000]]) {
    scheduler.addRunner({ nextDueAt: 0, isRunning: false,
      startIfDue(now) {
        if (this.isRunning || now < this.nextDueAt) return;
        starts[key].push(now); this.isRunning = true; this.nextDueAt = now + cadenceMilliseconds;
        setTimeout(() => { this.isRunning = false; }, 300);
      }, invalidate() {},
    });
  }
  scheduler.start();
  for (let second = 0; second < 10; second++) t.mock.timers.tick(1000);
  assert.deepEqual(starts.cpu, [0, 2000, 4000, 6000, 8000, 10000]);
  assert.deepEqual(starts.disk, [0, 10000]);
  scheduler.dispose();
});


test('disk collection waits for a global tick after its minimum interval', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const starts = { cpu: [], disk: [] };
  const scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: 8000, onTick() {} });
  for (const [key, minimum] of [['cpu', 0], ['disk', 10000]]) {
    scheduler.addRunner({ nextDueAt: 0, minimumCadenceMilliseconds: minimum, cadenceMilliseconds: Math.max(8000, minimum),
      setCadence(value) { this.nextDueAt += value - this.cadenceMilliseconds; this.cadenceMilliseconds = value; },
      startIfDue(now) { if (now < this.nextDueAt) return; starts[key].push(now); this.nextDueAt = now + this.cadenceMilliseconds; }, invalidate() {} });
  }
  scheduler.start();
  t.mock.timers.tick(8000);
  assert.deepEqual(starts.cpu, [0, 8000]);
  assert.deepEqual(starts.disk, [0]);
  t.mock.timers.tick(2000);
  assert.deepEqual(starts.disk, [0]);
  t.mock.timers.tick(6000);
  assert.deepEqual(starts.disk, [0, 16000]);
  scheduler.setRefreshInterval(15000);
  assert.equal(scheduler.runners[1].cadenceMilliseconds, 15000);
  t.mock.timers.tick(15000);
  assert.deepEqual(starts.disk, [0, 16000, 31000]);
  scheduler.pause(); t.mock.timers.tick(30000);
  assert.equal(starts.disk.length, 3);
  scheduler.dispose();
});

test('a slow collector skips occupied ticks and rejoins the common cadence', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const starts = { resources: [], gpu: [], disk: [] }, published = [];
  const scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: 8000, onTick: now => published.push(now) });
  t.after(() => scheduler.dispose());
  for (const [key, cadence] of [['resources', 8000], ['gpu', 8000], ['disk', 10000]]) {
    scheduler.addRunner({ nextDueAt: 0, isRunning: false, invalidate() {},
      startIfDue(now) {
        if (this.isRunning || now < this.nextDueAt) return;
        starts[key].push(now); this.nextDueAt = now + cadence; this.isRunning = true;
        setTimeout(() => { this.isRunning = false; }, key === 'resources' && starts[key].length === 1 ? 9000 : 300);
      },
    });
  }
  scheduler.start();
  for (let second = 0; second < 24; second++) t.mock.timers.tick(1000);
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
