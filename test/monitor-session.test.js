'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createSessionFixture } = require('./session-fixture');
const { resourceCommandRunner } = require('./resource-fixture');

const captureFrame = session => session.captureChartFrames([Date.now()], Date.now());

test('paused one-shot samples are acknowledged without consuming the resume gap', t => {
  let now = 0; t.mock.method(Date, 'now', () => now);
  const fixture = createSessionFixture(); t.after(() => fixture.session.dispose());
  fixture.commit(); captureFrame(fixture.session); now = 1000; fixture.session.setPaused(true);
  now = 2000; fixture.values.memory.usagePercent = 50; fixture.commit(['memory']);
  now = 10000; fixture.session.setPaused(false); fixture.commit(['cpu']);
  now = 11000; fixture.values.memory.usagePercent = 60; fixture.commit(['memory']); captureFrame(fixture.session);
  assert.deepEqual(fixture.session.chartSamples().filter(sample => sample.source === 'memory').map(sample => [sample.t, sample.gapBefore]), [[0, false], [10000, true], [11000, false]]);
});

const { MonitorService } = require('../src/services/monitor-service');
const { normalizeConfig } = require('../src/config/normalize-config');
const { MonitorSession } = require('../src/services/monitor-session');

test('disabled performance modules do not delay the first display or surface their old failures', async t => {
  let config=normalizeConfig({});
  const session=new MonitorSession({configStore:{getCurrent:()=>config},serviceOptions:{isSsh:false,statusBarAvailable:false}});
  t.after(()=>session.dispose());
  session.service.snapshotStore.fail('diskTopology',new Error('disk failed'));
  session.acceptSnapshot(session.service.readSnapshot());
  assert.equal(session.ready,false);
  const waiting=session.waitForInitialSample();
  config=normalizeConfig({statusBar:{barEnabled:false},display:{hiddenGroups:{cpu:true,memory:true,disk:true,network:true,gpuSummary:true,gpuCards:true}}});
  session.updateConfig(); await waiting;
  assert.equal(session.ready,true);
  assert.deepEqual(session.viewState().failures,[]);
  assert.equal(session.model.sources.diskTopology.state,'disabled');
  assert.deepEqual(session.service.requiredKeys(),[]);
});
const { CollectorRunner } = require('../src/core/collector-runner');
const { MonitorScheduler } = require('../src/core/monitor-scheduler');

test('an already-open view receives one initial snapshot after network and SSH also settle', (t) => {
  const fixture = createSessionFixture();
  t.after(() => fixture.session.dispose());
  fixture.commit(['cpu', 'memory', 'diskIo', 'diskTopology', 'accelerators']);
  assert.equal(fixture.session.ready, false);
  assert.equal(fixture.session.snapshotState().viewModel, null);
  fixture.commit(['network']);
  assert.equal(fixture.session.ready, false);
  fixture.store.fail('sshTraffic', new Error('SSH metrics unavailable'));
  fixture.publish();
  assert.equal(fixture.session.ready, true);
  assert.equal(fixture.session.snapshotState().viewModel.performance.cpu.usagePercent, 12);
  assert.equal(fixture.session.snapshotState().viewModel.sources.sshTraffic.state, 'error');
});

test('first-screen completion publishes immediately and later results wait for a refresh tick', t => {
  const fixture = createSessionFixture();
  t.after(() => fixture.session.dispose());
  const { session, store, values } = fixture;
  for (const key of Object.keys(values).filter(key => key !== 'accelerators')) store.commit(key, values[key]);
  session.acceptInitialSnapshot(store.read());
  assert.equal(session.ready, false);
  assert.equal(session.model, null);
  store.fail('accelerators', Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
  session.acceptInitialSnapshot(store.read());
  assert.equal(session.ready, true);
  assert.equal(session.model.performance.memory.usagePercent, 20);
  assert.equal(session.viewState().failures.length, 1);
  store.commit('memory', { ...values.memory, usagePercent: 70 });
  store.commit('accelerators', values.accelerators);
  session.acceptInitialSnapshot(store.read());
  assert.equal(session.model.performance.memory.usagePercent, 20);
  assert.equal(session.snapshotState(true).status.failures.length, 1);
  fixture.publish();
  assert.equal(session.model.performance.memory.usagePercent, 70);
  assert.equal(session.viewState().failures.length, 0);
});

test('unpublished failures do not leak through chart frames or view hydration', t => {
  const fixture = createSessionFixture();
  t.after(() => fixture.session.dispose());
  fixture.commit();
  fixture.store.fail('diskIo', Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
  fixture.session.acceptInitialSnapshot(fixture.store.read());
  captureFrame(fixture.session);
  assert.deepEqual(fixture.session.snapshotState(true).status.failures, []);
  assert.equal(fixture.session.model.sources.diskIo.state, 'ready');
  fixture.publish();
  assert.equal(fixture.session.viewState().failures[0].key, 'diskIo');
  assert.equal(fixture.session.model.sources.diskIo.state, 'stale');
});

test('paused one-shot collection publishes only after its active modules settle', async t => {
  const config = normalizeConfig({ statusBar: { barEnabled: false }, display: { hiddenGroups: {
    cpu: true, disk: true, network: true, gpuCards: true, gpuSummary: true,
  } } });
  const session = new MonitorSession({ configStore: { getCurrent: () => config }, serviceOptions: { isSsh: false } });
  t.after(() => session.dispose());
  session.paused = true;
  session.setProcessDemand(true);
  let finishMemory, finishProcesses;
  session.service.runners.find(runner => runner.key === 'resources').collector = {
    collect: () => new Promise(resolve => { finishMemory = resolve; }),
  };
  session.service.runners.find(runner => runner.key === 'processes').collector = {
    collect: () => new Promise(resolve => { finishProcesses = resolve; }),
  };
  const retry = session.retry(); await new Promise(setImmediate);
  finishMemory({ memory: { usagePercent: 40, usedBytes: 40, availableBytes: 60, totalBytes: 100 } });
  await new Promise(setImmediate);
  assert.equal(session.model, null);
  finishProcesses({ rows: [], totalCount: 0 }); await retry;
  assert.equal(session.model.performance.memory.usagePercent, 40);
  assert.equal(session.service.scheduler.isPaused, true);
  assert.equal(session.service.scheduler.timer, null);
});

for (const remote of [false, true]) {
  test((remote ? 'SSH' : 'direct') + ' session waits for complete first data and publishes immediately', async (t) => {
    const updates = [];
    const fixture = createSessionFixture({ remote, id: remote ? 'ssh:lab' : 'local', onUpdate: (session) => updates.push(session.snapshotState()) });
    t.after(() => fixture.session.dispose());
    if (remote) await fixture.transport.connect();
    fixture.commit(['cpu', 'memory', 'network', 'sshTraffic', 'diskIo', 'diskTopology']);
    assert.equal(fixture.session.model.performance.cpu.usagePercent, 12);
    assert.equal(fixture.session.ready, false);
    assert.equal(fixture.session.viewState().loading, true);
    assert.equal(fixture.session.snapshotState().viewModel, null);
    assert.equal(fixture.session.snapshotState(true).viewModel, null);
    const ready = fixture.session.waitForInitialSample();
    fixture.commit(['accelerators']);
    captureFrame(fixture.session);
    await ready;
    assert.equal(fixture.session.ready, true);
    assert.equal(updates.at(-1).viewModel.performance.cpu.usagePercent, 12);
    assert.deepEqual(updates.at(-1).viewModel.performance.gpus, []);
    assert.equal(fixture.session.chartSamples().filter(sample => sample.source === 'cpu').length, 1);
  });
}

test('direct and SSH services use identical collector deadlines and command budgets', () => {
  const options = { runtimeConfig: normalizeConfig({}), isSsh: false };
  const direct = new MonitorService(options);
  const ssh = new MonitorService({ ...options, commandRunner: { dispose() {} }, fileReader: {}, systemInfo: {} });
  try {
    const policy = (service) => service.runners.map((runner) => [runner.key, runner.timeoutMilliseconds, runner.cadenceCycles]);
    assert.deepEqual(policy(ssh), policy(direct));
  } finally { direct.dispose(); ssh.dispose(); }
});

test('disconnection freezes history until a complete sample from the new connection arrives', (t) => {
  const fixture = createSessionFixture({ remote: true, id: 'ssh:lab' });
  const session = fixture.session;
  t.after(() => session.dispose());
  session.setConnection('connected');
  fixture.commit();
  const model = session.model;
  const history = session.chartSamples();
  session.setConnection('disconnected', new Error('connection lost'));
  fixture.commit();
  assert.equal(session.model, model);
  assert.deepEqual(session.chartSamples(), history);
  session.setConnection('connected');
  for (const key of ['cpu', 'memory', 'network', 'sshTraffic', 'diskIo', 'diskTopology', 'accelerators']) {
    fixture.store.commit(key, fixture.values[key], session.requiredSince - 1);
  }
  fixture.publish();
  assert.equal(session.ready, false);
  fixture.commit();
  assert.equal(session.ready, true);
  assert.equal(session.viewState().hasSnapshot, true);
});

test('single-item failures preserve the last snapshot and do not disconnect the session', (t) => {
  const fixture = createSessionFixture();
  t.after(() => fixture.session.dispose());
  fixture.commit();
  fixture.store.fail('diskTopology', new Error('disk timed out'));
  fixture.publish();
  assert.equal(fixture.session.state, 'connected');
  assert.equal(fixture.session.ready, true);
  assert.equal(fixture.session.viewState().failures[0].key, 'diskTopology');
  assert.deepEqual(fixture.session.model.performance.disks, []);
});

test('paused retry updates once, preserves history, and deduplicates simultaneous requests', async (t) => {
  const fixture = createSessionFixture({ remote: true, id: 'ssh:lab' });
  const session = fixture.session;
  t.after(() => session.dispose());
  await fixture.transport.connect();
  fixture.commit();
  const history = session.chartSamples();
  session.setPaused(true);
  session.setConnection('disconnected', new Error('lost'));
  let attempts = 0;
  fixture.transport.retryNow = async () => { attempts++; session.setConnection('connected'); };
  session.service.collectOnce = async ({ onStart }) => { onStart(); fixture.commit(); };
  const first = session.retry();
  const second = session.retry();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(attempts, 1);
  assert.equal(session.service.scheduler.isPaused, true);
  assert.deepEqual(session.chartSamples(), history);
  assert.deepEqual(session.snapshotState().samples, []);
});

test('failed paused retry stops its one-shot collection', async (t) => {
  const fixture = createSessionFixture({ paused: true });
  const session = fixture.session;
  t.after(() => session.dispose());
  session.service.collectOnce = async ({ onStart }) => { onStart(); session.loadError = 'sample failed'; session.settleWaiters(); };
  await assert.rejects(session.retry(), /sample failed/);
  assert.equal(session.service.scheduler.isPaused, true);
  assert.equal(session.paused, true);
});

test('manual retry excludes a previous in-flight failure and waits for the new round', async (t) => {
  const scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: 2000, onTick() {} });
  scheduler.pause();
  const fixture = createSessionFixture({ paused: true, service: { collectOnce: options => scheduler.collectOnce(options) } });
  t.after(() => { fixture.session.dispose(); scheduler.dispose(); });
  fixture.commit();
  let failPrevious;
  let attempts = 0;
  const runner = new CollectorRunner({ key: 'processes', snapshotStore: fixture.store, timeoutMilliseconds: 1000,
    onSettled: () => fixture.publish(),
    collector: { async collect() {
      attempts++;
      if (attempts === 1) await new Promise((resolve, reject) => { failPrevious = reject; });
      fixture.commit(['cpu', 'memory', 'network', 'sshTraffic', 'diskIo', 'diskTopology', 'accelerators']);
      return fixture.values.processes;
    } },
  });
  scheduler.addRunner(runner);
  runner.run();
  const retry = fixture.session.retry();
  await new Promise(setImmediate);
  assert.equal(attempts, 1, 'retry waits for the existing round');
  failPrevious(Object.assign(new Error('previous process collection timed out'), { code: 'ETIMEDOUT' }));
  await retry;
  assert.equal(attempts, 2);
  assert.deepEqual(fixture.session.viewState().failures, []);
  assert.equal(fixture.session.loadError, null);
  assert.equal(scheduler.isPaused, true);
});

test('each new view receives the same shared snapshot and history', (t) => {
  const fixture = createSessionFixture();
  t.after(() => fixture.session.dispose());
  fixture.commit();
  const first = fixture.session.snapshotState(true);
  const second = fixture.session.snapshotState(true);
  assert.deepEqual(first.samples, second.samples);
  assert.equal(first.viewModel, second.viewModel);
  assert.equal(first.replaceSamples, true);
});

for (const remote of [false, true]) test((remote ? 'SSH' : 'direct') + ' first-sample failure opens usable data and a subsequent retry can recover', async (t) => {
  const fixture = createSessionFixture({ remote, id: remote ? 'ssh:lab' : 'local' });
  t.after(() => fixture.session.dispose());
  if (remote) await fixture.transport.connect();
  const ready = fixture.session.waitForInitialSample();
  fixture.store.fail('diskTopology', new Error('NFS unavailable'));
  fixture.publish();
  assert.equal(fixture.session.ready, false);
  fixture.commit(['cpu', 'memory', 'network', 'sshTraffic', 'diskIo', 'accelerators']);
  await ready;
  assert.equal(fixture.session.viewState().hasSnapshot, true);
  assert.equal(fixture.session.ready, true);
  assert.equal(fixture.session.viewState().failures[0].key, 'diskTopology');
  assert.equal(fixture.session.loadError, null);
  fixture.session.service.collectOnce = async ({ onStart }) => { onStart(); fixture.commit(); };
  await fixture.session.retry();
  assert.equal(fixture.session.ready, true);
  assert.equal(fixture.session.loadError, null);
});

test('the first process page stays loading until process data arrives', (t) => {
  const fixture = createSessionFixture();
  t.after(() => fixture.session.dispose());
  fixture.commit(['cpu', 'memory', 'network', 'sshTraffic', 'diskIo', 'diskTopology', 'accelerators']);
  assert.equal(fixture.session.viewState().ready, true);
  assert.equal(fixture.session.viewState().processesReady, false);
  fixture.commit(['processes']);
  assert.equal(fixture.session.viewState().processesReady, true);
});

test('an NVML failure completes the first round while healthy resources remain usable', async (t) => {
  const fixture = createSessionFixture();
  t.after(() => fixture.session.dispose());
  const opened = fixture.session.waitForInitialSample();
  fixture.commit(['cpu', 'memory', 'network', 'sshTraffic', 'diskIo', 'diskTopology']);
  assert.equal(fixture.session.ready, false);
  fixture.store.fail('accelerators', new Error('Failed to initialize NVML: Driver/library version mismatch'));
  fixture.publish();
  await opened;
  assert.equal(fixture.session.ready, true);
  assert.equal(fixture.session.model.performance.cpu.usagePercent, 12);
  assert.equal(fixture.session.model.sources.accelerators.state, 'error');
  assert.equal(fixture.session.viewState().failures[0].key, 'accelerators');
  assert.match(fixture.session.viewState().failures[0].message, /NVML/);
});

test('failed initial CPU and memory queries remain unknown rather than zero', (t) => {
  const fixture = createSessionFixture();
  t.after(() => fixture.session.dispose());
  fixture.store.fail('cpu', new Error('cpu collection timed out'));
  fixture.store.fail('memory', new Error('memory collection timed out'));
  fixture.commit(['network', 'sshTraffic', 'diskIo', 'diskTopology', 'accelerators']);
  assert.equal(fixture.session.ready, true);
  assert.equal(fixture.session.model.performance.cpu.usagePercent, null);
  assert.equal(fixture.session.model.performance.memory.usagePercent, null);
  assert.equal(fixture.session.model.performance.memory.usedText, '--');
});

test('collection settings reach the SSH transport and the session stops following it once disposed', async () => {
  let config = normalizeConfig({});
  const fixture = createSessionFixture({ remote: true, id: 'ssh:lab', configStore: { getCurrent: () => config } });
  const options = [];
  fixture.transport.updateOptions = (value) => options.push(value);
  config = normalizeConfig({ collection: { custom: true, connectionTimeout: 20, sshPoolSize: 2 } });
  fixture.session.updateConfig();
  config = normalizeConfig({ collection: { custom: false, connectionTimeout: 20, sshPoolSize: 2 } });
  fixture.session.updateConfig();
  assert.deepEqual(options, [{ connectionTimeoutMilliseconds: 20000, maxConnections: 2 }, { connectionTimeoutMilliseconds: 15000, maxConnections: 4 }]);
  await fixture.transport.connect();
  assert.equal(fixture.session.state, 'connected');
  fixture.session.dispose();
  assert.equal(fixture.transport.stateListeners.size, 0);
  fixture.transport.emitState('disconnected', new Error('lost'));
  assert.equal(fixture.session.state, 'connected');
});

test('manual reconnection performs one requested round before restarting periodic collection', async (t) => {
  const fixture = createSessionFixture({ remote: true });
  t.after(() => fixture.session.dispose());
  let resumed = 0, collected = 0;
  fixture.session.running = true;
  fixture.session.service.resume = () => { resumed++; };
  fixture.session.service.collectOnce = async ({ onStart }) => { assert.equal(resumed, 0); collected++; onStart(); fixture.commit(); };
  fixture.session.setConnection('disconnected', new Error('SSH timeout'));
  await fixture.session.retry();
  assert.equal(collected, 1);
  assert.equal(resumed, 1);
  assert.equal(fixture.session.ready, true);
});

test('first display follows the configured collection budget and waits for a settled result', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const fixture = createSessionFixture({ configStore: { getCurrent: () => normalizeConfig({ collection: { custom: true, extendedTimeout: 120 } }) } });
  t.after(() => fixture.session.dispose());
  fixture.session.start();
  fixture.commit(['cpu', 'memory', 'network', 'sshTraffic', 'diskIo', 'diskTopology']);
  let displayed = false;
  const opened = fixture.session.waitForInitialSample();
  opened.then(() => { displayed = true; });
  t.mock.timers.tick(45000);
  await Promise.resolve();
  assert.equal(displayed, false);
  assert.equal(fixture.session.ready, false);
  assert.equal(fixture.session.snapshotState().viewModel, null);
  t.mock.timers.tick(75000);
  fixture.store.fail('accelerators', Object.assign(new Error('accelerators collection timed out'), { code: 'ETIMEDOUT' }));
  fixture.publish();
  await opened;
  assert.equal(fixture.session.ready, true);
  assert.equal(displayed, true);
  assert.equal(fixture.session.snapshotState().viewModel.sources.accelerators.state, 'error');
});

test('a long pause preserves the chart history when monitoring resumes', (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const fixture = createSessionFixture();
  t.after(() => fixture.session.dispose());
  fixture.commit();
  captureFrame(fixture.session);
  now = 3000;
  fixture.commit();
  captureFrame(fixture.session);
  fixture.session.setPaused(true);
  now += 3600000;
  fixture.session.setPaused(false);
  fixture.commit();
  assert.deepEqual(fixture.session.chartSamples().filter(sample => sample.source === 'cpu').map(sample => sample.t), [1000, 3000, 3603000]);
  assert.equal(fixture.session.chartSamples().filter(sample => sample.source === 'cpu').at(-1).gapBefore, true);
});

test('display-only settings retain the running chart clock and only interval edits restart it', t => {
  let config = normalizeConfig({});
  const fixture = createSessionFixture({ configStore:{ getCurrent:() => config } }); t.after(() => fixture.session.dispose());
  fixture.commit(); fixture.session.start();
  const timer = fixture.session.frameClock.timer, length = fixture.session.chartSamples().length;
  config = normalizeConfig({ display:{ charts:false } }); fixture.session.updateConfig();
  assert.equal(fixture.session.frameClock.timer, timer); assert.equal(fixture.session.chartSamples().length, length);
  config = normalizeConfig({ refreshInterval:5 }); fixture.session.updateConfig();
  assert.notEqual(fixture.session.frameClock.timer, timer); assert.equal(fixture.session.metricHistory.intervalMilliseconds, 5000);
});

test('an interval edit sends the new starting frame to live views and history together', t => {
  let now=0, config=normalizeConfig({}); const messages=[];
  t.mock.method(Date,'now',()=>now);
  const fixture=createSessionFixture({configStore:{getCurrent:()=>config},onUpdate:session=>messages.push(session.snapshotState())});
  t.after(()=>fixture.session.dispose()); fixture.commit(); fixture.session.start(); messages.length=0;
  now=1000; config=normalizeConfig({refreshInterval:5}); fixture.session.updateConfig();
  assert.equal(messages.length,1);
  assert.deepEqual(messages.flatMap(message=>message.samples.filter(sample=>sample.source==='cpu').map(sample=>sample.t)),[1000]);
  assert.deepEqual(fixture.session.chartSamples().filter(sample=>sample.source==='cpu').map(sample=>sample.t),[0,1000]);
});

test('an existing complete frame accepts early reconnect sources while a new list opening still waits', async t => {
  const fixture = createSessionFixture({ remote: true, id: 'ssh:fixture' }); t.after(() => fixture.session.dispose());
  await fixture.transport.connect(); fixture.commit(); assert.equal(fixture.session.hasInitialFrame, true);
  fixture.session.setConnection('disconnected', new Error('lost')); await fixture.transport.connect();
  let opened = false; const pending = fixture.session.waitForInitialSample().then(() => { opened = true; });
  fixture.commit(['cpu']);
  assert.equal(fixture.session.ready, false); assert.equal(fixture.session.snapshotState().status.canPresent, true);
  assert.equal(fixture.session.snapshotState().connection.canPresent, true); assert.ok(fixture.session.snapshotState().viewModel);
  await new Promise(setImmediate); assert.equal(opened, false);
  fixture.commit(); await pending; assert.equal(opened, true);
});

test('real service completion publishes the complete first snapshot before the next scheduler tick', async (t) => {
  const files = {
    '/proc/stat': 'cpu 10 0 10 80 0 0 0 0\n',
    '/proc/loadavg': '1 2 3 1/10 5\n',
    '/proc/meminfo': 'MemTotal: 1000 kB\nMemAvailable: 400 kB\n',
    '/proc/net/dev': 'Inter-| Receive | Transmit\nface | bytes\neth0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\n',
    '/proc/net/route': 'Iface Destination Gateway Flags\neth0 00000000 0 0003\n',
    '/proc/diskstats': '8 0 sda 0 0 10 0 0 0 20 0 0 0 0\n',
    '/proc/self/mountinfo': ['/', '/data', '/nfs-one', '/nfs-two'].map((target, index) => `${index + 1} 0 8:0 / ${target} rw - ${index < 2 ? 'ext4' : 'nfs'} source rw`).join('\n'),
  };
  const mounts = ['/', '/data', '/nfs-one', '/nfs-two'].map((target, index) => ({ target, fstype: index < 2 ? 'ext4' : 'nfs', size: 1000, used: 400, avail: 600, 'use%': '40%' }));
  let cpuReads = 0;
  const readFile = async (file) => file === '/proc/stat' ? `cpu ${++cpuReads * 10} 0 10 80 0 0 0 0\ncpu0 1 0 1 8\ncpu1 1 0 1 8\ncpu2 1 0 1 8\ncpu3 1 0 1 8\n` : files[file];
  const resources = resourceCommandRunner(readFile);
  const session = new MonitorSession({
    configStore: { getCurrent: () => normalizeConfig({}) },
    serviceOptions: {
      fileReader: { readFile },
      systemInfo: { coreCount: async () => 4, totalMemoryBytes: async () => 1024000 },
      commandRunner: { dispose() {}, async execFile(command, args) {
        if (command === 'sh' && args[1].includes('__SYSMON_RESOURCE_')) return resources.execFile(command, args);
        if (command === 'nvidia-smi') throw Object.assign(new Error('no GPU'), { code: 'ENOENT' });
        if (command === 'findmnt') return { stdout: JSON.stringify({ filesystems: mounts }) };
        return { stdout: '' };
      } },
    },
  });
  t.after(() => session.dispose());
  session.start();
  await new Promise(setImmediate);
  assert.equal(session.ready, false);
  assert.equal(session.snapshotState().viewModel, null);
  await session.waitForInitialSample();
  assert.equal(session.ready, true);
  assert.equal(cpuReads, 2);
  assert.ok(Number.isFinite(session.model.performance.cpu.usagePercent));
  assert.ok(Number.isFinite(session.model.performance.network.receiveBytesPerSecond));
  assert.ok(Number.isFinite(session.model.performance.diskIo.readBytesPerSecond));
  assert.deepEqual(session.model.performance.disks.map((disk) => disk.mount), ['/', '/data', '/nfs-one', '/nfs-two']);
  assert.ok(session.chartSamples().length > 0);
});

test('re-enabling process demand hides earlier rows until the next process sample publishes', t => {
  const fixture = createSessionFixture();
  t.after(() => fixture.session.dispose());
  const { session, store, values } = fixture;
  const row = { pid: 7, processKey: '7:1', userName: 'alice', processName: 'python', commandLine: 'python train.py', cpuUsagePercent: 5, cpuWhole: 1.25, memoryUsedBytes: 2048, memoryUsagePercent: 1, session: null };
  session.setProcessDemand(true);
  values.processes = { rows: [row], totalCount: 1 };
  fixture.commit();
  assert.equal(session.snapshotState().viewModel.processes.length, 1);
  assert.equal(session.snapshotState().status.processesReady, true);
  session.setProcessDemand(false);
  assert.deepEqual(session.snapshotState().viewModel.processes, []);
  assert.equal(session.snapshotState().viewModel.sources.processes.state, 'disabled');
  session.setProcessDemand(true);
  assert.deepEqual(session.snapshotState().viewModel.processes, []);
  assert.equal(session.snapshotState().status.processesReady, false);
  store.commit('cpu', { ...values.cpu, usagePercent: 90 });
  store.commit('processes', { rows: [{ ...row, cpuUsagePercent: 9 }], totalCount: 1 });
  session.acceptInitialSnapshot(store.read());
  assert.equal(session.snapshotState().viewModel.processes[0].cpu, 9);
  assert.equal(session.snapshotState().status.processesReady, true);
  assert.equal(session.model.performance.cpu.usagePercent, 12);
});

test('process demand changes are idempotent and wait for an initial model before publishing', t => {
  const updates = [];
  const fixture = createSessionFixture({ onUpdate: () => updates.push('update') });
  t.after(() => fixture.session.dispose());
  fixture.session.setProcessDemand(false);
  fixture.session.setProcessDemand(true);
  assert.deepEqual(updates, []);
  assert.equal(fixture.session.service.processDemand, true);
  fixture.commit();
  updates.length = 0;
  fixture.session.setProcessDemand(true);
  assert.deepEqual(updates, []);
});

test('pausing an SSH device keeps one idle channel and resuming restores the pool', async t => {
  const fixture = createSessionFixture({ remote: true, id: 'ssh:lab' });
  t.after(() => fixture.session.dispose());
  await fixture.transport.connect();
  fixture.session.start();
  assert.equal(fixture.transport.idle, false);
  fixture.session.pause();
  assert.equal(fixture.transport.idle, true);
  fixture.session.resume();
  assert.equal(fixture.transport.idle, false);
});

test('enabling process demand on a running service collects immediately', async t => {
  const hiddenGroups = { cpu: true, memory: true, disk: true, network: true, gpuCards: true, gpuSummary: true };
  const service = new MonitorService({ runtimeConfig: normalizeConfig({ display: { hiddenGroups }, statusBar: { barEnabled: false } }), isSsh: false });
  t.after(() => service.dispose());
  const runner = service.runners.find(item => item.key === 'processes');
  let calls = 0;
  runner.collector = { async collect() { calls++; return { rows: [], totalCount: 0 }; } };
  service.start();
  await new Promise(setImmediate);
  assert.equal(runner.enabled, false);
  assert.equal(calls, 0);
  service.setProcessDemand(true);
  await new Promise(setImmediate); await runner.idle;
  assert.equal(calls, 1);
  assert.equal(service.readSnapshot().processes.status, 'fresh');
  service.setProcessDemand(false);
  assert.equal(service.readSnapshot().processes.status, 'disabled');
  assert.equal(service.readSnapshot().processes.value, null);
  service.pause();
  service.setProcessDemand(true);
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  service.resume({ force: true });
  await new Promise(setImmediate); await runner.idle;
  assert.equal(calls, 2);
});

test('the device manager applies process demand to existing and later devices', t => {
  const { DeviceMonitorManager } = require('../src/services/device-monitor-manager');
  const manager = new DeviceMonitorManager({ localLinux: false,
    configStore: { getSaveState: () => ({ status: 'saved', error: null }), getCurrent: () => normalizeConfig({}) } });
  t.after(() => manager.dispose());
  const demands = [];
  manager.devices.set('ssh:a', { setProcessDemand: value => demands.push(['a', value]), dispose() {} });
  manager.devices.set('ssh:b', { setProcessDemand: value => demands.push(['b', value]), dispose() {} });
  manager.setProcessDemand(['ssh:b', 'ssh:c']);
  assert.deepEqual(demands, [['a', false], ['b', true]]);
  manager.setPaused(true);
  assert.equal(manager.open('ssh:c').service.processDemand, true);
  assert.equal(manager.open('ssh:d').service.processDemand, false);
});
