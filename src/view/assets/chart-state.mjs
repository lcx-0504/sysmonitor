import { state } from './state.mjs';
import { displayPosition } from './metric-playback.mjs';

export const DEFAULT_CHART_MINUTES = 5;
const SECOND_MILLISECONDS = 1000;
const MINUTE_MILLISECONDS = 60 * SECOND_MILLISECONDS;
const SERIES = { cpu: 'cpu', memory: 'memory', netTx: 'network', netRx: 'network', sshTx: 'sshTraffic', sshRx: 'sshTraffic', diskRead: 'diskIo', diskWrite: 'diskIo' };
const seriesSources = new WeakMap();

function newSeries(source) {
  const series = [];
  seriesSources.set(series, source);
  return series;
}

export function chartMinutes() {
  return state.config.display?.sparkMinutes || DEFAULT_CHART_MINUTES;
}

export function updateChartWindow() {
  state.charts.windowMilliseconds = chartMinutes() * MINUTE_MILLISECONDS;
}

export function initializeChartState() {
  for (const [key, source] of Object.entries(SERIES)) state.charts[key] = newSeries(source);
  state.charts.gpus = {};
  state.charts.versions = {};
  state.charts.clock = null;
  state.charts.playback = {};
  state.charts.intervalMilliseconds = state.config.refreshInterval * SECOND_MILLISECONDS;
  updateChartWindow();
}

function sourceNow() {
  const clock = state.charts.clock;
  return clock ? clock.sourceAt + performance.now() - clock.receivedAt : Date.now();
}

export function sparkDisplayTime(series = state.charts.cpu) {
  const source = typeof series === 'string' ? series : seriesSources.get(series);
  if (!source) throw new Error('Chart series has no source');
  const playback = state.charts.playback[source];
  const now = sourceNow();
  const interval = state.charts.intervalMilliseconds ?? state.config.refreshInterval * SECOND_MILLISECONDS;
  if (!playback) return Math.min(now - interval, typeof series === 'string' ? Infinity : series.at(-1)?.t ?? Infinity);
  return displayPosition(playback, now);
}

function append(series, sample, value) {
  if (!Number.isFinite(value)) return;
  const previous = series.at(-1);
  const point = { t: sample.t, v: value, segment: sample.segment,
    gapBefore: !!previous && (sample.gapBefore === true || sample.segment !== previous.segment) };
  if (previous?.t === sample.t) {
    point.gapBefore ||= previous.gapBefore;
    series[series.length - 1] = point;
  } else series.push(point);
}

function applyAcceleratorSample(sample) {
  const previous = new Map(Object.entries(state.charts.gpus).map(([index, series]) => [series.deviceKey || index, series]));
  const present = {};
  for (const gpu of sample.values.gpus) {
    const identity = gpu.deviceKey || String(gpu.idx);
    let series = previous.get(identity);
    if (!series || series.generation !== gpu.generation || sample.reset) series = newSeries('gpu:' + identity);
    series.deviceKey = gpu.deviceKey;
    series.generation = gpu.generation;
    append(series, sample, gpu.value);
    present[gpu.idx] = series;
  }
  state.charts.gpus = present;
}

export function applySamples(samples, { replace = false, timeline = null } = {}) {
  if (replace) initializeChartState();
  if (timeline && Number.isFinite(timeline.now)) {
    const previous = state.charts.clock;
    const reset = !previous || timeline.now < previous.lastReportedAt;
    state.charts.clock = { sourceAt: reset ? timeline.now : Math.max(timeline.now, sourceNow()), receivedAt: performance.now(), lastReportedAt: timeline.now };
    state.charts.intervalMilliseconds = timeline.intervalMilliseconds;
    state.charts.playback = Object.fromEntries(Object.entries(timeline.plots || {}).map(([key, value]) =>
      [key, { ...value, transition: value.transition && { ...value.transition } }]));
  }
  for (const sample of samples || []) {
    if ((state.charts.versions[sample.source] ?? -1) >= sample.sequence) continue;
    state.charts.versions[sample.source] = sample.sequence;
    if (sample.source === 'accelerators') {
      applyAcceleratorSample(sample);
      continue;
    }
    for (const [key, value] of Object.entries(sample.values)) {
      if (sample.reset) state.charts[key] = newSeries(sample.source);
      append(state.charts[key], sample, value);
    }
  }
  for (const series of [...Object.keys(SERIES).map(key => state.charts[key]), ...Object.values(state.charts.gpus)]) {
    const cutoff = sparkDisplayTime(series) - state.charts.windowMilliseconds;
    while (series.length > 2 && series[1].t < cutoff) series.shift();
  }
}
