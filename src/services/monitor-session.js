'use strict';

const { MonitorService } = require('./monitor-service');
const { buildMonitorViewModel } = require('./monitor-view-model');
const { hasCompletePerformanceSample, performanceSampleError } = require('./monitor-sample');
const { INITIAL_SAMPLE_TIMEOUT_MS } = require('./collection-policy');

function deviceHistoryPoint(model, time) {
  const p = model.performance;
  return { t: time, cpu: p.cpu.usagePercent, ram: p.memory.usagePercent,
    netTx: p.network.transmitBytesPerSecond, netRx: p.network.receiveBytesPerSecond,
    diskR: p.diskIo.readBytesPerSecond, diskW: p.diskIo.writeBytesPerSecond,
    sshTx: p.sshTraffic.uploadBytesPerSecond || 0, sshRx: p.sshTraffic.downloadBytesPerSecond || 0,
    gpus: p.gpus.map((gpu) => ({ idx: gpu.idx, util: gpu.util })) };
}

class MonitorSession {
  constructor({ id = 'local', host = null, transport = null, configStore, language,
    isPaused = null, onUpdate = () => {}, onLog = () => {}, serviceOptions = {}, createService = (options) => new MonitorService(options) }) {
    Object.assign(this, { id, host, transport, configStore, language, onUpdate });
    this.paused = false;
    this.isPaused = isPaused || (() => this.paused);
    this.state = transport ? 'connecting' : 'connected';
    this.error = null;
    this.model = null;
    this.modelAt = null;
    this.history = [];
    this.ready = false;
    this.requiredSince = 0;
    this.requiredSequence = -1;
    this.loadError = null;
    this.loadTimer = null;
    this.waiters = new Set();
    this.running = false;
    this.disposed = false;
    this.retryTask = null;
    this.service = createService({ ...serviceOptions, runtimeConfig: configStore.getCurrent(),
      onLog, onSnapshot: (snapshot) => this.acceptSnapshot(snapshot) });
    this.service.pause();
    if (transport) transport.onState = (state, error) => this.setConnection(state, error);
  }

  notify() { if (!this.disposed) this.onUpdate(this); }

  setConnection(state, error) {
    this.state = state;
    this.error = error ? error.message : null;
    this.ready = false;
    this.requiredSince = Date.now();
    this.requiredSequence = this.service.readSnapshot().sequence;
    this.loadError = null;
    clearTimeout(this.loadTimer);
    this.loadTimer = null;
    if (state === 'connected' && this.running) this.resume({ force: true });
    else if (state !== 'connected') this.service.pause();
    this.settleWaiters();
    this.notify();
  }

  resume({ force = false } = {}) {
    if (this.disposed) return;
    this.running = true;
    if (this.transport && this.state !== 'connected') {
      this.transport.connect().catch(() => {});
      return;
    }
    if (!this.ready && !this.loadTimer) this.loadTimer = setTimeout(() => {
      this.loadTimer = null;
      this.loadError = 'Timed out waiting for CPU, memory, disk and GPU data';
      this.settleWaiters();
      this.notify();
    }, INITIAL_SAMPLE_TIMEOUT_MS);
    this.service.resume({ force });
  }

  start() { this.resume({ force: true }); }
  pause() {
    this.running = false;
    this.service.pause();
    clearTimeout(this.loadTimer);
    this.loadTimer = null;
    if (this.isPaused()) for (const waiter of this.waiters) waiter.finish(new Error('Monitoring paused'));
  }
  setPaused(paused) { this.paused = paused; paused ? this.pause() : this.resume(); }
  updateConfig() { this.service.updateConfig(this.configStore.getCurrent()); }

  acceptSnapshot(snapshot) {
    if (this.disposed || this.state !== 'connected') return;
    const now = Date.now();
    if (!this.ready && !hasCompletePerformanceSample(snapshot, { since: this.requiredSince, through: now, afterSequence: this.requiredSequence })) {
      const error = performanceSampleError(snapshot, this.requiredSequence);
      if (error) {
        this.loadError = error.message;
        clearTimeout(this.loadTimer);
        this.loadTimer = null;
        this.settleWaiters();
        this.notify();
      }
      return;
    }
    this.ready = true;
    this.loadError = null;
    clearTimeout(this.loadTimer);
    this.loadTimer = null;
    this.model = buildMonitorViewModel(snapshot, this.language, this.configStore.getCurrent().disk);
    this.modelAt = now;
    if (!this.isPaused()) {
      const interval = this.configStore.getCurrent().refreshInterval * 1000;
      const latest = this.history[this.history.length - 1];
      const point = deviceHistoryPoint(this.model, latest && now - latest.t < interval ? latest.t : now);
      if (latest && point.t === latest.t) this.history[this.history.length - 1] = point;
      else this.history.push(point);
      let span = 0;
      const budget = this.configStore.getCurrent().display.sparkMinutes * 60000 + 60000;
      for (let index = this.history.length - 1; index > 0; index--) {
        const delta = this.history[index].t - this.history[index - 1].t;
        span += delta > interval * 2 ? interval : delta;
        if (span > budget) { this.history.splice(0, Math.max(0, index - 1)); break; }
      }
    }
    this.settleWaiters();
    this.notify();
  }

  initialSampleReady(since = 0, page = 'perf', afterSequence = this.requiredSequence) {
    if (this.state !== 'connected' || !this.model || this.modelAt === null) return false;
    const snapshot = this.service.readSnapshot();
    if (!hasCompletePerformanceSample(snapshot, { since: Math.max(since, this.requiredSince), through: this.modelAt, afterSequence })) return false;
    const processes = snapshot.processes;
    return page !== 'proc' || !!(processes && processes.status === 'fresh' && processes.collectedAt >= since
      && processes.collectedAt <= this.modelAt && processes.collectedSequence > afterSequence);
  }

  hasCompletedInitialSample() { return this.state === 'connected' && this.ready; }

  waitForInitialSample({ since = 0, allowPaused = false, page = 'perf', signal = null, afterSequence = this.requiredSequence } = {}) {
    if (this.initialSampleReady(since, page, afterSequence)) return Promise.resolve();
    if (this.disposed) return Promise.reject(new Error('Monitor session disposed'));
    if (signal && signal.aborted) return Promise.reject(signal.reason || new Error('Monitor wait cancelled'));
    if (this.isPaused() && !allowPaused) return Promise.reject(new Error('Resume monitoring to load this server'));
    return new Promise((resolve, reject) => {
      const waiter = { since, page, afterSequence, timer: null, finish: (error) => {
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve();
      } };
      const onAbort = () => waiter.finish(signal.reason || new Error('Monitor wait cancelled'));
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      waiter.timer = setTimeout(() => waiter.finish(new Error('Timed out waiting for monitor data')), INITIAL_SAMPLE_TIMEOUT_MS);
      this.waiters.add(waiter);
      this.settleWaiters();
    });
  }

  settleWaiters() {
    const error = this.disposed ? 'Monitor session disposed' : this.state === 'disconnected' ? this.error || 'SSH disconnected while loading' : this.loadError;
    for (const waiter of this.waiters) {
      const processes = this.service.readSnapshot().processes;
      const processError = waiter.page === 'proc' && processes && processes.lastError && processes.failureSequence > waiter.afterSequence ? processes.lastError.message : null;
      const failure = error || processError;
      if (!failure && !this.initialSampleReady(waiter.since, waiter.page, waiter.afterSequence)) continue;
      waiter.finish(failure ? new Error(failure) : null);
    }
  }

  viewState() {
    const snapshot = this.service.readSnapshot();
    const failures = Object.entries(snapshot).filter(([, part]) => part && part.lastError).map(([key, part]) => ({ key, message: part.lastError.message }));
    const processes = snapshot.processes;
    const processesReady = !!processes && processes.value !== null;
    return { ready: this.ready, hasSnapshot: !!this.model, processesReady, connected: this.state === 'connected', loading: this.state === 'connected' && !this.ready && !this.loadError,
      error: this.loadError || (!this.retryTask && !processesReady && processes && processes.lastError ? processes.lastError.message : null), failures };
  }

  snapshotMessage(hydrate = false) {
    const latest = this.history[this.history.length - 1];
    const retryAfter = this.transport && this.transport.retryAfter;
    return { cmd: 'snapshot', deviceId: this.id, viewModel: this.model,
      sampleTime: this.isPaused() ? this.modelAt : latest ? latest.t : this.modelAt,
      skipHistory: hydrate || this.isPaused(), instant: hydrate,
      ...(hydrate ? { samples: this.history } : {}),
      status: this.viewState(),
      connection: { state: this.state, error: this.error, ready: this.ready, retryAfter: Number.isFinite(retryAfter) ? retryAfter : null },
    };
  }

  retry() {
    if (this.retryTask) return this.retryTask;
    this.retryTask = Promise.resolve().then(() => this.retryOnce()).catch((error) => {
      if (!this.ready) this.loadError = error.message;
      throw error;
    }).finally(() => { this.retryTask = null; this.notify(); });
    return this.retryTask;
  }

  async retryOnce() {
    const wasPaused = this.isPaused();
    const since = Date.now();
    this.loadError = null;
    if (this.transport && this.state !== 'connected') await this.transport.retryNow();
    if (this.disposed) throw new Error('Monitor session disposed');
    if (!this.ready) { this.requiredSequence = this.service.readSnapshot().sequence; this.requiredSince = since; }
    this.notify();
    const result = this.waitForInitialSample({ since, allowPaused: true, page: 'proc', afterSequence: this.service.readSnapshot().sequence });
    this.service.resume({ force: true });
    try { await result; }
    finally { if (wasPaused && this.isPaused()) this.service.pause(); }
  }

  dispose() {
    this.disposed = true;
    this.pause();
    this.settleWaiters();
    this.service.dispose();
  }
}

module.exports = { MonitorSession };
