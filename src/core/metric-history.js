'use strict';
const { REFRESH_SETTING } = require('../config/default-config');
const { playbackPosition, displayPosition } = require('./metric-playback');

const METRIC_SOURCES = ['cpu', 'memory', 'network', 'diskIo', 'sshTraffic', 'accelerators'];

function metricValues(model, key) {
  const p = model.performance;
  const value = number => Number.isFinite(number) ? number : null;
  switch (key) {
    case 'cpu': return { cpu: value(p.cpu.usagePercent) };
    case 'memory': return { memory: value(p.memory.usagePercent) };
    case 'network': return { netTx: value(p.network.transmitBytesPerSecond), netRx: value(p.network.receiveBytesPerSecond) };
    case 'diskIo': return { diskRead: value(p.diskIo.readBytesPerSecond), diskWrite: value(p.diskIo.writeBytesPerSecond) };
    case 'sshTraffic': return { sshTx: value(p.sshTraffic.uploadBytesPerSecond), sshRx: value(p.sshTraffic.downloadBytesPerSecond) };
    case 'accelerators': return { gpus: p.gpus.map(gpu => ({ idx: gpu.idx, deviceKey: gpu.deviceKey, value: value(gpu.util) })) };
    default: throw new Error('Unknown chart source: ' + key);
  }
}

class MetricHistory {
  constructor(samples = [], intervalMilliseconds = REFRESH_SETTING.default * 1000) {
    this.samples = samples;
    this.lastTimes = new Map();
    this.segment = 0;
    this.lastSegments = new Map();
    this.stoppedAt = null;
    this.gapOnResume = false;
    this.intervalMilliseconds = intervalMilliseconds;
    this.playback = new Map();
    this.gpuGenerations = new Map();
    this.frameSequence = 0;
    this.disabledSources = new Set();
    this.sourceEpochs = new Map();
    this.emptySamples = new Map();
  }

  syncSources(model, now) {
    for (const key of METRIC_SOURCES) {
      const disabled = model.sources[key].state === 'disabled';
      if (disabled && !this.disabledSources.has(key)) {
        this.sourceEpochs.set(key, (this.sourceEpochs.get(key) || 0) + 1);
        for (const [plot, playback] of this.playback) {
          if (plot !== key && !(key === 'accelerators' && plot.startsWith('gpu:'))) continue;
          playback.heldAt = this.displayTime(plot, now);
          playback.transition = null;
        }
      }
      if (disabled) this.disabledSources.add(key);
      else this.disabledSources.delete(key);
    }
  }

  displayTime(source, now) {
    return displayPosition(this.playback.get(source), now);
  }

  setInterval(intervalMilliseconds, now) {
    if (this.intervalMilliseconds === intervalMilliseconds) return;
    for (const [source, playback] of this.playback) {
      const current = this.displayTime(source, now);
      playback.floor = current;
      playback.anchorAt = now;
      playback.anchorTime = playback.latestAt - intervalMilliseconds;
      playback.transition = null;
      if (playback.heldAt === null && playback.anchorTime > current) {
        playback.transition = { from: current, at: now, duration: intervalMilliseconds };
      }
    }
    this.intervalMilliseconds = intervalMilliseconds;
  }

  timeline(now) {
    const plots = {};
    for (const [plot, playback] of this.playback) {
      if (playback.transition && now >= playback.transition.at + playback.transition.duration) playback.transition = null;
      plots[plot] = { ...playback, transition: playback.transition && { ...playback.transition } };
    }
    return { now, stoppedAt: this.stoppedAt, intervalMilliseconds: this.intervalMilliseconds, plots };
  }

  stop(now, { gap = true } = {}) {
    this.gapOnResume ||= gap;
    if (this.stoppedAt !== null && !gap) return;
    if (gap) for (const [source, playback] of this.playback) {
      playback.heldAt = this.displayTime(source, now);
      playback.transition = null;
    }
    this.stoppedAt ??= now;
  }

  resume() {
    if (this.stoppedAt === null) return;
    this.stoppedAt = null;
    if (this.gapOnResume) this.segment++;
    this.gapOnResume = false;
  }

  recordDisplayFrame(model, now, windowMilliseconds) {
    return this.recordDisplayFrames(model, [now], now, windowMilliseconds);
  }

  recordDisplayFrames(model, times, readyAt, windowMilliseconds) {
    if (this.stoppedAt !== null) return [];
    const updates = [];
    const updatedPlots = new Map();
    for (const now of times) {
      const sequence = ++this.frameSequence;
      for (const key of METRIC_SOURCES) {
        const source = model.sources[key];
        if (source.state !== 'ready') continue;
        const segment = this.segment + ':' + (this.sourceEpochs.get(key) || 0);
        const last = this.lastTimes.get(key);
        const reset = last !== undefined && now < last;
        if (reset) {
          for (let index = this.samples.length - 1; index >= 0; index--) if (this.samples[index].source === key) this.samples.splice(index, 1);
          for (const plot of this.playback.keys()) if (plot === key || key === 'accelerators' && plot.startsWith('gpu:')) this.playback.delete(plot);
          this.lastSegments.delete(key);
        }
        const values = metricValues(model, key);
        const hasValues = key === 'accelerators' ? values.gpus.some(gpu => Number.isFinite(gpu.value)) : Object.values(values).some(Number.isFinite);
        if (!hasValues && now !== times.at(-1)) continue;
        const inventoryCleared = key === 'accelerators' && !values.gpus.length && this.gpuGenerations.size > 0;
        if (key === 'accelerators') {
          const generations = new Map();
          for (const gpu of values.gpus) {
            const identity = gpu.deviceKey || String(gpu.idx);
            // Carry the appearance boundary even after value-less inventory events are trimmed.
            gpu.generation = reset ? sequence : this.gpuGenerations.get(identity) ?? sequence;
            generations.set(identity, gpu.generation);
          }
          this.gpuGenerations = generations;
        }
        const sample = { source: key, sequence, t:now,
          segment, gapBefore: hasValues && this.lastSegments.has(key) && this.lastSegments.get(key) !== segment, reset, values };
        if (hasValues) {
          const plots = new Set(metricEntries(sample).filter(([, value]) => Number.isFinite(value)).map(([metric]) => plotKey(key, metric)));
          for (const plot of plots) updatedPlots.set(plot, now);
          this.lastSegments.set(key, segment);
        }
        if (key === 'accelerators') {
          const present = new Set(values.gpus.map(gpu => plotKey(key, gpu.deviceKey || String(gpu.idx))));
          for (const plot of this.playback.keys()) if (plot.startsWith('gpu:') && !present.has(plot)) this.playback.delete(plot);
        }
        this.lastTimes.set(key, now);
        // Keep only the latest value-less event (it can carry a changed GPU inventory).
        const empty = this.emptySamples.get(key);
        if (empty) {
          const index = this.samples.indexOf(empty);
          if (index >= 0) this.samples.splice(index, 1);
          this.emptySamples.delete(key);
        }
        if (key === 'accelerators' && !values.gpus.length) {
          if (inventoryCleared) for (let index = this.samples.length - 1; index >= 0; index--) if (this.samples[index].source === key) this.samples.splice(index, 1);
          this.lastSegments.delete(key);
        }
        if (!hasValues) this.emptySamples.set(key, sample);
        this.samples.push(sample);
        updates.push(sample);
      }
    }
    for (const [plot, sampledAt] of updatedPlots) this.advance(plot, sampledAt, readyAt);
    const predecessors = new Map(), latestEvents = new Map(), retained = new Set();
    const cutoffs = new Map([...this.playback.keys()].map(plot => [plot, this.displayTime(plot, readyAt) - windowMilliseconds]));
    for (const sample of this.samples) {
      latestEvents.set(sample.source, sample);
      for (const [metric, value] of metricEntries(sample)) {
        if (!Number.isFinite(value)) continue;
        const cutoff = cutoffs.get(plotKey(sample.source, metric)) ?? readyAt - this.intervalMilliseconds - windowMilliseconds;
        if (sample.t >= cutoff) retained.add(sample);
        else predecessors.set(sample.source + '\0' + metric, sample);
      }
    }
    for (const sample of [...predecessors.values(), ...latestEvents.values()]) retained.add(sample);
    for (let index = this.samples.length - 1; index >= 0; index--) {
      if (!retained.has(this.samples[index])) this.samples.splice(index, 1);
    }
    return updates;
  }

  advance(source, sampledAt, now) {
    let playback = this.playback.get(source);
    if (!playback) {
      const initial = sampledAt - this.intervalMilliseconds;
      playback = { latestAt: sampledAt, anchorTime: initial, anchorAt: now, floor: initial,
        heldAt: this.stoppedAt === null ? null : initial, transition: null };
      this.playback.set(source, playback);
      return;
    }
    const current = this.displayTime(source, now);
    const starved = playbackPosition(playback, now) > playback.latestAt;
    const held = playback.heldAt !== null;
    playback.latestAt = sampledAt;
    if (this.stoppedAt !== null) return;
    playback.heldAt = null;
    if (held || starved) {
      playback.floor = current;
      playback.anchorAt = now;
      playback.anchorTime = Math.max(current, sampledAt - this.intervalMilliseconds);
      playback.transition = playback.anchorTime > current ? { from: current, at: now, duration: this.intervalMilliseconds } : null;
    }
  }
}

function metricEntries(sample) {
  return sample.source === 'accelerators'
    ? sample.values.gpus.map(gpu => [gpu.deviceKey || String(gpu.idx), gpu.value])
    : Object.entries(sample.values);
}

function plotKey(source, metric) { return source === 'accelerators' ? 'gpu:' + metric : source; }

module.exports = { MetricHistory };
