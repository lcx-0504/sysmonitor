'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { SnapshotStore } = require('../src/core/snapshot-store');
const { CollectorRunner } = require('../src/core/collector-runner');
const { CommandRunner } = require('../src/core/command-runner');
const { MonitorScheduler } = require('../src/core/monitor-scheduler');
const { SshTransport } = require('../src/ssh/ssh-transport');
const { spawn } = require('node:child_process');
const { executionOptions } = require('../src/core/collection-context');

test('counter warmup keeps the partition unpublished until a usable differential exists', async () => {
  const store = new SnapshotStore(); let calls = 0;
  const runner = new CollectorRunner({ key: 'cpu', snapshotStore: store, timeoutMilliseconds: 1000,
    collector: { collect: async () => ({ usagePercent: ++calls === 1 ? null : 20 }), needsWarmup: value => value.usagePercent === null },
  });
  const task = runner.run(); await new Promise(setImmediate);
  assert.equal(store.read().cpu.value, null);
  await task; assert.equal(calls, 2); assert.equal(store.read().cpu.value.usagePercent, 20);
});


test('resources share one command, warmup, deadline and snapshot publication', async () => {
  const { ResourceCollector } = require('../src/collectors/resource-collector');
  let calls = 0, fail = false, publications = 0;
  const commands = new Set();
  const commandRunner = { async execFile(command, args) {
    calls++; assert.equal(command, 'sh'); commands.add(args[1]);
    if (fail) throw new Error('resource read failed');
    const files = [`cpu ${calls * 10} 0 10 80 0 0 0 0\ncpu0 1 0 1 8\n`, '1 2 3 1/10 5\n',
      'MemTotal: 1000 kB\nMemAvailable: 400 kB\n',
      `Inter-| Receive | Transmit\nface | bytes\neth0: ${calls * 100} 0 0 0 0 0 0 0 ${calls * 200} 0 0 0 0 0 0 0\n`,
      'Iface Destination Gateway Flags\neth0 00000000 0 0003\n',
      `8 0 sda 0 0 ${calls * 10} 0 0 0 ${calls * 20} 0 0 0 0 0\n`];
    const uptime = (calls / 2).toFixed(2);
    return { stdout:files.map((text,index) => '__SYSMON_RESOURCE_'+index+'__\n'+text+'\n').join('')+'__SYSMON_RESOURCE_'+files.length+'__\n'+uptime+' '+uptime+'\n' };
  } };
  const collector = new ResourceCollector({ commandRunner });
  const store = new SnapshotStore();
  const resultKeys = ['cpu','memory','network','diskIo'];
  const runner = new CollectorRunner({ key:'resources', resultKeys, collector, snapshotStore:store, timeoutMilliseconds:1000,
    onSettled:() => { publications++; for (const key of resultKeys) assert.ok(store.read()[key].value); } });
  await runner.run(); await runner.idle;
  assert.equal(calls, 2); assert.equal(publications, 1); assert.equal(commands.size, 1);
  assert.match([...commands][0], /read -r started ignored < \/proc\/uptime[\s\S]*read -r finished ignored < \/proc\/uptime/);
  assert.equal(store.read().cpu.value.coreCount, 1);
  assert.equal(store.read().network.value.receiveBytesPerSecond, 200);
  assert.equal(store.read().diskIo.value.readBytesPerSecond, 10240);
  const previous = store.read(); fail = true;
  await runner.run(); await runner.idle;
  for (const key of resultKeys) { assert.equal(store.read()[key].value, previous[key].value); assert.equal(store.read()[key].status, 'stale'); }
  assert.equal(publications, 2);
});


test('counter warmup remains within the same deadline and cancellation stops further reads', async () => {
  const store = new SnapshotStore(); let calls = 0;
  const runner = new CollectorRunner({ key: 'cpu', snapshotStore: store, timeoutMilliseconds: 20,
    collector: { collect: async () => { calls++; return { usagePercent: null }; }, needsWarmup: () => true },
  });
  await runner.run(); await runner.idle;
  assert.equal(store.read().cpu.lastError.code, 'ETIMEDOUT'); assert.equal(calls, 1);
  assert.equal(store.read().cpu.value, null);
});


test('counter identities may need more than two reads and an unavailable source needs none', async () => {
  const store = new SnapshotStore(); let calls = 0;
  const runner = new CollectorRunner({ key: 'sshTraffic', snapshotStore: store, timeoutMilliseconds: 1000,
    collector: { collect: async () => ({ rate: ++calls < 3 ? null : 10 }), needsWarmup: value => value.rate === null },
  });
  await runner.run(); assert.equal(calls, 3); assert.equal(store.read().sshTraffic.value.rate, 10);
  const unavailable = new CollectorRunner({ key: 'diskIo', snapshotStore: store, timeoutMilliseconds: 1000,
    collector: { collect: async () => ({ rate: null, devices: [] }), needsWarmup: value => value.devices.length > 0 && value.rate === null },
  });
  await unavailable.run(); assert.equal(store.read().diskIo.status, 'fresh');
});


test('CollectorRunner is single-flight and commits complete results', async () => {
  const store = new SnapshotStore(); let resolveCollection; let calls = 0;
  const collector = { collect: () => { calls += 1; return new Promise((resolve) => { resolveCollection = resolve; }); } };
  const runner = new CollectorRunner({ key: 'cpu', collector, snapshotStore: store, timeoutMilliseconds: 1000, clock: () => 100 });
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
  const runner = new CollectorRunner({ key: 'memory', collector: { collect: () => new Promise((resolve) => { resolveCollection = resolve; }) }, snapshotStore: store, timeoutMilliseconds: 1000, clock: () => 100 });
  runner.startIfDue(100); runner.invalidate(); resolveCollection({ usagePercent: 99 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.read().memory.value, null);
});


test('a timed-out collector stays single-flight until its underlying task settles', async () => {
  const store = new SnapshotStore();
  let finish;
  let calls = 0;
  const runner = new CollectorRunner({
    key: 'cpu', snapshotStore: store, timeoutMilliseconds: 1,
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
  assert.equal(runner.startIfDue(), false);
  runner.advanceCycle();
  assert.equal(runner.startIfDue(), true);
  await new Promise(setImmediate);
  assert.equal(calls, 2);
  assert.equal(store.read().cpu.value.usagePercent, 20);
});


test('targeted refresh aborts obsolete work, coalesces selections and drops late old results', async t => {
  const store = new SnapshotStore(); store.commit('diskTopology', [{ mountPath: '/previous' }]);
  const scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: 10000, onTick() {} });
  t.after(() => scheduler.dispose());
  let selection = '/old', finishOld, signal; const calls = [];
  const runner = new CollectorRunner({ key: 'diskTopology', snapshotStore: store, timeoutMilliseconds: 1000,
    collector: { collect() {
      calls.push(selection);
      if (calls.length === 1) { signal = executionOptions().signal; return new Promise(resolve => { finishOld = resolve; }); }
      return Promise.resolve([{ mountPath: selection }]);
    } },
  });
  scheduler.addRunner(runner); scheduler.start();
  selection = '/intermediate'; const first = scheduler.refreshRunner(runner);
  selection = '/latest'; const second = scheduler.refreshRunner(runner);
  assert.equal(signal.aborted, true); assert.deepEqual(calls, ['/old']);
  assert.equal(store.read().diskTopology.value[0].mountPath, '/previous');
  finishOld([{ mountPath: '/obsolete' }]); await Promise.all([first, second]);
  assert.deepEqual(calls, ['/old', '/latest']);
  assert.equal(store.read().diskTopology.value[0].mountPath, '/latest');
  assert.equal(store.read().diskTopology.lastError, null);
});


test('a configuration refresh while paused waits for resume without issuing a query', async t => {
  const scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: 10000, onTick() {} });
  t.after(() => scheduler.dispose()); let calls = 0;
  const runner = new CollectorRunner({ key: 'diskTopology', snapshotStore: new SnapshotStore(), timeoutMilliseconds: 1000,
    collector: { async collect() { calls++; return []; } } });
  scheduler.addRunner(runner); scheduler.pause();
  await scheduler.refreshRunner(runner); assert.equal(calls, 0);
  scheduler.resume(); await runner.idle; assert.equal(calls, 1);
});


test('a filter change during a paused one-shot waits for the replacement collection', async t => {
  const store = new SnapshotStore(); let calls = 0;
  const scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: 10000, onTick() {} });
  t.after(() => scheduler.dispose());
  const runner = new CollectorRunner({ key: 'diskTopology', snapshotStore: store, timeoutMilliseconds: 1000,
    collector: { collect() {
      if (++calls > 1) return Promise.resolve([{ mountPath: '/new' }]);
      const { signal } = executionOptions();
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } },
  });
  scheduler.addRunner(runner); scheduler.pause(); const once = scheduler.collectOnce();
  await new Promise(setImmediate);
  await Promise.all([once, scheduler.refreshRunner(runner)]);
  assert.equal(calls, 2); assert.equal(store.read().diskTopology.value[0].mountPath, '/new');
  assert.equal(scheduler.isPaused, true); assert.equal(scheduler.isCollectingOnce, false); assert.equal(scheduler.timer, null);
});


test('refresh during one-shot preparation starts the new query only after onStart', async t => {
  const store = new SnapshotStore(); let calls = 0, release, started = false;
  const scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: 10000, onTick() {} });
  t.after(() => scheduler.dispose());
  const runner = new CollectorRunner({ key: 'diskTopology', snapshotStore: store, timeoutMilliseconds: 1000,
    collector: { collect() {
      if (++calls === 1) return new Promise(resolve => { release = resolve; });
      assert.equal(started, true); return Promise.resolve([{ mountPath: '/new' }]);
    } },
  });
  scheduler.addRunner(runner); scheduler.start(); scheduler.pause();
  const once = scheduler.collectOnce({ onStart() { started = true; } });
  const refresh = scheduler.refreshRunner(runner); release([{ mountPath: '/old' }]);
  await Promise.all([once, refresh]);
  assert.equal(calls, 2); assert.equal(store.read().diskTopology.value[0].mountPath, '/new');
});


test('interval changes during one-shot collection resume the current periodic cadence afterwards', async t => {
  const scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: 10000, onTick() {} });
  t.after(() => scheduler.dispose()); const releases = [];
  const runner = new CollectorRunner({ key: 'diskTopology', snapshotStore: new SnapshotStore(), timeoutMilliseconds: 1000,
    collector: { collect() { return new Promise(resolve => releases.push(resolve)); } } });
  scheduler.addRunner(runner); scheduler.start(); const once = scheduler.collectOnce();
  releases[0]([]); await new Promise(setImmediate);
  assert.equal(releases.length, 2); scheduler.setRefreshInterval(5000); releases[1]([]);
  await once; assert.equal(scheduler.refreshIntervalMilliseconds, 5000); assert.notEqual(scheduler.timer, null);
});


test('pausing blocks a collector next step while letting its active operation finish', async () => {
  let finish;
  let hardSignal;
  let nextSteps = 0;
  const store = new SnapshotStore();
  store.commit('cpu', { usagePercent: 10 });
  const scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: 1000, onTick() {} });
  const runner = new CollectorRunner({ key: 'cpu', snapshotStore: store, timeoutMilliseconds: 1000,
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
  ]) scheduler.addRunner(new CollectorRunner({ key, collector: { collect }, snapshotStore: store, timeoutMilliseconds: 1000 }));
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
  const runner = new CollectorRunner({ key: 'cpu', snapshotStore: store, timeoutMilliseconds: 1000,
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
  const runner = new CollectorRunner({ key: 'cpu', snapshotStore: new SnapshotStore(), timeoutMilliseconds: 5,
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
      const runner = new CollectorRunner({ key: 'cpu', snapshotStore: store, timeoutMilliseconds: 200,
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
