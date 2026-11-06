'use strict';
const { MetricHistory } = require('../src/core/metric-history');
const { SnapshotStore } = require('../src/core/snapshot-store');
const { buildMonitorViewModel } = require('../src/services/monitor-view-model');
const { parseNvidiaCards } = require('../src/accelerators/nvidia-provider');
let charts, data, state;
async function initialize() {
  charts = await import('../src/view/assets/charts.mjs');
  data = await import('../src/view/assets/chart-state.mjs');
  ({ state } = await import('../src/view/assets/state.mjs'));
  return { charts,data,state };
}
function harness(t, minutes = 5) {
  let now = 0, wall = 0, sequence = 0;
  t.mock.method(Date, 'now', () => wall);
  t.mock.method(performance, 'now', () => now);
  state.config = { refreshInterval: 2, display: { sparkMinutes: minutes } };
  state.ui = { paused: false, canAnimate: true };
  charts.initializeCharts();
  const history = new MetricHistory();
  const model = {
    sources: Object.fromEntries(['cpu', 'memory', 'network', 'diskIo', 'sshTraffic', 'accelerators'].map(key => [key, { state: 'loading', sequence: 0, sampledAt: null }])),
    performance: { cpu: {}, memory: {}, network: {}, diskIo: {}, sshTraffic: {}, gpus: [] },
  };
  function time(value) { now = wall = value; }
  function publish(samples = []) { data.applySamples(samples, { timeline: history.timeline(now) }); }
  function record(source, value, at, sampledAt = at) {
    time(at);
    model.sources[source] = { state: 'ready', sequence: ++sequence, sampledAt };
    if (source === 'cpu' || source === 'memory') model.performance[source] = { usagePercent: value };
    else if (source === 'accelerators') model.performance.gpus = value;
    else model.performance[source] = value;
    const samples = history.recordDisplayFrames(model, [now], now, minutes * 60000);
    publish(samples);
    return samples;
  }
  function fail(source, at) {
    time(at); model.sources[source].state = 'error';
    publish(history.recordDisplayFrames(model, [now], now, minutes * 60000));
  }
  function restore() { data.applySamples(history.samples, { replace: true, timeline: history.timeline(now) }); }
  function stop(at, gap = true) { time(at); history.stop(now, { gap }); publish(); data.setSparkActivity(true, true); }
  function resume(at) { time(at); history.resume(now); publish(); data.setSparkActivity(false, true); }
  function interval(value, at) {
    time(at); history.setSampleInterval(value * 1000, now); state.config.refreshInterval = value; publish();
  }
  return { history, model, time, record, fail, restore, stop, resume, interval, publish, wall: value => { wall = value; } };
}
const points = series => series.map(point => [point.t, point.v, point.gapBefore]);
const gpu = (value, deviceKey = 'gpu-a') => [{ idx: 0, deviceKey, util: value }];


module.exports = { initialize,harness,points,gpu,MetricHistory,SnapshotStore,buildMonitorViewModel,parseNvidiaCards };
