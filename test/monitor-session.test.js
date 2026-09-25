'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSessionFixture } = require('./session-fixture');
const { MonitorService } = require('../src/services/monitor-service');
const { normalizeConfig } = require('../src/config/normalize-config');
const { MonitorSession } = require('../src/services/monitor-session');

for (const remote of [false, true]) {
  test((remote ? 'SSH' : 'direct') + ' session waits for complete first data and publishes immediately', async (t) => {
    const updates = [];
    const fixture = createSessionFixture({ remote, id: remote ? 'ssh:lab' : 'local', onUpdate: (session) => updates.push(session.snapshotMessage()) });
    t.after(() => fixture.session.dispose());
    if (remote) await fixture.transport.connect();
    fixture.commit(['cpu', 'memory', 'diskIo', 'diskTopology']);
    assert.equal(fixture.session.model, null);
    assert.equal(fixture.session.viewState().loading, true);
    const ready = fixture.session.waitForInitialSample();
    fixture.commit(['accelerators']);
    await ready;
    assert.equal(fixture.session.ready, true);
    assert.equal(updates.at(-1).viewModel.performance.cpu.usagePercent, 12);
    assert.deepEqual(updates.at(-1).viewModel.performance.gpus, []);
    assert.equal(fixture.session.history.length, 1);
  });
}

test('direct and SSH services use identical collector deadlines and command budgets', () => {
  const options = { runtimeConfig: normalizeConfig({}), isSsh: false };
  const direct = new MonitorService(options);
  const ssh = new MonitorService({ ...options, commandRunner: { dispose() {} }, fileReader: {}, systemInfo: {} });
  try {
    const policy = (service) => service.runners.map((runner) => [runner.key, runner.timeoutMilliseconds, runner.cadenceMilliseconds, runner.collector.timeoutMilliseconds]);
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
  const history = session.history.slice();
  session.setConnection('disconnected', new Error('connection lost'));
  fixture.commit();
  assert.equal(session.model, model);
  assert.deepEqual(session.history, history);
  session.setConnection('connected');
  for (const key of ['cpu', 'memory', 'diskIo', 'diskTopology', 'accelerators']) {
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
  const history = session.history.slice();
  session.setPaused(true);
  session.setConnection('disconnected', new Error('lost'));
  let attempts = 0;
  fixture.transport.retryNow = async () => { attempts++; session.setConnection('connected'); };
  session.service.resume = function() { this.scheduler.isPaused = false; setImmediate(() => fixture.commit()); };
  const first = session.retry();
  const second = session.retry();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(attempts, 1);
  assert.equal(session.service.scheduler.isPaused, true);
  assert.deepEqual(session.history, history);
  assert.equal(session.snapshotMessage().skipHistory, true);
});

test('failed paused retry stops its one-shot collection', async (t) => {
  const fixture = createSessionFixture({ paused: true });
  const session = fixture.session;
  t.after(() => session.dispose());
  session.service.resume = function() {
    this.scheduler.isPaused = false;
    setImmediate(() => { session.loadError = 'sample failed'; session.settleWaiters(); });
  };
  await assert.rejects(session.retry(), /sample failed/);
  assert.equal(session.service.scheduler.isPaused, true);
  assert.equal(session.paused, true);
});

test('each new view receives the same shared snapshot and history', (t) => {
  const fixture = createSessionFixture();
  t.after(() => fixture.session.dispose());
  fixture.commit();
  const first = fixture.session.snapshotMessage(true);
  const second = fixture.session.snapshotMessage(true);
  assert.deepEqual(first.samples, second.samples);
  assert.equal(first.viewModel, second.viewModel);
  assert.equal(first.skipHistory, true);
});

test('first-sample failure is explicit and a subsequent retry can recover', async (t) => {
  const fixture = createSessionFixture();
  t.after(() => fixture.session.dispose());
  const ready = fixture.session.waitForInitialSample();
  const rejected = assert.rejects(ready, /NFS unavailable/);
  fixture.store.fail('diskTopology', new Error('NFS unavailable'));
  fixture.publish();
  await rejected;
  assert.equal(fixture.session.viewState().hasSnapshot, false);
  assert.equal(fixture.session.loadError, 'NFS unavailable');
  fixture.session.service.resume = function() { setImmediate(() => fixture.commit()); };
  await fixture.session.retry();
  assert.equal(fixture.session.ready, true);
  assert.equal(fixture.session.loadError, null);
});

test('the first process page stays loading until process data arrives', (t) => {
  const fixture = createSessionFixture();
  t.after(() => fixture.session.dispose());
  fixture.commit(['cpu', 'memory', 'diskIo', 'diskTopology', 'accelerators']);
  assert.equal(fixture.session.viewState().ready, true);
  assert.equal(fixture.session.viewState().processesReady, false);
  fixture.commit(['processes']);
  assert.equal(fixture.session.viewState().processesReady, true);
});

test('a long pause preserves the chart history when monitoring resumes', (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const fixture = createSessionFixture();
  t.after(() => fixture.session.dispose());
  fixture.commit();
  now = 3000;
  fixture.commit();
  fixture.session.setPaused(true);
  now += 3600000;
  fixture.session.setPaused(false);
  fixture.commit();
  assert.deepEqual(fixture.session.history.map((point) => point.t), [1000, 3000, 3603000]);
});

test('real service completion publishes the complete first snapshot before the next scheduler tick', async (t) => {
  const files = {
    '/proc/stat': 'cpu 10 0 10 80 0 0 0 0\n',
    '/proc/meminfo': 'MemTotal: 1000 kB\nMemAvailable: 400 kB\n',
    '/proc/net/dev': 'Inter-| Receive | Transmit\nface | bytes\neth0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\n',
    '/proc/net/route': 'Iface Destination Gateway Flags\neth0 00000000 0 0003\n',
    '/proc/diskstats': '8 0 sda 0 0 10 0 0 0 20 0 0 0 0\n',
  };
  const mounts = ['/', '/data', '/nfs-one', '/nfs-two'].map((target, index) => ({ target, fstype: index < 2 ? 'ext4' : 'nfs', size: 1000, used: 400, avail: 600, 'use%': '40%' }));
  const session = new MonitorSession({
    configStore: { getCurrent: () => normalizeConfig({}) }, language: 'en',
    serviceOptions: {
      fileReader: { readFile: async (file) => files[file] },
      systemInfo: { cpuInfo: async () => ({ coreCount: 4, loadAverage: [1, 2, 3] }), totalMemoryBytes: async () => 1024000 },
      commandRunner: { dispose() {}, async execFile(command) {
        if (command === 'nvidia-smi') throw Object.assign(new Error('no GPU'), { code: 'ENOENT' });
        if (command === 'findmnt') return { stdout: JSON.stringify({ filesystems: mounts }) };
        return { stdout: '' };
      } },
    },
  });
  t.after(() => session.dispose());
  session.start();
  await new Promise(setImmediate);
  assert.equal(session.ready, true);
  assert.deepEqual(session.model.performance.disks.map((disk) => disk.mount), ['/', '/data', '/nfs-one', '/nfs-two']);
  assert.equal(session.history.length, 1);
});
