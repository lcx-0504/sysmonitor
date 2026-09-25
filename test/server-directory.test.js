'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ServerDirectory } = require('../src/view/server-directory');

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

test('monitor opens only after CPU, memory, disk and GPU data reach the rendered snapshot', async () => {
  const readyAt = Date.now() + 60000;
  const snapshot = Object.fromEntries(['cpu', 'memory', 'diskIo', 'diskTopology', 'accelerators'].map((key) => [key, { status: 'loading', collectedAt: null }]));
  const prepared = [];
  const phases = [];
  const device = {
    id: 'ssh:lab', host: 'lab', state: 'connecting', model: null, history: [],
    transport: { async connect() { device.state = 'connected'; } },
    service: { readSnapshot: () => snapshot, scheduler: { isPaused: true } },
  };
  const manager = {
    paused: false, get: () => device, open: () => device,
    setPreparing: (id, enabled) => prepared.push([id, enabled]),
  };
  const directory = new ServerDirectory({ vscode: {}, manager, onChange: (rows) => phases.push(rows[0] && rows[0].state) });
  directory.hosts = ['lab'];
  let opened = false;
  const action = directory.runMonitorAction('lab', async () => { opened = true; });
  await new Promise(setImmediate);
  assert.equal(opened, false);
  assert.deepEqual(prepared, [['ssh:lab', true]]);
  assert.deepEqual(phases.slice(0, 2), ['connecting', 'loading']);
  for (const key of ['cpu', 'memory', 'diskIo', 'diskTopology']) snapshot[key] = { status: 'fresh', collectedAt: readyAt };
  device.model = { performance: { cpu: { usagePercent: 10 }, memory: { usagePercent: 20 }, gpus: [] } };
  device.history.push({ t: readyAt });
  directory.onDeviceUpdate(device.id, device);
  assert.equal(opened, false);
  snapshot.accelerators = { status: 'fresh', collectedAt: readyAt, value: { devices: [] } };
  directory.onDeviceUpdate(device.id, device);
  await action;
  assert.equal(opened, true);
  assert.deepEqual(prepared.at(-1), ['ssh:lab', false]);
  directory.dispose();
});

test('a retry and a new monitor view can wait for the same fresh sample', async () => {
  const now = Date.now();
  const snapshot = Object.fromEntries(['cpu', 'memory', 'diskIo', 'diskTopology', 'accelerators'].map((key) => [key, { status: 'loading', collectedAt: null }]));
  const device = {
    id: 'ssh:lab', host: 'lab', state: 'connected', model: { performance: {} }, history: [{ t: now }],
    service: { readSnapshot: () => snapshot },
  };
  const directory = new ServerDirectory({ vscode: {}, manager: { paused: false, get: () => device } });
  const retryWait = directory.waitForInitialSample('lab', now, { allowPaused: true });
  const viewWait = directory.waitForInitialSample('lab', now);
  for (const part of Object.values(snapshot)) { part.status = 'fresh'; part.collectedAt = now; }
  directory.onDeviceUpdate(device.id, device);
  await Promise.all([retryWait, viewWait]);
  assert.equal(directory.initialSampleWaiters.size, 0);
  directory.dispose();
});

test('paused one-shot retry settles from the rendered model without a new history point', async () => {
  const now = Date.now();
  const snapshot = Object.fromEntries(['cpu', 'memory', 'diskIo', 'diskTopology', 'accelerators'].map((key) => [key, { status: 'fresh', collectedAt: now }]));
  const device = {
    id: 'ssh:lab', host: 'lab', state: 'connected', model: { performance: {} }, modelAt: now - 1,
    history: [{ t: now - 10000 }], service: { readSnapshot: () => snapshot },
  };
  const directory = new ServerDirectory({ vscode: {}, manager: { paused: true, get: () => device } });
  const wait = directory.waitForInitialSample('lab', now, { allowPaused: true });
  assert.equal(directory.initialSampleWaiters.size, 1);
  device.modelAt = now;
  directory.onDeviceUpdate(device.id, device);
  await wait;
  assert.deepEqual(device.history, [{ t: now - 10000 }]);
  directory.dispose();
});

test('an already connected server opens from cached data without transient loading', async () => {
  const collectedAt = Date.now();
  const snapshot = Object.fromEntries(['cpu', 'memory', 'diskIo', 'diskTopology', 'accelerators'].map((key) => [key, { status: 'fresh', collectedAt }]));
  let reconnects = 0;
  let preparing = 0;
  let opens = 0;
  const device = {
    state: 'connected', model: { performance: { cpu: { usagePercent: 12 }, memory: { usagePercent: 25 }, gpus: [] } },
    history: [{ t: collectedAt }], transport: { async connect() { reconnects++; } },
    service: { scheduler: { isPaused: false }, readSnapshot: () => snapshot },
  };
  const phases = [];
  const directory = new ServerDirectory({
    vscode: {}, manager: { paused: false, get: () => device, setPreparing() { preparing++; } },
    onChange: (rows) => phases.push(rows[0].state),
  });
  directory.hosts = ['lab'];
  await directory.runMonitorAction('lab', async () => { opens++; });
  assert.equal(opens, 1);
  assert.equal(reconnects, 0);
  assert.equal(preparing, 0);
  assert.deepEqual(phases, []);
  assert.equal(directory.rows()[0].state, 'connected');
  directory.dispose();
});

test('a later collector update does not restart initial loading for an open server', async () => {
  const collectedAt = Date.now();
  const snapshot = Object.fromEntries(['cpu', 'memory', 'diskIo', 'diskTopology', 'accelerators'].map((key) => [key, { status: 'fresh', collectedAt }]));
  const device = {
    id: 'ssh:lab', host: 'lab', state: 'connected',
    model: { performance: { cpu: { usagePercent: 12 }, memory: { usagePercent: 25 }, gpus: [] } },
    history: [{ t: collectedAt }], transport: { async connect() { throw new Error('already connected'); } },
    service: { scheduler: { isPaused: false }, readSnapshot: () => snapshot },
  };
  const phases = [];
  const directory = new ServerDirectory({
    vscode: {}, manager: { paused: false, get: () => device, setPreparing() { throw new Error('should not prepare again'); } },
    onChange: (rows) => phases.push(rows[0].state),
  });
  directory.hosts = ['lab'];
  directory.onDeviceUpdate(device.id, device);
  phases.length = 0;
  snapshot.diskIo.collectedAt = collectedAt + 1;
  assert.equal(directory.initialSampleReady(device, 0), false);
  let opened = false;
  await directory.runMonitorAction('lab', async () => { opened = true; });
  assert.equal(opened, true);
  assert.deepEqual(phases, []);
  assert.equal(directory.rows()[0].state, 'connected');
  directory.dispose();
});

test('a real reconnect waits for a new complete sample', async () => {
  const oldTime = Date.now() - 10000;
  const snapshot = Object.fromEntries(['cpu', 'memory', 'diskIo', 'diskTopology', 'accelerators'].map((key) => [key, { status: 'fresh', collectedAt: oldTime }]));
  const device = {
    id: 'ssh:lab', host: 'lab', state: 'connected',
    model: { performance: { cpu: { usagePercent: 12 }, memory: { usagePercent: 25 }, gpus: [] } },
    history: [{ t: oldTime }], transport: { async connect() {} },
    service: { scheduler: { isPaused: false }, readSnapshot: () => snapshot },
  };
  const phases = [];
  const directory = new ServerDirectory({
    vscode: {}, manager: { paused: false, get: () => device, setPreparing() {} },
    onChange: (rows) => phases.push(rows[0].state),
  });
  directory.hosts = ['lab'];
  directory.onDeviceUpdate(device.id, device);
  device.state = 'disconnected';
  directory.onDeviceUpdate(device.id, device);
  device.state = 'connected';
  directory.onDeviceUpdate(device.id, device);
  phases.length = 0;
  let opened = false;
  const action = directory.runMonitorAction('lab', async () => { opened = true; });
  await new Promise(setImmediate);
  assert.equal(opened, false);
  assert.equal(phases[0], 'loading');
  const newTime = Date.now() + 10000;
  for (const part of Object.values(snapshot)) part.collectedAt = newTime;
  device.history.push({ t: newTime });
  directory.onDeviceUpdate(device.id, device);
  await action;
  assert.equal(opened, true);
  assert.equal(directory.rows()[0].state, 'connected');
  directory.dispose();
});

test('a connected server with incomplete data shows loading without reconnecting', async () => {
  const collectedAt = Date.now();
  const snapshot = Object.fromEntries(['cpu', 'memory', 'diskIo', 'diskTopology', 'accelerators'].map((key) => [key, { status: 'fresh', collectedAt }]));
  snapshot.accelerators.status = 'loading';
  let reconnects = 0;
  let opened = false;
  const device = {
    id: 'ssh:lab', host: 'lab', state: 'connected',
    model: { performance: { cpu: { usagePercent: 12 }, memory: { usagePercent: 25 }, gpus: [] } },
    history: [{ t: collectedAt }], transport: { async connect() { reconnects++; } },
    service: { scheduler: { isPaused: false }, readSnapshot: () => snapshot },
  };
  const phases = [];
  const directory = new ServerDirectory({
    vscode: {}, manager: { paused: false, get: () => device, setPreparing() {} },
    onChange: (rows) => phases.push(rows[0].state),
  });
  directory.hosts = ['lab'];
  const action = directory.runMonitorAction('lab', async () => { opened = true; });
  await new Promise(setImmediate);
  assert.equal(opened, false);
  assert.equal(reconnects, 0);
  assert.deepEqual(phases, ['loading']);
  snapshot.accelerators.status = 'fresh';
  directory.onDeviceUpdate(device.id, device);
  await action;
  assert.equal(opened, true);
  assert.equal(phases.includes('connecting'), false);
  assert.equal(directory.rows()[0].state, 'connected');
  directory.dispose();
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

test('disposing during initial sampling cancels the pending open', async () => {
  const device = {
    id: 'ssh:lab', host: 'lab', state: 'connecting', model: null, history: [],
    transport: { async connect() { device.state = 'connected'; } },
    service: { readSnapshot: () => ({}), scheduler: { isPaused: false } },
  };
  const prepared = [];
  const directory = new ServerDirectory({ vscode: {}, manager: {
    paused: false, get: () => device, open: () => device,
    setPreparing: (id, enabled) => prepared.push([id, enabled]),
  } });
  let opened = false;
  const action = directory.runMonitorAction('lab', async () => { opened = true; });
  await new Promise(setImmediate);
  directory.dispose();
  await action;
  assert.equal(opened, false);
  assert.equal(directory.hostErrors.size, 0);
  assert.deepEqual(prepared.at(-1), ['ssh:lab', false]);
});
