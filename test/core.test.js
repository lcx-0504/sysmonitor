'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { SnapshotStore } = require('../src/core/snapshot-store');
const { CollectorRunner } = require('../src/core/collector-runner');
const { CommandRunner } = require('../src/core/command-runner');
const { MonitorScheduler } = require('../src/core/monitor-scheduler');
const { MonitorService } = require('../src/services/monitor-service');
const { SshTransport } = require('../src/ssh/ssh-transport');
const { spawn } = require('node:child_process');
const { executionOptions, withCollectionContext } = require('../src/core/collection-context');

test('SnapshotStore distinguishes successful empty results from failures with stale data', () => {
  const store = new SnapshotStore();
  assert.equal(store.read().sequence, 0);
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

test('a timed-out collector stays single-flight until its underlying task settles', async () => {
  const store = new SnapshotStore();
  let finish;
  let calls = 0;
  const runner = new CollectorRunner({
    key: 'cpu', snapshotStore: store, cadenceMilliseconds: 10, timeoutMilliseconds: 1,
    collector: { collect() {
      calls++;
      return calls === 1 ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ usagePercent: 20 });
    } },
    clock: () => 100,
  });
  await runner.run(0);
  assert.equal(store.read().cpu.lastError.code, 'ETIMEDOUT');
  assert.equal(runner.startIfDue(100), false);
  assert.equal(calls, 1);
  finish({ usagePercent: 99 });
  await new Promise(setImmediate);
  assert.equal(store.read().cpu.value, null);
  assert.equal(runner.startIfDue(100), true);
  await new Promise(setImmediate);
  assert.equal(calls, 2);
  assert.equal(store.read().cpu.value.usagePercent, 20);
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

test('forced resume makes every collector due', () => {
  const service = Object.create(MonitorService.prototype);
  service.runners = [{ nextDueAt: 100 }, { nextDueAt: 200 }];
  let resumed = false;
  service.scheduler = { resume() { resumed = true; } };
  service.resume({ force: true });
  assert.deepEqual(service.runners.map((runner) => runner.nextDueAt), [0, 0]);
  assert.equal(resumed, true);
});

test('pausing blocks a collector next step while letting its active operation finish', async () => {
  let finish;
  let hardSignal;
  let nextSteps = 0;
  const store = new SnapshotStore();
  store.commit('cpu', { usagePercent: 10 });
  const scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: 1000, onTick() {} });
  const runner = new CollectorRunner({ key: 'cpu', snapshotStore: store, cadenceMilliseconds: 1000, timeoutMilliseconds: 1000,
    collector: { async collect() {
      hardSignal = executionOptions().signal;
      await new Promise((resolve) => { finish = resolve; });
      executionOptions();
      nextSteps++;
      return { usagePercent: 99 };
    } },
  });
  scheduler.addRunner(runner);
  scheduler.start();
  scheduler.pause();
  assert.equal(hardSignal.aborted, false);
  finish();
  await runner.whenIdle();
  assert.equal(nextSteps, 0);
  assert.deepEqual(store.read().cpu.value, { usagePercent: 10 });
  assert.equal(store.read().cpu.lastError, null);
  scheduler.dispose();
});

test('one-shot collection runs fast and slow collectors exactly once without a periodic timer', async () => {
  const store = new SnapshotStore();
  const scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: 10, onTick() {} });
  let fastCalls = 0, slowCalls = 0, finish;
  for (const [key, collect] of [
    ['cpu', async () => { fastCalls++; return {}; }],
    ['memory', async () => { slowCalls++; await new Promise((resolve) => { finish = resolve; }); return {}; }],
  ]) scheduler.addRunner(new CollectorRunner({ key, collector: { collect }, snapshotStore: store, cadenceMilliseconds: 10, timeoutMilliseconds: 1000 }));
  scheduler.pause();
  const once = scheduler.collectOnce();
  assert.equal(once, scheduler.collectOnce());
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fastCalls, 1);
  assert.equal(slowCalls, 1);
  assert.equal(scheduler.timer, null);
  finish();
  await once;
  assert.equal(scheduler.isPaused, true);
  assert.equal(scheduler.isCollectingOnce, false);
  assert.equal(scheduler.timer, null);
  scheduler.dispose();
});

test('pausing during a one-shot cancels waiting work and never resumes periodic collection', async () => {
  const store = new SnapshotStore();
  let release;
  let calls = 0;
  const runner = new CollectorRunner({ key: 'cpu', snapshotStore: store, cadenceMilliseconds: 10, timeoutMilliseconds: 1000,
    collector: { async collect() { calls++; await new Promise((resolve) => { release = resolve; }); return {}; } },
  });
  const scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: 10, onTick() {} });
  scheduler.addRunner(runner);
  scheduler.start();
  const once = scheduler.collectOnce();
  scheduler.pause();
  release();
  await once;
  assert.equal(calls, 1);
  assert.equal(scheduler.isPaused, true);
  assert.equal(scheduler.timer, null);
  assert.equal(store.read().cpu.value, null);
  scheduler.dispose();
});

test('one-shot collection rejects a still-running timed-out collector without starting another', async () => {
  let release;
  let calls = 0;
  const runner = new CollectorRunner({ key: 'cpu', snapshotStore: new SnapshotStore(), cadenceMilliseconds: 1, timeoutMilliseconds: 5,
    collector: { collect() { calls++; return new Promise((resolve) => { release = resolve; }); } },
  });
  const scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: 10, onTick() {} });
  scheduler.addRunner(runner);
  scheduler.pause();
  await runner.run();
  await assert.rejects(scheduler.collectOnce(), { code: 'EBUSY' });
  assert.equal(calls, 1);
  release({});
  await runner.idle;
  scheduler.dispose();
});

test('a cooperative pause removes queued SSH work but does not close the active channel', async () => {
  const executor = new SshTransport({ host: 'fixture', requireLinux: false, maxConnections: 1,
    spawnProcess: () => spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  try {
    await executor.connect();
    const channel = [...executor.channels][0];
    const controller = new AbortController();
    const active = withCollectionContext({ deadline: Date.now() + 1000, dispatchSignal: controller.signal },
      () => executor.execFile('sh', ['-c', 'sleep 0.1; printf completed']));
    const queued = withCollectionContext({ deadline: Date.now() + 1000, dispatchSignal: controller.signal },
      () => executor.execFile('printf', ['must not run']));
    const rejected = assert.rejects(queued, /paused/);
    controller.abort(new Error('paused'));
    await rejected;
    assert.equal((await active).stdout, 'completed');
    assert.equal(channel.closed, false);
    assert.equal(executor.sequence, 2);
    assert.equal(executor.pending.size, 0);
  } finally { executor.dispose(); }
});

for (const remote of [false, true]) {
  test((remote ? 'SSH' : 'direct') + ' collection commands use the same UTC locale environment', async () => {
    const executor = remote ? new SshTransport({ host: 'fixture', requireLinux: false,
      spawnProcess: () => spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TZ: 'America/New_York' } }),
    }) : new CommandRunner();
    try {
      const { stdout } = await executor.execFile(process.execPath, ['-p', 'process.env.TZ + ":" + process.env.LC_ALL']);
      assert.equal(stdout.trim(), 'UTC:C');
    } finally { executor.dispose(); }
  });
}

test('CommandRunner executes without a shell and returns bounded command output', async () => {
  const runner = new CommandRunner();
  const result = await runner.execFile(process.execPath, ['-e', 'process.stdout.write("ok")']);
  assert.equal(result.stdout, 'ok'); runner.dispose();
});

for (const remote of [false, true]) {
  test((remote ? 'SSH' : 'direct') + ' commands share the collector deadline across sequential steps', async () => {
    const executor = remote ? new SshTransport({ host: 'fixture', requireLinux: false,
      spawnProcess: () => spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }),
    }) : new CommandRunner();
    try {
      if (remote) await executor.connect();
      await assert.rejects(executor.execFile('sleep', ['0.1'], { timeoutMilliseconds: 10 }), { code: 'ETIMEDOUT' });
      const store = new SnapshotStore();
      let finished = false;
      const runner = new CollectorRunner({ key: 'cpu', snapshotStore: store, cadenceMilliseconds: 2000, timeoutMilliseconds: 200,
        collector: { async collect() {
          await executor.execFile('sleep', ['0.13'], { timeoutMilliseconds: 1000 });
          await executor.execFile('sleep', ['0.13'], { timeoutMilliseconds: 1000 });
          finished = true;
          return {};
        } },
      });
      await runner.run();
      await new Promise(setImmediate);
      assert.equal(finished, false);
      assert.equal(store.read().cpu.lastError.code, 'ETIMEDOUT');
      assert.equal(store.read().cpu.value, null);
      assert.equal((await executor.execFile('printf', ['usable'])).stdout, 'usable');
    } finally { executor.dispose(); }
  });
}
