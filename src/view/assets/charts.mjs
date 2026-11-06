import { state } from "./state.mjs";
import { initializeChartState, sparkDisplayTime } from "./chart-state.mjs";

let lastSparkFrame;

function sparkColor(pct) {
    return pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warn)' : 'var(--accent)';
  }

function sparkInterpolatedValue(before, after, time) {
    var span = after.t - before.t;
    return span > 0 ? before.v + (after.v - before.v) * (time - before.t) / span : after.v;
  }

function sparkPaths(hist, maxVal, viewTime) {
    if (hist.length < 2) return null;
    var now = viewTime === undefined ? sparkDisplayTime(hist) : viewTime;
    var t0 = now - state.charts.windowMilliseconds;
    var segments = [];
    hist.forEach(function(point) {
      if (!segments.length || point.gapBefore) segments.push([]);
      segments[segments.length - 1].push(point);
    });
    var lines = [], areas = [];
    segments.forEach(function(points) {
    var pts = [];
    var firstInside = 0;
    while (firstInside < points.length && points[firstInside].t < t0) firstInside++;
    if (firstInside > 0 && firstInside < points.length) {
      var before = points[firstInside - 1], after = points[firstInside];
      var startValue = sparkInterpolatedValue(before, after, t0);
      pts.push('0,' + (100 - Math.min(startValue / maxVal * 100, 100)).toFixed(1));
    }
    for (var i = firstInside; i < points.length; i++) {
      if (points[i].t > now) {
        if (i > 0 && points[i - 1].t <= now && pts.length) {
          var endValue = sparkInterpolatedValue(points[i - 1], points[i], now);
          pts.push('100,' + (100 - Math.min(endValue / maxVal * 100, 100)).toFixed(1));
        }
        break;
      }
      var x = ((points[i].t - t0) / state.charts.windowMilliseconds * 100).toFixed(4);
      var y = (100 - Math.min(points[i].v / maxVal * 100, 100)).toFixed(1);
      pts.push(x + ',' + y);
    }
    if (pts.length < 2) return;
    var line = 'M' + pts.join('L');
    var area = line + 'L' + pts[pts.length-1].split(',')[0] + ',100L' + pts[0].split(',')[0] + ',100Z';
    lines.push(line); areas.push(area);
    });
    return lines.length ? { line: lines.join(''), area: areas.join('') } : null;
  }

function renderSpark(areaEl, hist, maxVal, color, viewTime) {
    var p = sparkPaths(hist, maxVal, viewTime);
    if (!p) { areaEl.removeAttribute('d'); return; }
    areaEl.setAttribute('d', p.area);
    areaEl.style.fill = color;
    areaEl.setAttribute('fill-opacity', document.body.classList.contains('vscode-dark') ? '0.12' : '0.06');
  }

function sparkVisibleMaximum(hist, now) {
    if (!hist) return 0;
    var start = now - state.charts.windowMilliseconds;
    var maximum = 0;
    for (var i = 0; i < hist.length; i++) {
      var point = hist[i];
      if (point.t >= start && point.t <= now && point.v > maximum) maximum = point.v;
      if (i === 0 || point.gapBefore) continue;
      var before = hist[i - 1];
      if (before.t < start && point.t > start) maximum = Math.max(maximum, sparkInterpolatedValue(before, point, start));
      if (before.t <= now && point.t > now) maximum = Math.max(maximum, sparkInterpolatedValue(before, point, now));
    }
    return maximum;
  }

function sparkMaximum(first, second, viewTime) {
    var now = viewTime === undefined ? sparkDisplayTime(first?.length ? first : second) : viewTime;
    return Math.max(1, sparkVisibleMaximum(first, now), sparkVisibleMaximum(second, now));
  }

function renderRatePair(first, second, firstAreaId, secondAreaId, firstColor, secondColor) {
    var now = sparkDisplayTime(first.length ? first : second);
    var maximum = sparkMaximum(first, second, now);
    renderSpark(document.getElementById(firstAreaId), first, maximum, firstColor, now);
    renderSpark(document.getElementById(secondAreaId), second, maximum, secondColor, now);
  }

function renderGpuSpark(gpu) {
    const identity = gpu.deviceKey || String(gpu.idx);
    const match = Object.entries(state.charts.gpus).find(([index, series]) => (series.deviceKey || index) === identity);
    const series = match?.[1] || [];
    const area = document.getElementById('gpu-spark-area-' + gpu.idx);
    if (area) renderSpark(area, series, 100, sparkColor(gpu.util));
  }

function animateSparks(frameTime) {
    if (frameTime - lastSparkFrame >= 32 && !state.ui.paused && state.ui.canAnimate && state.config.display && state.config.display.charts !== false && document.getElementById('tab-perf').classList.contains('active')) {
      lastSparkFrame = frameTime;
      const current = state.data.viewModel?.performance;
      renderSpark(document.getElementById('cpu-spark-area'), state.charts.cpu, 100, sparkColor(current?.cpu.usagePercent));
      renderSpark(document.getElementById('ram-spark-area'), state.charts.memory, 100, sparkColor(current?.memory.usagePercent));
      renderRatePair(state.charts.netTx, state.charts.netRx, 'net-spark-tx-area', 'net-spark-rx-area', 'var(--warn)', 'var(--accent)');
      renderRatePair(state.charts.sshTx, state.charts.sshRx, 'ssh-spark-tx-area', 'ssh-spark-rx-area', 'var(--warn)', 'var(--accent)');
      renderRatePair(state.charts.diskRead, state.charts.diskWrite, 'disk-spark-r-area', 'disk-spark-w-area', 'var(--warn)', 'var(--accent)');
      state.data.gpus.forEach(renderGpuSpark);
    }
    requestAnimationFrame(animateSparks);
  }

export function initializeCharts() { initializeChartState(); lastSparkFrame = 0; }

export { sparkColor, sparkInterpolatedValue, sparkPaths, renderSpark, sparkVisibleMaximum, sparkMaximum, renderRatePair, renderGpuSpark, animateSparks };
