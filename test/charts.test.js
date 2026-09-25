'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { WEBVIEW_SCRIPT_FILES } = require('../src/view/webview-html');

const readWebviewScript = () => WEBVIEW_SCRIPT_FILES.map((fileName) => fs.readFileSync(path.join(__dirname, '..', 'src/view/assets', fileName), 'utf8')).join('\n');

test('chart history keeps source timestamps and does not append a duplicate point on hydration', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview.js'), 'utf8');
  const historyCode = script.slice(script.indexOf('  function pushHist('), script.indexOf('  // ── 消息处理'));
  const context = { SPARK_WINDOW: 300000, curInterval: 2 };
  vm.runInNewContext(`${historyCode}\nthis.pushHist = pushHist;`, context);
  const samples = [];
  context.pushHist(samples, 20, 10000);
  context.pushHist(samples, 30, 12000);
  context.pushHist(samples, 35, 12000);
  assert.deepEqual(Array.from(samples, (point) => [point.t, point.v]), [[10000, 20], [12000, 35]]);
  const navigation = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview-navigation.js'), 'utf8');
  assert.match(navigation, /restoreHistory\(data\.samples\);\s*if \(data\.viewModel\) renderMonitorSnapshot\(data\.viewModel, true, data\.sampleTime, true\)/);
  assert.match(script, /function recordHistory\(series, value\) \{ if \(!skipHistory\) pushHist\(series, value, sampleTime\); \}/);
  assert.match(script, /getElementById\('updated'\)\.textContent = T\.updAt \+ new Date\(typeof sampleTime === 'number' \? sampleTime : Date\.now\(\)\)\.toLocaleTimeString\(\)/);
});

test('spark area grows from real samples, then interpolates the left boundary after the window fills', () => {
  const script = readWebviewScript();
  const geometry = script.slice(script.indexOf('  function sparkDisplayTime('), script.indexOf('  function renderSpark('));
  const history = script.slice(script.indexOf('  function pushHist('), script.indexOf('  // ── 消息处理'));
  let now = 2000;
  const context = { Date: { now: () => now }, curInterval: 2, SPARK_WINDOW: 600000 };
  vm.runInNewContext(`${geometry}\n${history}\nthis.geometry = { sparkPaths, pushHist };`, context);
  const warming = [{ t: 0, v: 20 }, { t: 2000, v: 40 }];
  assert.match(context.geometry.sparkPaths(warming, 100).area, /^M100\.0000,80\.0L/);
  now = 4000;
  assert.match(context.geometry.sparkPaths(warming, 100).area, /^M99\.6667,80\.0L/);

  context.SPARK_WINDOW = 1000;
  now = 5000;
  const points = [{ t: 1000, v: 10 }, { t: 3000, v: 30 }, { t: 5000, v: 50 }];
  assert.match(context.geometry.sparkPaths(points, 100).area, /^M0,80\.0L/);
  now = 7000;
  assert.match(context.geometry.sparkPaths(points, 100).area, /^M0,60\.0L/);
  now = 5000;
  assert.match(context.geometry.sparkPaths(points.slice(1), 100).area, /^M100\.0000,70\.0L/);

  now = 10000;
  context.SPARK_WINDOW = 6000;
  const retained = [{ t: 1000, v: 10 }, { t: 3000, v: 30 }, { t: 5000, v: 50 }, { t: 7000, v: 70 }, { t: 9000, v: 90 }];
  context.geometry.pushHist(retained, 100);
  assert.equal(retained[0].t, 1000);
});

test('chart animation resumes at the paused position and compresses the inactive interval', () => {
  const script = readWebviewScript();
  const activity = script.slice(script.indexOf('  var SPARK_WINDOW ='), script.indexOf('  function sparkColor('));
  const geometry = script.slice(script.indexOf('  function sparkDisplayTime('), script.indexOf('  function renderSpark('));
  const history = script.slice(script.indexOf('  function pushHist('), script.indexOf('  // ── 消息处理'));
  let now = 0;
  const context = { Date: { now: () => now }, curInterval: 2, paused: false, connectionAllowsAnimation: true, Object };
  vm.runInNewContext(`${activity}\n${geometry}\n${history}\nthis.chart = { pushHist, sparkDisplayTime, sparkPaths, setSparkActivity, cpuHist };`, context);
  context.chart.pushHist(context.chart.cpuHist, 10, 0);
  now = 2000;
  context.chart.pushHist(context.chart.cpuHist, 20, 2000);
  now = 4000;
  context.chart.pushHist(context.chart.cpuHist, 30, 4000);
  now = 4500;
  const beforePause = context.chart.sparkDisplayTime(context.chart.cpuHist);
  const beforeArea = context.chart.sparkPaths(context.chart.cpuHist, 100).area;
  context.chart.setSparkActivity(true, true);
  now = 400000;
  assert.equal(context.chart.sparkDisplayTime(context.chart.cpuHist), beforePause);
  context.chart.setSparkActivity(false, true);
  assert.equal(context.chart.sparkDisplayTime(context.chart.cpuHist), beforePause);
  context.chart.pushHist(context.chart.cpuHist, 40, 400000);
  assert.equal(context.chart.sparkDisplayTime(context.chart.cpuHist), beforePause);
  assert.equal(context.chart.sparkPaths(context.chart.cpuHist, 100).area, beforeArea);
  assert.equal(context.chart.cpuHist.at(-1).t, 6000);
  assert.equal(context.chart.cpuHist.at(-1).sourceTime, 400000);
  now = 402000;
  const beforeNextSample = context.chart.sparkDisplayTime(context.chart.cpuHist);
  context.chart.pushHist(context.chart.cpuHist, 50, 402000);
  assert.equal(context.chart.sparkDisplayTime(context.chart.cpuHist), beforeNextSample);
  assert.equal(context.chart.cpuHist.at(-1).t, 8000);
  assert.equal(context.chart.cpuHist.length, 5);
});

test('rate chart scale follows only the visible viewport, including interpolated edges', () => {
  const script = readWebviewScript();
  for (const pair of ['netTxHist, netRxHist', 'sshTxHist, sshRxHist', 'diskRHist, diskWHist']) {
    assert.equal(script.split(`renderRatePair(${pair},`).length - 1, 2);
  }
  const geometry = script.slice(script.indexOf('  function sparkDisplayTime('), script.indexOf('  function renderSpark('));
  const maximum = script.slice(script.indexOf('  function sparkVisibleMaximum('), script.indexOf('  var lastSparkFrame'));
  let now = 5000;
  const context = { Date: { now: () => now }, curInterval: 2, SPARK_WINDOW: 2000 };
  vm.runInNewContext(`${geometry}\n${maximum}\nthis.maximum = sparkMaximum; this.paths = sparkPaths;`, context);

  const enteringPeak = [{ t: 1000, v: 10 }, { t: 3000, v: 10 }, { t: 5000, v: 100 }];
  assert.equal(context.maximum(enteringPeak, []), 10);
  now = 6000;
  assert.equal(context.maximum(enteringPeak, []), 55);
  assert.match(context.paths(enteringPeak, 55).area, /L100,0\.0L100,100/);
  now = 7000;
  assert.equal(context.maximum(enteringPeak, []), 100);

  const leavingPeak = [{ t: 1000, v: 100 }, { t: 3000, v: 10 }, { t: 5000, v: 10 }];
  now = 5000;
  assert.equal(context.maximum(leavingPeak, []), 100);
  now = 6000;
  assert.equal(context.maximum(leavingPeak, []), 55);
  now = 7000;
  assert.equal(context.maximum(leavingPeak, []), 10);

  assert.equal(context.maximum([{ t: 1000, v: 2 }, { t: 3000, v: 2 }, { t: 5000, v: 2 }], enteringPeak), 100);
});
