import { state, currentGpus } from './state.mjs';
import { initializeChartState, sparkDisplayTime } from './chart-state.mjs';
import { colorClass } from './ui.mjs';

// Charts redraw at most once per this interval while animating.
const FRAME_INTERVAL_MILLISECONDS = 32;
const CHART_SCALE = 100;

let lastSparkFrame = 0;
let animationFrame = null;
let animationAllowed = true;
let gpuSeriesSource = null;
let gpuSeriesByKey = new Map();

function sparkColor(percent) {
  return 'var(--' + (colorClass(percent) || 'accent') + ')';
}

function sparkInterpolatedValue(before, after, time) {
  const span = after.t - before.t;
  return span > 0 ? before.v + (after.v - before.v) * (time - before.t) / span : after.v;
}

function chartY(value, maximum) {
  return (CHART_SCALE - Math.min(value / maximum * CHART_SCALE, CHART_SCALE)).toFixed(1);
}

function segmentPoints(points, maximum, start, now) {
  const coordinates = [];
  let firstInside = 0;
  while (firstInside < points.length && points[firstInside].t < start) firstInside++;
  if (firstInside > 0 && firstInside < points.length) {
    coordinates.push('0,' + chartY(sparkInterpolatedValue(points[firstInside - 1], points[firstInside], start), maximum));
  }
  for (let i = firstInside; i < points.length; i++) {
    if (points[i].t > now) {
      if (i > 0 && points[i - 1].t <= now && coordinates.length) {
        coordinates.push(CHART_SCALE + ',' + chartY(sparkInterpolatedValue(points[i - 1], points[i], now), maximum));
      }
      break;
    }
    const x = ((points[i].t - start) / state.charts.windowMilliseconds * CHART_SCALE).toFixed(4);
    coordinates.push(x + ',' + chartY(points[i].v, maximum));
  }
  return coordinates;
}

function sparkPaths(history, maximum, viewTime) {
  if (history.length < 2) return null;
  const now = viewTime === undefined ? sparkDisplayTime(history) : viewTime;
  const start = now - state.charts.windowMilliseconds;
  const segments = [];
  for (const point of history) {
    if (!segments.length || point.gapBefore) segments.push([]);
    segments.at(-1).push(point);
  }
  const lines = [];
  const areas = [];
  for (const points of segments) {
    const coordinates = segmentPoints(points, maximum, start, now);
    if (coordinates.length < 2) continue;
    const line = 'M' + coordinates.join('L');
    lines.push(line);
    areas.push(line + 'L' + coordinates.at(-1).split(',')[0] + ',' + CHART_SCALE + 'L' + coordinates[0].split(',')[0] + ',' + CHART_SCALE + 'Z');
  }
  return lines.length ? { line: lines.join(''), area: areas.join('') } : null;
}

function renderSpark(area, history, maximum, color, viewTime) {
  const paths = sparkPaths(history, maximum, viewTime);
  if (!paths) {
    area.removeAttribute('d');
    return;
  }
  area.setAttribute('d', paths.area);
  area.style.fill = color;
  area.setAttribute('fill-opacity', document.body.classList.contains('vscode-dark') ? '0.12' : '0.06');
}

function sparkVisibleMaximum(history, now) {
  if (!history) return 0;
  const start = now - state.charts.windowMilliseconds;
  let maximum = 0;
  for (let i = 0; i < history.length; i++) {
    const point = history[i];
    if (point.t >= start && point.t <= now && point.v > maximum) maximum = point.v;
    if (i === 0 || point.gapBefore) continue;
    const before = history[i - 1];
    if (before.t < start && point.t > start) maximum = Math.max(maximum, sparkInterpolatedValue(before, point, start));
    if (before.t <= now && point.t > now) maximum = Math.max(maximum, sparkInterpolatedValue(before, point, now));
  }
  return maximum;
}

function sparkMaximum(first, second, viewTime) {
  const now = viewTime === undefined ? sparkDisplayTime(first?.length ? first : second) : viewTime;
  return Math.max(1, sparkVisibleMaximum(first, now), sparkVisibleMaximum(second, now));
}

function renderRatePair(first, second, firstAreaId, secondAreaId) {
  const now = sparkDisplayTime(first.length ? first : second);
  const maximum = sparkMaximum(first, second, now);
  renderSpark(document.getElementById(firstAreaId), first, maximum, 'var(--warn)', now);
  renderSpark(document.getElementById(secondAreaId), second, maximum, 'var(--accent)', now);
}

function renderPercentSpark(areaId, history, percent) {
  renderSpark(document.getElementById(areaId), history, CHART_SCALE, sparkColor(percent));
}

function gpuSeries(gpu) {
  if (gpuSeriesSource !== state.charts.gpus) {
    gpuSeriesSource = state.charts.gpus;
    gpuSeriesByKey = new Map(Object.entries(state.charts.gpus).map(([index, series]) => [series.deviceKey || index, series]));
  }
  return gpuSeriesByKey.get(gpu.deviceKey || String(gpu.idx)) || [];
}

function renderGpuSpark(gpu) {
  const area = document.getElementById('gpu-spark-area-' + gpu.idx);
  if (area) renderSpark(area, gpuSeries(gpu), CHART_SCALE, sparkColor(gpu.util));
}

function sparkAnimationAllowed() {
  return !state.ui.paused && animationAllowed && state.config.display.charts !== false && !document.hidden && state.ui.page === 'perf';
}

function renderVisibleSparks() {
  const hidden = state.config.display.hiddenGroups || {};
  const current = state.data.viewModel?.performance;
  if (!hidden.cpu) renderPercentSpark('cpu-spark-area', state.charts.cpu, current?.cpu.usagePercent);
  if (!hidden.memory) renderPercentSpark('ram-spark-area', state.charts.memory, current?.memory.usagePercent);
  if (!hidden.network) {
    renderRatePair(state.charts.netTx, state.charts.netRx, 'net-spark-tx-area', 'net-spark-rx-area');
    if (current?.sshTraffic?.isSsh) renderRatePair(state.charts.sshTx, state.charts.sshRx, 'ssh-spark-tx-area', 'ssh-spark-rx-area');
  }
  if (!hidden.disk) renderRatePair(state.charts.diskRead, state.charts.diskWrite, 'disk-spark-r-area', 'disk-spark-w-area');
  if (!hidden.gpuCards) currentGpus().forEach(renderGpuSpark);
}

function animateSparks(frameTime) {
  animationFrame = null;
  if (!sparkAnimationAllowed()) return;
  if (frameTime - lastSparkFrame >= FRAME_INTERVAL_MILLISECONDS) {
    lastSparkFrame = frameTime;
    renderVisibleSparks();
  }
  animationFrame = requestAnimationFrame(animateSparks);
}

function updateSparkAnimation() {
  if (animationFrame === null && sparkAnimationAllowed()) animationFrame = requestAnimationFrame(animateSparks);
}

// Animation runs only while the current connection can present samples.
function setChartAnimationAllowed(allowed) {
  animationAllowed = allowed;
  updateSparkAnimation();
}

export function initializeCharts() {
  initializeChartState();
}

export function resetCharts() {
  initializeChartState();
  animationAllowed = false;
  document.querySelectorAll('.spark-bg path').forEach((path) => path.removeAttribute('d'));
}

export { sparkColor, sparkPaths, renderSpark, renderPercentSpark, sparkMaximum, renderRatePair, renderGpuSpark, updateSparkAnimation, setChartAnimationAllowed };
