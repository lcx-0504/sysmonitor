'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {FrameClock}=require('../src/core/frame-clock');

test('wall-clock adjustments do not move the chart timeline or delay its next capture', () => {
  const {monotonicTimeline}=require('../src/core/frame-clock');
  let wall=100000, elapsed=0, callback; const frames=[];
  const now=monotonicTimeline(()=>wall,()=>elapsed);
  const clock=new FrameClock({periodMilliseconds:2000,now,setTimer:fn=>{callback=fn;return 1;},clearTimer() {},
    capture:times=>{frames.push(...times);return times;},publish() {}});
  clock.start(); elapsed=2000; callback();
  wall-=3600000; elapsed=4000; callback();
  wall+=7200000; elapsed=6000; callback();
  assert.deepEqual(frames,[100000,102000,104000,106000]);
  assert.equal(clock.nextAt,108000);
});

test('late timers capture scheduled frames without drifting and publish their batch once', () => {
  let now=0, callback, value=60; const frames=[], published=[];
  const clock=new FrameClock({periodMilliseconds:2000,now:()=>now,setTimer:fn=>{callback=fn;return 1;},clearTimer:()=>{},
    capture:(times,readyAt)=>times.map(at=>{const frame={at,value};frames.push(frame);return frame;}),publish:(batch,emit)=>published.push({batch,emit})});
  clock.start(false); now=4500; callback();
  assert.deepEqual(frames,[{at:0,value:60},{at:2000,value:60},{at:4000,value:60}]);
  assert.equal(published.length,2); assert.equal(clock.nextAt,6000);
  now=6100; value=70; callback(); assert.deepEqual(frames.at(-1),{at:6000,value:70});
  clock.stop(); now=10000; clock.flush(); assert.equal(frames.length,4);
});

test('backend and browser playback use the same pure implementation', async () => {
  const backend=require('../src/core/metric-playback'); const browser=await import('../src/view/assets/metric-playback.mjs');
  for (const heldAt of [null,3000]) for (const transition of [null,{from:2000,at:5000,duration:2000}]) {
    const playback={anchorTime:4000,anchorAt:5000,latestAt:7000,floor:2000,heldAt,transition};
    for (const now of [4000,5000,5500,6000,7000,10000]) assert.equal(browser.displayPosition(playback,now),backend.displayPosition(playback,now));
  }
});

test('a late batch enters playback at its actual arrival time without jumping the cursor', () => {
  const {MetricHistory} = require('../src/core/metric-history');
  const history = new MetricHistory([], 2000);
  const model = {sources:Object.fromEntries(['cpu','memory','network','diskIo','sshTraffic','accelerators'].map(key => [key,{state:key === 'cpu' ? 'ready' : 'loading'}])),
    performance:{cpu:{usagePercent:60}}};
  let now = 0, callback;
  const clock = new FrameClock({periodMilliseconds:2000, now:()=>now, setTimer:fn=>{callback=fn;return 1;},clearTimer() {},
    capture:(times,readyAt)=>history.recordDisplayFrames(model,times,readyAt,60000),publish() {}});
  clock.start(); now = 10000;
  const before = history.displayTime('cpu',now);
  callback();
  assert.equal(history.displayTime('cpu',now),before);
  assert.ok(history.playback.get('cpu').transition);
  assert.equal(history.displayTime('cpu',11000),5000);
  assert.equal(history.displayTime('cpu',12000),10000);
  assert.deepEqual(history.samples.map(sample => sample.t), [0,2000,4000,6000,8000,10000]);
});

test('a day-long sleep has a bounded capture batch and preserves sampling phase', () => {
  let now = 123, callback; const batches = [];
  const clock = new FrameClock({periodMilliseconds:2000,historyWindowMilliseconds:()=>60000,now:()=>now,
    setTimer:fn=>{callback=fn;return 1;},clearTimer() {},capture:(times,readyAt)=>{batches.push({times,readyAt});return times;},publish() {}});
  clock.start(); now += 86400000; callback();
  const batch = batches.at(-1);
  assert.equal(batch.readyAt,now);
  assert.ok(batch.times.length <= 33);
  assert.equal(batch.times.at(-1),now);
  assert.ok(batch.times.every(at => (at - 123) % 2000 === 0));
  assert.equal(clock.nextAt,now+2000);
});

test('an empty GPU inventory in a late batch clears the preceding device history once', () => {
  const {MetricHistory}=require('../src/core/metric-history');
  const history=new MetricHistory([],2000);
  const model={sources:Object.fromEntries(['cpu','memory','network','diskIo','sshTraffic','accelerators'].map(key=>[key,{state:key==='accelerators'?'ready':'loading'}])),
    performance:{gpus:[{idx:0,deviceKey:'gpu-a',util:50}]}};
  history.recordDisplayFrame(model,0,60000);
  model.performance.gpus=[];
  const updates=history.recordDisplayFrames(model,[2000,4000,6000],6500,60000);
  assert.equal(updates.length,1);
  assert.equal(history.samples.length,1);
  assert.deepEqual(history.samples[0].values.gpus,[]);
  assert.equal(history.playback.has('gpu:gpu-a'),false);
});
