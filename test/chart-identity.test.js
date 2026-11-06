'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { initialize,harness,points,gpu,MetricHistory,SnapshotStore,buildMonitorViewModel,parseNvidiaCards } = require('./chart-fixture');
let charts,data,state;
test.before(async () => { ({charts,data,state}=await initialize()); });

test('each GPU retains the disabled gap when valid utilization resumes on different frames', t => {
  const h=harness(t);
  const devices=(a,b)=>[{idx:0,deviceKey:'a',util:a},{idx:1,deviceKey:'b',util:b}];
  h.record('accelerators',devices(20,30),0);
  h.time(1000); h.model.sources.accelerators.state='disabled'; h.history.syncSources(h.model,1000);
  h.time(5000); h.model.sources.accelerators.state='loading'; h.history.syncSources(h.model,5000);
  h.record('accelerators',devices(40,null),6000);
  assert.equal(state.charts.gpus[0].at(-1).gapBefore,true);
  h.record('accelerators',devices(50,60),8000);
  assert.equal(state.charts.gpus[1].at(-1).gapBefore,true);
  h.restore();
  assert.equal(state.charts.gpus[1].at(-1).gapBefore,true);
});

test('GPU core measurements delivered after ownership lookup retain one full interval of lookahead', t => {
  const h = harness(t), store = new SnapshotStore();
  for (const [sampleAt, readyAt, util] of [[0,300,20],[2000,2300,60],[4000,4300,40]]) {
    h.time(readyAt);
    store.commit('accelerators', { devices:parseNvidiaCards('0, A100, '+util+', 100, 1000, 45, 50, 300, GPU-a'),
      usagesByPid:new Map(), currentUserDeviceKeys:[] }, sampleAt);
    const model = buildMonitorViewModel(store.read(), 'en');
    data.applySamples(h.history.recordDisplayFrame(model, readyAt, 300000), { timeline:h.history.timeline(readyAt) });
  }
  h.time(4800); assert.equal(data.sparkDisplayTime(state.charts.gpus[0]), 2800);
  assert.match(charts.sparkPaths(state.charts.gpus[0], 100).line, /L100,45\.0$/);
  const path = charts.sparkPaths(state.charts.gpus[0], 100).line; h.restore();
  assert.equal(data.sparkDisplayTime(state.charts.gpus[0]), 2800);
  assert.equal(charts.sparkPaths(state.charts.gpus[0], 100).line, path);
});


test('GPU 100 percent stays flat through null retention, failure, late arrival and hydration', t => {
  const h = harness(t), store = new SnapshotStore();
  function update(at, util, failed = false) {
    h.time(at);
    if (failed) store.fail('accelerators', new Error('collection timed out'), at);
    else store.commit('accelerators', {
      devices: parseNvidiaCards('0, A100, ' + util + ', 100, 1000, 45, 50, 300, GPU-a'),
      usagesByPid: new Map(), currentUserDeviceKeys: [],
    }, at);
    const model = buildMonitorViewModel(store.read(), 'en');
    data.applySamples(h.history.recordDisplayFrame(model, at, 300000), { timeline: h.history.timeline(at) });
    return model;
  }
  update(0, '100'); update(2000, '100');
  const missing = update(4000, 'N/A');
  assert.equal(missing.performance.gpus[0].util, 100);
  assert.equal(Object.hasOwn(missing.performance.gpus[0], 'utilSampled'), false);
  update(6000, null, true); h.time(9000);
  assert.equal(data.sparkDisplayTime(state.charts.gpus[0]), 4000);
  update(10000, '100'); h.time(11000);
  const live = points(state.charts.gpus[0]), cursor = data.sparkDisplayTime(state.charts.gpus[0]);
  h.restore();
  assert.deepEqual(points(state.charts.gpus[0]), live);
  assert.equal(data.sparkDisplayTime(state.charts.gpus[0]), cursor);
  const path = charts.sparkPaths(state.charts.gpus[0], 100).line;
  assert.equal((path.match(/M/g) || []).length, 1);
  assert.ok(path.split(/[ML]/).filter(Boolean).every(point => point.split(',')[1] === '0.0'));
});


test('one GPU with missing utilization stops at its own edge without delaying another GPU', t => {
  const h = harness(t, 1);
  const devices = second => [{ idx: 0, deviceKey: 'a', util: 100 }, { idx: 1, deviceKey: 'b', util: second }];
  h.record('accelerators', devices(100), 0); h.record('accelerators', devices(100), 2000);
  for (const at of [4000, 6000, 8000]) h.record('accelerators', devices(null), at);
  h.time(10000);
  assert.equal(data.sparkDisplayTime(state.charts.gpus[0]), 8000);
  assert.equal(data.sparkDisplayTime(state.charts.gpus[1]), 2000);
  h.record('accelerators', devices(100), 10000); h.time(11000);
  assert.equal(data.sparkDisplayTime(state.charts.gpus[0]), 9000);
  assert.equal(data.sparkDisplayTime(state.charts.gpus[1]), 6000);
  assert.deepEqual(state.charts.gpus[1].map(point => point.v), [100, 100, 100]);
});


test('stalled GPU history stays bounded while other cards continue for a long time', t => {
  const h = harness(t, 1);
  const devices = second => [{ idx: 0, deviceKey: 'a', util: 100 }, { idx: 1, deviceKey: 'b', util: second }];
  for (let at = 0; at <= 60000; at += 2000) h.record('accelerators', devices(100), at);
  for (let at = 62000; at <= 3600000; at += 2000) h.record('accelerators', devices(null), at);
  assert.ok(h.history.samples.length < 70);
  h.restore();
  assert.equal(data.sparkDisplayTime(state.charts.gpus[1]), 60000);
  assert.equal(state.charts.gpus[1].length, 31);
});


test('a metric still missing on the first resumed sample preserves its manual pause boundary', t => {
  const h = harness(t, 1);
  const devices = second => [{ idx: 0, deviceKey: 'a', util: 100 }, { idx: 1, deviceKey: 'b', util: second }];
  h.record('accelerators', devices(100), 0); h.record('accelerators', devices(100), 2000);
  h.stop(3000); h.resume(10000);
  for (let at = 10000; at <= 90000; at += 2000) h.record('accelerators', devices(null), at);
  h.record('accelerators', devices(100), 92000);
  assert.equal(state.charts.gpus[1].at(-1).gapBefore, true);
  h.restore();
  assert.equal(state.charts.gpus[1].at(-1).gapBefore, true);
});


test('switching devices replaces points, versions and playback rather than reusing the old cursor', t => {
  const h = harness(t); h.record('cpu', 40, 100000);
  const other = new MetricHistory();
  h.model.sources.cpu = { state: 'ready', sequence: 1, sampledAt: 1000 };
  h.model.performance.cpu.usagePercent = 10;
  const samples = other.recordDisplayFrame(h.model, 1000, 300000);
  h.time(1000); data.applySamples(samples, { replace: true, timeline: other.timeline(1000) });
  assert.deepEqual(state.charts.cpu.map(point => [point.t, point.v]), [[1000, 10]]);
  assert.equal(data.sparkDisplayTime('cpu'), -1000);
});


test('a backwards source clock resets that source without connecting different clock epochs', t => {
  const h = harness(t); h.record('cpu', 40, 10000); h.record('cpu', 40, 12000);
  h.record('cpu', 20, 1000);
  assert.deepEqual(state.charts.cpu.map(point => [point.t, point.v]), [[1000, 20]]);
  assert.equal(data.sparkDisplayTime('cpu'), -1000);
});


test('GPU identity changes replace only the affected history and empty inventory clears it', t => {
  const h = harness(t); h.record('cpu', 20, 0);
  h.record('accelerators', gpu(100, 'old'), 2000); h.record('accelerators', gpu(100, 'new'), 4000);
  assert.deepEqual(state.charts.gpus[0].map(point => point.v), [100]);
  assert.equal(state.charts.gpus[0].deviceKey, 'new'); assert.equal(state.charts.cpu.length, 3);
  h.record('accelerators', [], 6000); h.restore();
  assert.deepEqual(Object.keys(state.charts.gpus), []);
});


test('GPU reappearance resets only that card after a value-less inventory event is trimmed', t => {
  const h = harness(t);
  const a = util => ({ idx: 0, deviceKey: 'a', util });
  const b = util => ({ idx: 1, deviceKey: 'b', util });
  h.record('accelerators', [a(10), b(20)], 0);
  h.record('accelerators', [a(null)], 2000);
  h.record('accelerators', [a(30), b(40)], 4000);
  assert.deepEqual(points(state.charts.gpus[0]), [[0, 10, false], [4000, 30, false]]);
  assert.deepEqual(points(state.charts.gpus[1]), [[4000, 40, false]]);
  assert.deepEqual(h.history.samples.map(sample => sample.t), [0, 4000]);
  const live = Object.values(state.charts.gpus).map(points);
  h.restore();
  assert.deepEqual(Object.values(state.charts.gpus).map(points), live);
  assert.equal(h.history.gpuGenerations.size, 2);
});


test('a GPU reappearing with missing utilization keeps its new generation until valid data arrives', t => {
  const h = harness(t);
  const devices = (second, present = true) => [{ idx: 0, deviceKey: 'a', util: null }, ...(present ? [{ idx: 1, deviceKey: 'b', util: second }] : [])];
  h.record('accelerators', devices(20), 0);
  h.record('accelerators', devices(null, false), 2000);
  for (let at = 4000; at < 100000; at += 2000) h.record('accelerators', devices(null), at);
  assert.equal(h.history.samples.length, 2);
  h.record('accelerators', devices(40), 100000);
  assert.deepEqual(points(state.charts.gpus[1]), [[100000, 40, false]]);
  h.restore();
  assert.deepEqual(points(state.charts.gpus[1]), [[100000, 40, false]]);
});


test('native GPU index swaps preserve each physical card history and playback', t => {
  const h = harness(t);
  h.record('accelerators', [{ idx: 0, deviceKey: 'a', util: 10 }, { idx: 1, deviceKey: 'b', util: 20 }], 0);
  h.record('accelerators', [{ idx: 1, deviceKey: 'a', util: 30 }, { idx: 0, deviceKey: 'b', util: 40 }], 2000);
  assert.deepEqual(points(state.charts.gpus[1]), [[0, 10, false], [2000, 30, false]]);
  assert.deepEqual(points(state.charts.gpus[0]), [[0, 20, false], [2000, 40, false]]);
  assert.equal(h.history.playback.get('gpu:a').anchorAt, 0);
  assert.equal(h.history.playback.get('gpu:b').anchorAt, 0);
  const live = Object.values(state.charts.gpus).map(points);
  h.restore();
  assert.deepEqual(Object.values(state.charts.gpus).map(points), live);
});


test('paused retries leave recorded GPU generations intact until resumed samples arrive', t => {
  const h = harness(t);
  const a = util => ({ idx: 0, deviceKey: 'a', util });
  const b = util => ({ idx: 1, deviceKey: 'b', util });
  h.record('accelerators', [a(10), b(20)], 0);
  h.record('accelerators', [a(30)], 2000);
  h.stop(3000);
  h.model.sources.accelerators = { state: 'ready', sequence: 99, sampledAt: 4000 };
  h.model.performance.gpus = [a(50), b(60)];
  assert.deepEqual(h.history.recordDisplayFrame(h.model, 4000, 300000), []);
  assert.equal(h.history.gpuGenerations.has('b'), false);
  h.restore();
  assert.deepEqual(Object.keys(state.charts.gpus), ['0']);
  h.resume(10000);
  h.model.sources.accelerators = { state: 'ready', sequence: 100, sampledAt: 10000 };
  h.publish(h.history.recordDisplayFrame(h.model, 10000, 300000));
  assert.deepEqual(points(state.charts.gpus[0]), [[0, 10, false], [2000, 30, false], [10000, 50, true]]);
  assert.deepEqual(points(state.charts.gpus[1]), [[10000, 60, false]]);
  const live = Object.values(state.charts.gpus).map(points);
  h.restore();
  assert.deepEqual(Object.values(state.charts.gpus).map(points), live);
});
