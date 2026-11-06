'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { ServerDirectory } = require('../src/view/server-directory');
const { createSessionFixture } = require('./session-fixture');

function directoryFixture(t) {
  const phases = [];
  const prepared = [];
  const fixture = createSessionFixture({ remote: true, id: 'ssh:lab' });
  const directory = new ServerDirectory({
    vscode: {}, manager: {
      paused: false, get: () => fixture.session, open: () => fixture.session,
      setPreparing: (_id, enabled) => prepared.push(enabled),
    },
    onChange: (rows) => phases.push(rows[0].state),
  });
  directory.hosts = ['lab'];
  fixture.session.onUpdate = () => directory.onDeviceUpdate('ssh:lab', fixture.session);
  t.after(() => { directory.dispose(); fixture.session.dispose(); });
  return { ...fixture, directory, phases, prepared };
}

test('empty server summaries distinguish disabled metrics, pending samples and failures', () => {
  const sources={cpu:{state:'disabled'},memory:{state:'disabled'},accelerators:{state:'disabled'}};
  const device={state:'connected',model:{sources,performance:{cpu:{},memory:{},gpus:[]}}};
  const directory=new ServerDirectory({vscode:{},manager:{get:()=>device}});directory.hosts=['lab'];
  assert.deepEqual(directory.rows()[0].metrics,[]);assert.equal(directory.rows()[0].summaryLoading,false);
  sources.cpu={state:'loading'};assert.equal(directory.rows()[0].summaryLoading,true);
  sources.cpu.state='error';assert.equal(directory.rows()[0].summaryLoading,false);
  sources.accelerators={state:'ready'};device.model.performance.gpus=[{availability:'unknown',isIdle:false}];
  assert.deepEqual(directory.rows()[0].metrics,['GPU --/1']);directory.dispose();
});

test('server rows notify only when a row summary changes', () => {
  const ready = { state: 'ready' };
  const device = { host: 'lab', state: 'connected', error: null, model: { sources: { cpu: ready, memory: ready, accelerators: ready }, performance: { cpu: { usagePercent: 10 }, memory: { usagePercent: 20 }, gpus: [] } } };
  const notifications = [];
  const directory = new ServerDirectory({ vscode: {}, manager: { get: (id) => (id === 'ssh:lab' ? device : null) }, onChange: (rows, error) => notifications.push([rows.map((row) => row.metrics.join(' ')), error]) });
  directory.hosts = ['lab'];
  directory.onDeviceUpdate('ssh:lab', device);
  directory.onDeviceUpdate('ssh:lab', device);
  device.model.performance.cpu.usagePercent = 11;
  directory.onDeviceUpdate('ssh:lab', device);
  directory.onDeviceUpdate('local', { state: 'connected', host: null, error: null });
  directory.notify('config unreadable');
  directory.notify('config unreadable');
  assert.deepEqual(notifications, [[['CPU 10% RAM 20%'], null], [['CPU 11% RAM 20%'], null], [[], 'config unreadable']]);
  assert.deepEqual(directory.current(), { hosts: [], error: 'config unreadable' });
  directory.notify();
  assert.deepEqual(directory.current().hosts.map((row) => row.metrics), [['CPU 11%', 'RAM 20%']]);
  directory.dispose();
});

test('server summaries use the published model until the next snapshot update', async t => {
  const fixture = directoryFixture(t);
  await fixture.transport.connect(); fixture.commit();
  const metrics = fixture.directory.rows()[0].metrics;
  fixture.store.fail('cpu', new Error('collection timed out'));
  assert.deepEqual(fixture.directory.rows()[0].metrics, metrics);
  fixture.publish();
  assert.equal(fixture.directory.rows()[0].metrics.some(value => value.startsWith('CPU')), false);
});

test('monitor opens after a complete rendered sample, including a valid empty GPU result', async (t) => {
  const fixture = directoryFixture(t);
  let opened = false;
  const action = fixture.directory.runMonitorAction('lab', async () => { opened = true; });
  await new Promise(setImmediate);
  fixture.commit(['cpu', 'memory', 'network', 'sshTraffic', 'diskIo', 'diskTopology']);
  assert.equal(opened, false);
  assert.deepEqual(fixture.phases, ['connecting', 'loading']);
  fixture.commit(['accelerators']);
  await action;
  assert.equal(opened, true);
  assert.deepEqual(fixture.prepared, [true, false]);
});

test('an existing complete sample opens immediately even when one collector has since advanced', async (t) => {
  const fixture = directoryFixture(t);
  await fixture.transport.connect();
  fixture.commit();
  fixture.phases.length = 0;
  fixture.store.commit('diskIo', fixture.values.diskIo, Date.now() + 1);
  let opened = 0;
  await fixture.directory.runMonitorAction('lab', async () => { opened++; });
  assert.equal(opened, 1);
  assert.deepEqual(fixture.prepared, []);
  assert.deepEqual(fixture.phases, []);
});

test('opening from the server list uses the same settled initial snapshot when a module fails', async (t) => {
  const fixture = directoryFixture(t);
  let message = null;
  const action = fixture.directory.runMonitorAction('lab', async () => { message = fixture.session.snapshotMessage(true); });
  await new Promise(setImmediate);
  fixture.commit(['cpu', 'memory', 'network', 'sshTraffic', 'diskIo', 'accelerators']);
  assert.equal(message, null);
  assert.equal(fixture.session.snapshotMessage().viewModel, null);
  fixture.store.fail('diskTopology', new Error('df: /nfs: Input/output error'));
  fixture.publish();
  await action;
  assert.equal(message.status.ready, true);
  assert.equal(message.viewModel.performance.cpu.usagePercent, 12);
  assert.equal(message.viewModel.sources.diskTopology.state, 'error');
});

test('reconnection waits for all required partitions from the new connection', async (t) => {
  const fixture = directoryFixture(t);
  await fixture.transport.connect();
  fixture.commit();
  fixture.session.setConnection('disconnected', new Error('lost'));
  const action = fixture.directory.runMonitorAction('lab', async () => { fixture.opened = true; });
  await new Promise(setImmediate);
  for (const key of ['cpu', 'memory', 'network', 'sshTraffic', 'diskIo', 'diskTopology', 'accelerators']) {
    fixture.store.commit(key, fixture.values[key], fixture.session.requiredSince - 1);
  }
  fixture.commit(['cpu']);
  assert.equal(fixture.opened, undefined);
  fixture.commit();
  await action;
  assert.equal(fixture.opened, true);
});

test('a retry and a view can await the same sample without replacing each other', async (t) => {
  const fixture = directoryFixture(t);
  await fixture.transport.connect();
  const first = fixture.directory.waitForInitialSample('lab', 0);
  const second = fixture.directory.waitForInitialSample('lab', 0, { allowPaused: true });
  fixture.commit();
  await Promise.all([first, second]);
  assert.equal(fixture.session.waiters.size, 0);
});

test('disposing the directory cancels pending opens without closing a shared session', async (t) => {
  const fixture = directoryFixture(t);
  let opened = false;
  const action = fixture.directory.runMonitorAction('lab', async () => { opened = true; });
  await new Promise(setImmediate);
  fixture.directory.dispose();
  await action;
  assert.equal(opened, false);
  assert.equal(fixture.session.disposed, false);
  assert.equal(fixture.session.waiters.size, 0);
});

test('the latest server-list refresh wins when config reads finish out of order', async () => {
  const reads = [];
  const applied = [];
  let configFile = 'first';
  const directory = new ServerDirectory({
    vscode: { workspace: { getConfiguration: () => ({ get: () => configFile }) } },
    manager: { setConfigFile: (file) => applied.push(file), get: () => null },
    loadHosts: () => new Promise((resolve) => reads.push(resolve)),
  });
  const first = directory.refresh();
  configFile = 'second';
  const second = directory.refresh();
  reads[1](['current']);
  await second;
  reads[0](['outdated']);
  await first;
  assert.deepEqual(directory.hosts, ['current']);
  assert.deepEqual(applied, ['second']);
  directory.dispose();
});

test('a server-list refresh finishing after disposal does not touch connections', async () => {
  let finish;
  const directory = new ServerDirectory({
    vscode: { workspace: { getConfiguration: () => ({ get: () => null }) } },
    manager: { setConfigFile() { assert.fail('disposed directory changed connections'); } },
    loadHosts: () => new Promise((resolve) => { finish = resolve; }),
    onChange() { assert.fail('disposed directory notified a view'); },
  });
  const refresh = directory.refresh();
  directory.dispose();
  finish(['lab']);
  await refresh;
  assert.deepEqual(directory.hosts, []);
});

test('terminal and Remote-SSH actions leave the monitor row unchanged', async () => {
  const phases = [];
  const directory = new ServerDirectory({
    vscode: {}, manager: { get: () => null, configFile: null },
    onChange: (rows) => phases.push(rows[0].state),
  });
  directory.hosts = ['lab'];
  let opened = 0;
  await directory.runShortcutAction('lab', 'terminal', async () => { opened++; });
  await directory.runShortcutAction('lab', 'remoteWindow', async () => { opened++; });
  assert.equal(opened, 2);
  assert.deepEqual(phases, []);
  assert.equal(directory.rows()[0].state, 'idle');
  assert.equal(directory.rows()[0].busy, false);
  directory.dispose();
});

test('shortcut actions preserve monitor errors and report their own launch failures', async () => {
  const errors = [];
  const phases = [];
  const directory = new ServerDirectory({
    vscode: { window: { showErrorMessage: (message) => errors.push(message) } },
    manager: { get: () => null },
    onChange: (rows) => phases.push(rows[0].state),
  });
  directory.hosts = ['lab'];
  directory.hostErrors.set('lab', { message: 'monitor connection failed' });
  await directory.runShortcutAction('lab', 'terminal', async () => {});
  await directory.runShortcutAction('lab', 'remoteWindow', async () => { throw new Error('window could not open'); });
  assert.deepEqual(phases, []);
  assert.deepEqual(errors, ['window could not open']);
  assert.equal(directory.rows()[0].error, 'monitor connection failed');
  directory.dispose();
});

test('terminal shortcut does not reconnect a disconnected monitor device', async () => {
  let monitorReconnects = 0;
  const device = {
    state: 'disconnected', error: 'monitor SSH closed', model: null,
    transport: { async connect() { monitorReconnects++; } },
    service: { readSnapshot: () => ({}) },
  };
  const phases = [];
  const directory = new ServerDirectory({
    vscode: {}, manager: { get: () => device, configFile: null },
    onChange: (rows) => phases.push(rows[0].state),
  });
  directory.hosts = ['lab'];
  await directory.runShortcutAction('lab', 'terminal', async () => {});
  assert.equal(monitorReconnects, 0);
  assert.equal(device.state, 'disconnected');
  assert.deepEqual(phases, []);
  assert.equal(directory.rows()[0].state, 'disconnected');
  directory.dispose();
});
