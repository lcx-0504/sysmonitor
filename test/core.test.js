'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { SnapshotStore } = require('../src/core/snapshot-store');
const { CommandRunner } = require('../src/core/command-runner');
const { MonitorService } = require('../src/services/monitor-service');
const { SshTransport } = require('../src/ssh/ssh-transport');
const { spawn } = require('node:child_process');
const { withCollectionContext } = require('../src/core/collection-context');

test('command stdin carries large UTF-8 input without argv size limits and tolerates early exit', async t => {
  const runner = new CommandRunner(); t.after(() => runner.dispose());
  const input = '中文\0\n'.repeat(80000);
  assert.equal((await runner.execFile('cat', [], { input })).stdout, input);
  assert.equal((await runner.execFile('true', [], { input })).stdout, '');
});


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


test('forced resume makes every collector due and pausing resets counter baselines', t => {
  const { normalizeConfig } = require('../src/config/normalize-config');
  const service = new MonitorService({ runtimeConfig: normalizeConfig({}), isSsh: false });
  t.after(() => service.dispose());
  const resets = () => service.runners.filter(runner => runner.resetOnNextRun).map(runner => runner.key);
  for (const runner of service.runners) runner.resetOnNextRun = false;
  service.pause();
  assert.deepEqual(resets(), ['resources', 'sshTraffic']);
  for (const runner of service.runners) { runner.resetOnNextRun = false; runner.elapsedCycles = 0; }
  service.scheduler.resume = () => {};
  service.resume();
  assert.deepEqual(resets(), []);
  assert.ok(service.runners.every(runner => !runner.isDue()));
  service.resume({ force: true });
  assert.deepEqual(resets(), ['resources', 'sshTraffic']);
  assert.ok(service.runners.every(runner => runner.isDue()));
});

test('only disk capacity takes a cycle count derived from its ten-second minimum and the refresh interval', t => {
  const { normalizeConfig } = require('../src/config/normalize-config');
  const cadences = service => Object.fromEntries(service.runners.map(runner => [runner.key, runner.cadenceCycles]));
  const everyCycle = { resources: 1, sshTraffic: 1, processes: 1, accelerators: 1 };
  for (const [refreshInterval, diskCycles] of [[1, 10], [2, 5], [3, 4], [10, 1], [15, 1]]) {
    const service = new MonitorService({ runtimeConfig: normalizeConfig({ refreshInterval }), isSsh: false });
    t.after(() => service.dispose());
    assert.deepEqual(cadences(service), { ...everyCycle, diskTopology: diskCycles }, String(refreshInterval));
  }
  const service = new MonitorService({ runtimeConfig: normalizeConfig({}), isSsh: false });
  t.after(() => service.dispose());
  service.pause();
  service.updateConfig(normalizeConfig({ refreshInterval: 3 }));
  assert.deepEqual(cadences(service), { ...everyCycle, diskTopology: 4 });
});

test('the resource collector clears every counter baseline on reset', async () => {
  const { ResourceCollector } = require('../src/collectors/resource-collector');
  const { resourceCommandRunner } = require('./resource-fixture');
  let counter = 100;
  const files = {
    '/proc/stat': () => `cpu ${counter} 0 10 80 0 0 0 0\ncpu0 1 0 1 8\n`, '/proc/loadavg': () => '1 2 3 1/10 5\n',
    '/proc/meminfo': () => 'MemTotal: 1000 kB\nMemAvailable: 400 kB\n',
    '/proc/net/dev': () => `Inter-| Receive | Transmit\nface | bytes\neth0: ${counter} 0 0 0 0 0 0 0 ${counter} 0 0 0 0 0 0 0\n`,
    '/proc/net/route': () => 'Iface Destination Gateway Flags\neth0 00000000 0 0003\n',
    '/proc/diskstats': () => `8 0 sda 0 0 ${counter} 0 0 0 ${counter} 0 0 0 0 0\n`,
  };
  const collector = new ResourceCollector({ commandRunner: resourceCommandRunner(async file => files[file]()) });
  await collector.collect();
  counter += 100;
  const warmed = await collector.collect();
  assert.equal(collector.needsWarmup(warmed), false);
  collector.reset();
  counter += 100;
  const reset = await collector.collect();
  assert.equal(collector.needsWarmup(reset), true);
  assert.deepEqual([reset.cpu.usagePercent, reset.network.receiveBytesPerSecond, reset.diskIo.readBytesPerSecond], [null, null, null]);
});


test('only mount selection changes refresh the disk runner; display projection changes do not', t => {
  const { normalizeConfig } = require('../src/config/normalize-config');
  const service = new MonitorService({ runtimeConfig:normalizeConfig({}), isSsh:false });
  t.after(() => service.dispose());
  const disk = service.runners.find(runner => runner.key === 'diskTopology'), refreshed = [];
  service.scheduler.refreshRunner = runner => refreshed.push(runner);
  service.scheduler.setRefreshInterval = () => assert.fail('Interval is unchanged');
  service.updateConfig(normalizeConfig({ disk: { hideParentMounts: false } })); assert.deepEqual(refreshed, []);
  service.updateConfig(normalizeConfig({ disk: { mountFilter: 'custom', customPathExclude: '/nfs', hideParentMounts: false } }));
  assert.deepEqual(refreshed, [disk]);
});

test('regular publication uses the current snapshot at fixed ticks without awaiting collectors', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const { normalizeConfig } = require('../src/config/normalize-config');
  const published = [], pending = new Map(), calls = new Map();
  const service = new MonitorService({ runtimeConfig: normalizeConfig({}), isSsh: true,
    onSnapshot: snapshot => published.push({ at: Date.now(), snapshot }) });
  t.after(() => service.dispose());
  for (const runner of service.runners) {
    runner.configure({ timeoutMilliseconds: 2500 });
    runner.collector = { collect() {
      calls.set(runner.key, (calls.get(runner.key) || 0) + 1);
      return new Promise(resolve => pending.set(runner.key, resolve));
    } };
  }
  service.setProcessDemand(true);
  const flush = () => new Promise(setImmediate);
  function finish(key, value) {
    const runner = service.runners.find(item => item.key === key);
    pending.get(key)(runner.grouped ? Object.fromEntries(runner.resultKeys.map(result => [result, value])) : value);
    pending.delete(key);
  }
  service.start();
  assert.deepEqual(published.map(item => item.at), [0]);
  t.mock.timers.tick(300);
  finish('resources', { value: 1 }); finish('sshTraffic', { value: 1 });
  finish('processes', []); finish('diskTopology', []);
  await flush();
  assert.equal(service.readSnapshot().cpu.value.value, 1);
  assert.equal(published[0].snapshot.cpu.value, null);
  assert.equal(published.length, 1);
  t.mock.timers.tick(1700); await flush();
  assert.deepEqual(published.map(item => item.at), [0, 2000]);
  assert.equal(published[1].snapshot.cpu.value.value, 1);
  assert.equal(calls.get('resources'), 2);
  assert.equal(calls.get('accelerators'), 1);
  t.mock.timers.tick(500); await flush();
  assert.equal(service.readSnapshot().accelerators.lastError.code, 'ETIMEDOUT');
  assert.equal(published.at(-1).snapshot.accelerators.lastError, null);
  assert.equal(published.length, 2);
  finish('accelerators', { value: 'late' }); await flush();
  assert.equal(service.readSnapshot().accelerators.value, null);
  finish('resources', { value: 2 }); finish('sshTraffic', { value: 2 }); finish('processes', []);
  await flush();
  t.mock.timers.tick(1500); await flush();
  assert.deepEqual(published.map(item => item.at), [0, 2000, 4000]);
  assert.equal(published.at(-1).snapshot.cpu.value.value, 2);
  assert.equal(published.at(-1).snapshot.accelerators.lastError.code, 'ETIMEDOUT');
  assert.equal(calls.get('accelerators'), 2);
  t.mock.timers.tick(100); finish('accelerators', { devices: [], usagesByPid: new Map(), currentUserDeviceKeys: [] }); await flush();
  assert.equal(published.at(-1).snapshot.accelerators.value, null);
  t.mock.timers.tick(1900); await flush();
  assert.deepEqual(published.map(item => item.at), [0, 2000, 4000, 6000]);
  assert.deepEqual(published.at(-1).snapshot.accelerators.value.devices, []);
  assert.equal(published.at(-1).snapshot.accelerators.lastError, null);
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

test('local command timeouts, cancellation and disposal stop the whole process group', { skip: process.platform === 'win32' }, async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysmonitor-groups-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runner = new CommandRunner();
  t.after(() => runner.dispose());
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const descendant = name => ['sh', ['-c', 'sleep 30 & echo $! > "$1"; wait', 'fixture', path.join(root, name)]];
  const descendantPid = async name => {
    for (let attempt = 0; attempt < 100 && !fs.existsSync(path.join(root, name)); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    return Number(fs.readFileSync(path.join(root, name), 'utf8'));
  };
  const settle = async pid => { for (let attempt = 0; attempt < 100 && alive(pid); attempt++) await new Promise(resolve => setTimeout(resolve, 10)); return alive(pid); };
  await assert.rejects(runner.execFile(...descendant('timeout'), { timeoutMilliseconds: 200 }), { code: 'ETIMEDOUT' });
  assert.equal(await settle(await descendantPid('timeout')), false);
  const controller = new AbortController();
  const cancelled = assert.rejects(runner.execFile(...descendant('cancel'), { signal: controller.signal, timeoutMilliseconds: 5000 }), /cancelled by test/);
  const cancelledPid = await descendantPid('cancel');
  controller.abort(new Error('cancelled by test'));
  await cancelled;
  assert.equal(await settle(cancelledPid), false);
  const disposed = new CommandRunner();
  const running = disposed.execFile(...descendant('dispose'), { timeoutMilliseconds: 5000 });
  running.catch(() => {});
  const disposedPid = await descendantPid('dispose');
  disposed.dispose();
  await assert.rejects(running);
  assert.equal(await settle(disposedPid), false);
  await assert.rejects(runner.execFile('sh', ['-c', 'printf "failure detail\\n" >&2; exit 3']), { code: 3, exitCode: 3, message: 'failure detail' });
  await assert.rejects(runner.execFile('printf', ['x'.repeat(100)], { maxBufferBytes: 16 }), { code: 'EMAXBUFFER' });
  await assert.rejects(runner.execFile('sysmonitor-missing-command'), { code: 'ENOENT' });
});
