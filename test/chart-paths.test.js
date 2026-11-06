'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { initialize,harness,points,gpu,MetricHistory,SnapshotStore,buildMonitorViewModel,parseNvidiaCards } = require('./chart-fixture');
let charts,data,state;
test.before(async () => { ({charts,data,state}=await initialize()); });

test('a 60s window retains its buffered next point and interpolates both moving boundaries', t => {
  const h = harness(t, 1); h.interval(1, 0);
  for (let at = 0; at <= 61000; at += 1000) h.record('cpu', at / 1000, at + 300, at);
  assert.equal(state.charts.cpu.length, 62);
  assert.equal(data.sparkDisplayTime('cpu'), 60300);
  assert.equal(state.charts.cpu.at(-1).t, 61300);
  h.time(61600); h.publish();
  const path = charts.sparkPaths(state.charts.cpu, 100).line;
  assert.match(path, /^M0,99\.7/); assert.match(path, /L100,39\.7$/);
  assert.equal(state.charts.cpu[0].t, 300); assert.equal(state.charts.cpu.at(-1).t, 61300);
  const cursor = data.sparkDisplayTime('cpu'); h.restore();
  assert.equal(data.sparkDisplayTime('cpu'), cursor); assert.equal(charts.sparkPaths(state.charts.cpu, 100).line, path);
});


test('a new chart has no invented samples or area before observations arrive', t => {
  const h = harness(t); h.publish();
  assert.deepEqual(state.charts.cpu, []);
  assert.equal(charts.sparkPaths(state.charts.cpu, 100), null);
  h.record('cpu', 40, 0);
  assert.equal(charts.sparkPaths(state.charts.cpu, 100), null);
});


test('rate-pair scales and manual gaps use one viewport and interpolate window boundaries', t => {
  harness(t); state.charts.windowMilliseconds = 2000;
  const entering = [{ t: 1000, v: 10 }, { t: 3000, v: 10 }, { t: 5000, v: 100 }];
  assert.equal(charts.sparkMaximum(entering, [], 3000), 10);
  assert.equal(charts.sparkMaximum(entering, [], 4000), 55);
  assert.match(charts.sparkPaths(entering, 55, 4000).area, /L100,0\.0L100,100/);
  const gaps = [{ t: 0, v: 10 }, { t: 2000, v: 20 }, { t: 12000, v: 30, gapBefore: true }, { t: 14000, v: 40 }];
  state.charts.windowMilliseconds = 300000;
  assert.equal((charts.sparkPaths(gaps, 100, 14000).line.match(/M/g) || []).length, 2);
});
