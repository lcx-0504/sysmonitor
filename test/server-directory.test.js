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

test('monitor opens after a complete rendered sample, including a valid empty GPU result', async (t) => {
  const fixture = directoryFixture(t);
  let opened = false;
  const action = fixture.directory.runMonitorAction('lab', async () => { opened = true; });
  await new Promise(setImmediate);
  fixture.commit(['cpu', 'memory', 'diskIo', 'diskTopology']);
  assert.equal(opened, false);
  assert.deepEqual(fixture.phases.slice(0, 2), ['connecting', 'connecting']);
  assert.ok(fixture.phases.includes('loading'));
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

test('reconnection waits for all required partitions from the new connection', async (t) => {
  const fixture = directoryFixture(t);
  await fixture.transport.connect();
  fixture.commit();
  fixture.session.setConnection('disconnected', new Error('lost'));
  const action = fixture.directory.runMonitorAction('lab', async () => { fixture.opened = true; });
  await new Promise(setImmediate);
  for (const key of ['cpu', 'memory', 'diskIo', 'diskTopology', 'accelerators']) {
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
