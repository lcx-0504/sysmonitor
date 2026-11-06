'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { initialize,harness,points,gpu,MetricHistory,SnapshotStore,buildMonitorViewModel,parseNvidiaCards } = require('./chart-fixture');
let charts,data,state;
test.before(async () => { ({charts,data,state}=await initialize()); });

test('display frames keep one interval of lookahead while successful data is still pending', t => {
  const h = harness(t);
  h.model.sources.diskIo = { state:'ready', sequence:100, sampledAt:0 };
  h.model.performance.diskIo = { readBytesPerSecond:60, writeBytesPerSecond:30, readSampled:false };
  function frame(at) { h.time(at); h.publish(h.history.recordDisplayFrames(h.model, [at], at, 300000)); }
  for (let at = 0; at <= 12000; at += 2000) {
    if (at === 6000) h.model.performance.diskIo.readBytesPerSecond = 70;
    frame(at);
    for (let elapsed = 0; elapsed <= 1500; elapsed += 250) {
      h.time(at + elapsed); assert.equal(data.sparkDisplayTime(state.charts.diskRead), at + elapsed - 2000);
    }
  }
  assert.deepEqual(state.charts.diskRead.map(point => [point.t,point.v]), [[0,60],[2000,60],[4000,60],[6000,70],[8000,70],[10000,70],[12000,70]]);
  h.restore(); assert.equal(state.charts.diskRead.at(-1).v, 70);
});


test('every displayed metric records the same frame clock independently of collection timestamps', t => {
  const h = harness(t);
  for (const key of Object.keys(h.model.sources)) h.model.sources[key] = { state:'ready', sequence:1000, sampledAt:-5000 };
  h.model.performance = { cpu:{ usagePercent:20, sampled:false }, memory:{ usagePercent:30 },
    network:{ transmitBytesPerSecond:40, receiveBytesPerSecond:50 }, diskIo:{ readBytesPerSecond:60, writeBytesPerSecond:70 },
    sshTraffic:{ uploadBytesPerSecond:80, downloadBytesPerSecond:90 }, gpus:gpu(100) };
  for (const at of [0,2000,4000,6000]) { h.time(at); h.publish(h.history.recordDisplayFrames(h.model, [at], at, 300000)); }
  h.time(7000);
  for (const series of [state.charts.cpu,state.charts.memory,state.charts.netTx,state.charts.netRx,state.charts.diskRead,state.charts.diskWrite,state.charts.sshTx,state.charts.sshRx,state.charts.gpus[0]]) {
    assert.deepEqual(series.map(point => point.t), [0,2000,4000,6000]);
    assert.equal(data.sparkDisplayTime(series), 5000);
  }
  const before = points(state.charts.gpus[0]); h.restore(); assert.deepEqual(points(state.charts.gpus[0]), before);
});


test('a reported failure stops recording and drains the existing buffer before holding', t => {
  const h = harness(t);
  h.model.sources.cpu = { state:'ready', sequence:10, sampledAt:0 }; h.model.performance.cpu = { usagePercent:60 };
  function frame(at) { h.time(at); h.publish(h.history.recordDisplayFrames(h.model, [at], at, 300000)); }
  for (const at of [0,2000,4000]) frame(at);
  h.model.sources.cpu.state = 'stale'; h.time(5500);
  assert.equal(data.sparkDisplayTime('cpu'), 3500);
  frame(6000); assert.equal(data.sparkDisplayTime('cpu'), 4000);
  frame(8000); assert.equal(data.sparkDisplayTime('cpu'), 4000);
  assert.equal(state.charts.cpu.length, 3);
  h.model.sources.cpu.state = 'ready'; h.model.performance.cpu.usagePercent = 70; frame(10000); frame(12000);
  assert.equal(state.charts.cpu.at(-1).v, 70); assert.equal(state.charts.cpu.at(-1).gapBefore, false);
});


test('automatic disconnect drains lookahead and a subsequent manual pause freezes it', t => {
  const h = harness(t); h.record('cpu',60,0); h.record('cpu',60,2000); h.record('cpu',60,4000);
  h.stop(5000,false); h.time(5500); assert.equal(data.sparkDisplayTime('cpu'), 3500);
  h.stop(5500,true); h.time(8000); assert.equal(data.sparkDisplayTime('cpu'), 3500);
});


for (const [source, seriesKey, payload] of [
  ['cpu', 'cpu', value => value], ['memory', 'memory', value => value],
  ['network', 'netRx', value => ({ receiveBytesPerSecond: value, transmitBytesPerSecond: value })],
  ['diskIo', 'diskRead', value => ({ readBytesPerSecond: value, writeBytesPerSecond: value })],
  ['sshTraffic', 'sshRx', value => ({ uploadBytesPerSecond: value, downloadBytesPerSecond: value })],
  ['accelerators', 'gpu', value => gpu(value)],
]) test(source + ' plays at 1x with a full buffered interval despite a fixed 300ms arrival delay', t => {
  const h = harness(t);
  const series = () => seriesKey === 'gpu' ? state.charts.gpus[0] : state.charts[seriesKey];
  for (let index = 0; index < 5; index++) {
    const sampleAt = index * 2000, readyAt = sampleAt + 300;
    h.record(source, payload(10 + index * 15), readyAt, sampleAt);
    const plot = source === 'accelerators' ? 'gpu:gpu-a' : source;
    assert.equal(h.history.playback.get(plot).anchorAt, 300);
    assert.equal(h.history.playback.get(plot).transition, null);
    for (let elapsed = 0; elapsed <= 2000; elapsed += 500) {
      h.time(readyAt + elapsed);
      assert.equal(data.sparkDisplayTime(series()), readyAt - 2000 + elapsed);
      assert.equal(h.history.displayTime(plot, readyAt + elapsed), data.sparkDisplayTime(series()));
    }
  }
});


test('measurement timestamp jitter does not alter fixed display frame anchors', t => {
  const h = harness(t);
  const readyTimes = [300, 2300, 4300, 6300, 8300];
  for (let index = 0; index < readyTimes.length; index++) {
    h.record('cpu', 10 + index * 15, readyTimes[index], index * 2000);
    assert.equal(h.history.playback.get('cpu').anchorAt, 300);
    assert.equal(h.history.playback.get('cpu').transition, null);
    const next = readyTimes[index + 1] ?? readyTimes[index] + 1000;
    for (let frame = readyTimes[index]; frame < next; frame += 100) {
      h.time(frame); assert.equal(data.sparkDisplayTime('cpu'), frame - 2000);
    }
  }
});


test('exhausted display lookahead resumes continuously and keeps a constant catch-up speed', t => {
  const h = harness(t); h.record('cpu', 10, 300, 0);
  h.time(2350); assert.equal(data.sparkDisplayTime('cpu'), 300);
  h.record('cpu', 40, 2400, 2000); assert.equal(data.sparkDisplayTime('cpu'), 300);
  assert.ok(h.history.playback.get('cpu').transition);
  for (let elapsed = 100; elapsed <= 1900; elapsed += 100) {
    h.time(2400 + elapsed); assert.equal(data.sparkDisplayTime('cpu'), 300 + elapsed * 1.05);
  }
});


test('catch-up uses a constant speed and new arrivals do not rebuild its transition', t => {
  const h = harness(t); h.record('cpu', 10, 300, 0); h.record('cpu', 40, 2300, 2000);
  h.time(7000); h.record('cpu', 80, 10300, 10000);
  const transition = { ...h.history.playback.get('cpu').transition };
  h.time(10800); const first = data.sparkDisplayTime('cpu');
  h.time(11300); const second = data.sparkDisplayTime('cpu');
  h.record('cpu', 60, 11300, 11000);
  assert.equal(data.sparkDisplayTime('cpu'), second);
  assert.deepEqual(h.history.playback.get('cpu').transition, transition);
  h.time(11800); const third = data.sparkDisplayTime('cpu');
  assert.equal(second - first, third - second);
  h.time(12300); assert.equal(data.sparkDisplayTime('cpu'), 10300);
});


test('normal sampling buffers one interval and stops exactly at the newest sample edge', t => {
  const h = harness(t);
  for (const at of [0, 2000, 4000]) h.record('cpu', 40, at);
  h.time(5000); assert.equal(data.sparkDisplayTime('cpu'), 3000);
  h.time(6000); assert.equal(data.sparkDisplayTime('cpu'), 4000);
  h.time(10000); assert.equal(data.sparkDisplayTime('cpu'), 4000);
  assert.match(charts.sparkPaths(state.charts.cpu, 100).line, /L100\.0000,60\.0$/);
});


test('late data catches up smoothly from the stopped edge without resetting the samples', t => {
  const h = harness(t);
  for (const at of [0, 2000, 4000]) h.record('cpu', 40, at);
  h.record('cpu', 40, 10000);
  assert.equal(data.sparkDisplayTime('cpu'), 4000);
  h.time(11000); assert.equal(data.sparkDisplayTime('cpu'), 7000);
  h.time(12000); assert.equal(data.sparkDisplayTime('cpu'), 10000);
  h.time(20000); assert.equal(data.sparkDisplayTime('cpu'), 10000);
  assert.deepEqual(state.charts.cpu.map(point => point.gapBefore), [false, false, false, false]);
});


test('a new sample during catch-up preserves continuity and the original catch-up endpoint', t => {
  const h = harness(t); h.record('cpu', 40, 0); h.record('cpu', 40, 4000); h.time(6000);
  h.record('cpu', 40, 10000); h.time(11000);
  const before = data.sparkDisplayTime('cpu');
  h.record('cpu', 40, 11000);
  assert.equal(data.sparkDisplayTime('cpu'), before);
  h.time(12000); assert.equal(data.sparkDisplayTime('cpu'), 10000);
});


test('pending healthy collectors retain displayed values on the common frame clock', t => {
  const h = harness(t);
  h.record('memory', 40, 0); h.record('memory', 40, 2000);
  for (const at of [0, 2000, 4000, 6000, 8000]) h.record('cpu', 20, at);
  h.time(10000);
  assert.equal(data.sparkDisplayTime('cpu'), 8000);
  assert.equal(data.sparkDisplayTime('memory'), 8000);
  h.record('memory', 40, 10000); h.record('cpu', 20, 10000);
  h.time(11000);
  assert.equal(data.sparkDisplayTime('cpu'), 9000);
  assert.equal(data.sparkDisplayTime('memory'), 9000);
});


test('timeouts and missing fields skip points and connect the surrounding valid values', t => {
  const h = harness(t); h.record('cpu', 100, 0); h.record('cpu', 100, 2000);
  h.fail('cpu', 4000); h.record('cpu', null, 6000); h.time(8000);
  assert.equal(data.sparkDisplayTime('cpu'), 2000);
  h.record('cpu', 100, 10000); h.time(12000);
  assert.deepEqual(points(state.charts.cpu), [[0, 100, false], [2000, 100, false], [10000, 100, false]]);
  const path = charts.sparkPaths(state.charts.cpu, 100).line;
  assert.equal((path.match(/M/g) || []).length, 1);
  assert.ok(path.split(/[ML]/).filter(Boolean).every(point => point.split(',')[1] === '0.0'));
});


test('a genuine zero is retained as a measured point', t => {
  const h = harness(t); h.record('cpu', 40, 0); h.record('cpu', 0, 2000);
  assert.deepEqual(state.charts.cpu.map(point => point.v), [40, 0]);
});


for (const [source, seriesKey, payload] of [
  ['cpu', 'cpu', value => value], ['memory', 'memory', value => value],
  ['network', 'netRx', value => ({ receiveBytesPerSecond: value, transmitBytesPerSecond: value })],
  ['diskIo', 'diskRead', value => ({ readBytesPerSecond: value, writeBytesPerSecond: value })],
  ['sshTraffic', 'sshRx', value => ({ uploadBytesPerSecond: value, downloadBytesPerSecond: value })],
]) test(source + ' keeps constant values flat through missing samples and catches up without a blank right edge', t => {
  const h = harness(t); h.record(source, payload(100), 0); h.record(source, payload(100), 2000);
  h.record(source, payload(null), 4000); h.fail(source, 6000); h.time(9000);
  assert.equal(data.sparkDisplayTime(state.charts[seriesKey]), 2000);
  assert.match(charts.sparkPaths(state.charts[seriesKey], 100).line, /100\.0000,0\.0$/);
  h.record(source, payload(100), 10000); h.time(11000);
  const path = charts.sparkPaths(state.charts[seriesKey], 100).line;
  assert.equal((path.match(/M/g) || []).length, 1);
  assert.ok(path.split(/[ML]/).filter(Boolean).every(point => point.split(',')[1] === '0.0'));
});


test('manual pause freezes the viewport and waits for fresh data before catch-up with a gap', t => {
  const h = harness(t);
  for (const at of [0, 2000, 4000]) h.record('cpu', 40, at);
  h.stop(4500); assert.equal(data.sparkDisplayTime('cpu'), 2500);
  h.resume(100000); h.time(100500);
  assert.equal(data.sparkDisplayTime('cpu'), 2500);
  h.record('cpu', 40, 101000); assert.equal(data.sparkDisplayTime('cpu'), 2500);
  assert.equal(state.charts.cpu.at(-1).gapBefore, true);
  h.time(102000); assert.equal(data.sparkDisplayTime('cpu'), 51750);
  h.time(103000); assert.equal(data.sparkDisplayTime('cpu'), 101000);
});


test('automatic disconnection freezes and catches up while connecting valid points across the interval', t => {
  const h = harness(t); h.record('cpu', 100, 0); h.record('cpu', 100, 2000);
  h.stop(4500, false); h.resume(100000); h.record('cpu', 100, 100000);
  assert.equal(state.charts.cpu.at(-1).gapBefore, false);
  h.time(102000);
  assert.equal((charts.sparkPaths(state.charts.cpu, 100).line.match(/M/g) || []).length, 1);
});


test('manual pause during an automatic disconnection keeps the explicit user gap', t => {
  const h = harness(t); h.record('cpu', 40, 0); h.record('cpu', 40, 2000);
  h.stop(3000, false); h.stop(4000, true); h.resume(10000); h.record('cpu', 40, 10000);
  assert.equal(state.charts.cpu.at(-1).gapBefore, true);
});


test('pausing midway through catch-up preserves the same frozen cursor after hydration', t => {
  const h = harness(t); h.record('cpu', 40, 0); h.record('cpu', 40, 2000); h.record('cpu', 40, 4000);
  h.stop(4500); h.resume(100000); h.record('cpu', 40, 100000); h.time(101000);
  const moving = data.sparkDisplayTime('cpu');
  h.stop(101000); h.time(200000); h.restore();
  assert.equal(data.sparkDisplayTime('cpu'), moving);
});


test('completed catch-up never overrides a second pause and resume', t => {
  const h = harness(t); h.record('cpu', 40, 0); h.record('cpu', 40, 2000);
  h.stop(3000); h.resume(10000); h.record('cpu', 40, 10000); h.time(13000);
  h.stop(14000); const frozen = data.sparkDisplayTime('cpu');
  h.resume(20000); h.record('cpu', 40, 20000);
  assert.equal(data.sparkDisplayTime('cpu'), frozen);
});


test('paused displayed values enter history only after resuming, with a manual gap', t => {
  const h = harness(t); h.record('cpu', 40, 0); h.stop(1000);
  h.model.sources.cpu = { state: 'ready', sequence: 99, sampledAt: 2000 };
  h.model.performance.cpu.usagePercent = 90;
  assert.deepEqual(h.history.recordDisplayFrames(h.model, [2000], 2000, 300000), []);
  assert.deepEqual(state.charts.cpu.map(point => point.v), [40]);
  h.resume(10000);
  h.publish(h.history.recordDisplayFrames(h.model, [10000], 10000, 300000));
  assert.deepEqual(points(state.charts.cpu), [[0, 40, false], [10000, 90, true]]);
});


test('long pauses preserve the complete frozen window when the view is recreated', t => {
  const h = harness(t, 1);
  for (let at = 0; at <= 60000; at += 2000) h.record('cpu', 40, at);
  h.stop(61000); h.time(3600000); h.restore();
  assert.equal(data.sparkDisplayTime('cpu'), 59000);
  assert.equal(state.charts.cpu.length, 31);
});


test('a stalled source retains its window even while another source advances for a long time', t => {
  const h = harness(t, 1);
  for (let at = 0; at <= 60000; at += 2000) h.record('memory', 40, at);
  h.fail('memory', 62000);
  h.record('cpu', 20, 3600000); h.restore();
  assert.equal(state.charts.memory.length, 31);
  assert.equal(data.sparkDisplayTime('memory'), 60000);
});


test('live and hydrate preserve window predecessors for sparse valid samples', t => {
  const h = harness(t, 1);
  for (const at of [0, 45000, 90000]) h.record('cpu', 40, at);
  h.time(93000); h.publish(h.history.recordDisplayFrames(h.model, [93000], 93000, 60000));
  const path = charts.sparkPaths(state.charts.cpu, 100).line;
  h.restore();
  assert.equal(charts.sparkPaths(state.charts.cpu, 100).line, path);
  assert.match(path, /^M0,/);
});


test('history does not grow from repeated missing samples while a source is stalled', t => {
  const h = harness(t); h.record('cpu', 40, 0); h.record('cpu', 40, 2000);
  for (let at = 4000; at < 100000; at += 2000) h.record('cpu', null, at);
  assert.equal(h.history.samples.filter(sample => sample.source === 'cpu').length, 3);
  assert.deepEqual(state.charts.cpu.map(point => point.v), [40, 40]);
});


test('interval changes and changes during catch-up remain monotonic and hydrate from the same state', t => {
  const h = harness(t);
  h.record('cpu', 40, 0); h.record('cpu', 40, 2000); h.record('cpu', 40, 4000); h.time(5000);
  const before = data.sparkDisplayTime('cpu'); h.interval(60, 5000);
  assert.equal(data.sparkDisplayTime('cpu'), before);
  h.restore(); assert.equal(data.sparkDisplayTime('cpu'), before);
  h.interval(2, 10000); h.time(11000);
  const moving = data.sparkDisplayTime('cpu'); h.interval(60, 11000);
  assert.equal(data.sparkDisplayTime('cpu'), moving);
  h.restore(); assert.equal(data.sparkDisplayTime('cpu'), moving);
});


test('client wall-clock changes do not alter a mapped source timeline', t => {
  const h = harness(t); h.record('cpu', 40, 0); h.record('cpu', 40, 2000);
  h.time(3000); const before = data.sparkDisplayTime('cpu');
  h.wall(3603000); assert.equal(data.sparkDisplayTime('cpu'), before);
  h.time(3500); assert.equal(data.sparkDisplayTime('cpu'), before + 500);
});


test('duplicate and older source sequences do not append or overwrite newer points', t => {
  harness(t);
  const sample = (sequence, value) => ({ source: 'cpu', sequence, t: sequence * 2000, values: { cpu: value } });
  data.applySamples([sample(1, 20), sample(2, 30)]);
  data.applySamples([sample(1, 99), sample(2, 99)]);
  assert.deepEqual(state.charts.cpu.map(point => point.v), [20, 30]);
});


test('older display frames cannot overwrite newer retained points', t => {
  const h = harness(t); const old = h.record('cpu', 20, 1000); h.record('cpu', 30, 3000);
  h.time(4000); h.publish(old);
  h.restore();
  assert.deepEqual(state.charts.cpu.map(point => [point.t, point.v]), [[1000, 20], [3000, 30]]);
});

test('disabling and re-enabling a metric preserves its intentional gap without stopping other plots', t => {
  const h=harness(t);
  h.record('cpu',60,0); h.record('memory',40,0);
  h.time(3000); h.model.sources.cpu.state='disabled'; h.history.syncSources(h.model,3000);
  const held=h.history.displayTime('cpu',3000);
  h.record('memory',45,4000);
  assert.equal(h.history.displayTime('cpu',8000),held);
  h.time(10000); h.model.sources.cpu.state='loading'; h.history.syncSources(h.model,10000);
  const updates=h.record('cpu',70,10000);
  assert.equal(updates.find(sample=>sample.source==='cpu').gapBefore,true);
  assert.equal(state.charts.cpu.at(-1).gapBefore,true);
  assert.equal(state.charts.memory.at(-1).gapBefore,false);
});
