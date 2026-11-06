'use strict';

const { MonitorService } = require('./monitor-service');
const { buildMonitorViewModel } = require('./monitor-view-model');
const { hasSettledSample } = require('./monitor-sample');
const { effectiveTimeouts } = require('./collection-policy');
const { MetricHistory } = require('../core/metric-history');
const { FrameClock } = require('../core/frame-clock');

class MonitorSession {
  constructor({ id = 'local', host = null, transport = null, configStore, language,
    isPaused = null, chartClock, onUpdate = () => {}, onLog = () => {}, serviceOptions = {}, createService = (options) => new MonitorService(options) }) {
    Object.assign(this, { id, host, transport, configStore, language, onUpdate });
    this.paused = false;
    this.isPaused = isPaused || (() => this.paused);
    this.state = transport ? 'connecting' : 'connected';
    this.error = null;
    this.model = null;
    this.presentedSnapshot = null;
    this.modelAt = null;
    this.history = [];
    this.metricHistory = new MetricHistory(this.history, configStore.getCurrent().refreshInterval * 1000);
    this.sampleUpdates = [];
    this.ready = false;
    this.hasInitialFrame = false;
    this.frameClock = new FrameClock({ periodMilliseconds:configStore.getCurrent().refreshInterval * 1000, now:chartClock,
      historyWindowMilliseconds:() => configStore.getCurrent().display.sparkMinutes * 60000,
      capture:(times, readyAt) => this.captureChartFrames(times, readyAt), publish:(frames, emit) => { this.sampleUpdates = frames; if (emit) this.notify(); } });
    this.requiredSince = 0;
    this.requiredSequence = -1;
    this.loadError = null;
    this.waiters = new Set();
    this.running = false;
    this.disposed = false;
    this.retryTask = null;
    this.service = createService({ ...serviceOptions, runtimeConfig: configStore.getCurrent(),
      onLog, onSnapshot: (snapshot) => this.acceptSnapshot(snapshot),
      onCollectionSettled: (snapshot) => this.acceptInitialSnapshot(snapshot) });
    this.service.pause();
    if (transport) transport.onState = (state, error) => this.setConnection(state, error);
  }

  notify() { if (!this.disposed) this.onUpdate(this); }

  setConnection(state, error) {
    this.stopChartClock();
    this.state = state;
    this.error = error ? error.message : null;
    this.ready = false;
    this.requiredSince = Date.now();
    this.requiredSequence = this.service.readSnapshot().sequence;
    this.loadError = null;
    if (state === 'connected' && !this.isPaused()) this.metricHistory.resume();
    else this.metricHistory.stop(this.frameClock.now(), { gap: false });
    if (state === 'connected' && this.running && !this.retryTask) this.resume({ force: true });
    else if (state !== 'connected') this.service.pause();
    this.settleWaiters();
    this.notify();
  }

  resume({ force = false } = {}) {
    if (this.disposed) return;
    this.running = true;
    this.metricHistory.resume();
    if (this.transport && this.state !== 'connected') {
      this.transport.connect().catch(() => {});
      this.notify();
      return;
    }
    this.service.resume({ force });
    if (!this.ready && !this.requiredKeys().length) this.acceptSnapshot(this.service.readSnapshot());
    if (this.hasInitialFrame && !this.frameClock.running) this.startChartClock();
    this.notify();
  }

  start() { this.resume({ force: true }); }
  pause() {
    this.stopChartClock();
    this.running = false;
    this.metricHistory.stop(this.frameClock.now());
    this.service.pause();
    if (this.isPaused()) for (const waiter of this.waiters) waiter.finish(new Error('Monitoring paused'));
    this.notify();
  }
  setPaused(paused) { this.paused = paused; paused ? this.pause() : this.resume(); }
  updateConfig() {
    const config = this.configStore.getCurrent();
    this.frameClock.flush();
    this.metricHistory.setInterval(config.refreshInterval * 1000, this.frameClock.now());
    if (this.frameClock.periodMilliseconds !== config.refreshInterval * 1000) {
      this.stopChartClock();
      this.frameClock.setPeriod(config.refreshInterval * 1000);
    }
    if (this.transport) {
      const policy = effectiveTimeouts(config);
      this.transport.connectionTimeoutMilliseconds = policy.connection * 1000;
      this.transport.setMaxConnections(policy.sshPoolSize);
    }
    this.service.updateConfig(config);
    this.sampleUpdates = [];
    if (this.state === 'connected') this.acceptSnapshot(this.service.readSnapshot(), { emit:false });
    else {
      if (this.model) this.projectSnapshot(this.service.readSnapshot());
    }
    this.notify();
  }

  hasInitialSample(snapshot, { since = 0, page = 'perf', afterSequence = this.requiredSequence, through = Date.now() } = {}) {
    return hasSettledSample(snapshot, { since: Math.max(since, this.requiredSince), through, afterSequence, keys: this.requiredKeys(page) });
  }

  acceptInitialSnapshot(snapshot) {
    if ((!this.ready && this.hasInitialSample(snapshot)) || [...this.waiters].some(waiter => this.hasInitialSample(snapshot, waiter))) {
      this.acceptSnapshot(snapshot);
    }
  }

  acceptSnapshot(snapshot, { emit = true } = {}) {
    if (this.disposed || this.state !== 'connected') return;
    this.frameClock.flush();
    const now = Date.now();
    this.ready = this.ready || this.hasInitialSample(snapshot, { through: now });
    this.hasInitialFrame ||= this.ready;
    this.loadError = null;
    this.projectSnapshot(snapshot);
    this.modelAt = now;
    this.sampleUpdates = [];
    if (!this.isPaused() && this.hasInitialFrame && !this.frameClock.running && this.running) this.startChartClock();
    this.settleWaiters();
    if (emit) this.notify();
  }

  projectSnapshot(snapshot) {
    this.presentedSnapshot = snapshot;
    this.model = buildMonitorViewModel(snapshot, this.language, this.configStore.getCurrent().disk);
    this.metricHistory.syncSources(this.model, this.frameClock.now());
  }

  captureChartFrame(at) {
    return this.captureChartFrames([at], at);
  }

  captureChartFrames(times, readyAt) {
    if (!this.model || !this.hasInitialFrame || this.state !== 'connected' || this.isPaused()) return [];
    const config = this.configStore.getCurrent();
    return this.metricHistory.recordDisplayFrames(this.model, times, readyAt, config.display.sparkMinutes * 60000);
  }

  startChartClock() {
    this.frameClock.start(false);
  }

  stopChartClock() { this.frameClock.stop(); }

  initialSampleReady(since = 0, page = 'perf', afterSequence = this.requiredSequence) {
    if (this.state !== 'connected' || !this.model || this.modelAt === null) return false;
    return this.hasInitialSample(this.presentedSnapshot, { since, page, through: this.modelAt, afterSequence });
  }

  requiredKeys(page = 'perf') { return this.service.requiredKeys(page); }

  hasCompletedInitialSample() { return this.state === 'connected' && this.ready; }

  waitForInitialSample({ since = 0, allowPaused = false, page = 'perf', signal = null, afterSequence = this.requiredSequence } = {}) {
    if (this.initialSampleReady(since, page, afterSequence)) return Promise.resolve();
    if (this.disposed) return Promise.reject(new Error('Monitor session disposed'));
    if (signal && signal.aborted) return Promise.reject(signal.reason || new Error('Monitor wait cancelled'));
    if (this.isPaused() && !allowPaused) return Promise.reject(new Error('Resume monitoring to load this server'));
    return new Promise((resolve, reject) => {
      const waiter = { since, page, afterSequence, finish: (error) => {
        this.waiters.delete(waiter);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve();
      } };
      const onAbort = () => waiter.finish(signal.reason || new Error('Monitor wait cancelled'));
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.add(waiter);
      this.settleWaiters();
    });
  }

  settleWaiters() {
    const error = this.disposed ? 'Monitor session disposed' : this.state === 'disconnected' ? this.error || 'SSH disconnected while loading' : this.loadError;
    for (const waiter of this.waiters) {
      const failure = error;
      if (!failure && !this.initialSampleReady(waiter.since, waiter.page, waiter.afterSequence)) continue;
      waiter.finish(failure ? new Error(failure) : null);
    }
  }

  viewState() {
    const snapshot = this.presentedSnapshot || this.service.readSnapshot();
    const failures = Object.entries(snapshot).filter(([, part]) => part && part.status !== 'disabled' && part.lastError).map(([key, part]) => ({ key, code: part.lastError.code, message: part.lastError.message }));
    if (!snapshot.accelerators.lastError) {
      for (const error of snapshot.accelerators.value?.collectionErrors || []) failures.push({ key: 'accelerators', code: error.code, message: error.message });
    }
    const processes = snapshot.processes;
    const processesReady = !!processes && processes.value !== null;
    return { ready: this.ready, canPresent: this.ready || this.hasInitialFrame, hasSnapshot: !!this.model, processesReady, connected: this.state === 'connected', loading: this.state === 'connected' && !this.ready && !this.loadError,
      error: this.loadError, collecting: !!this.retryTask, failures };
  }

  snapshotMessage(hydrate = false) {
    const retryAfter = this.transport && this.transport.retryAfter;
    return { cmd: 'snapshot', deviceId: this.id, viewModel: this.ready || this.hasInitialFrame ? this.model : null,
      sampleTime: this.modelAt,
      instant: hydrate,
      samples: hydrate ? this.history : this.sampleUpdates,
      replaceSamples: hydrate,
      timeline: this.metricHistory.timeline(this.frameClock.now()),
      status: this.viewState(),
      connection: { state: this.state, error: this.error, ready: this.ready, canPresent: this.ready || this.hasInitialFrame, retryAfter: Number.isFinite(retryAfter) ? retryAfter : null },
    };
  }

  retry() {
    if (this.retryTask) return this.retryTask;
    this.retryTask = Promise.resolve().then(() => this.retryOnce()).catch((error) => {
      if (!this.ready) this.loadError = error.message;
      throw error;
    }).finally(() => {
      this.retryTask = null;
      if (this.running && this.state === 'connected' && !this.isPaused()) this.service.resume();
      this.notify();
    });
    return this.retryTask;
  }

  async retryOnce() {
    this.loadError = null;
    if (this.transport && this.state !== 'connected') await this.transport.retryNow();
    if (this.disposed) throw new Error('Monitor session disposed');
    this.notify();
    let sampleReady = Promise.resolve();
    const collection = this.service.collectOnce({ onStart: () => {
      const since = Date.now();
      const afterSequence = this.service.readSnapshot().sequence;
      this.loadError = null;
      if (!this.ready) { this.requiredSequence = afterSequence; this.requiredSince = since; }
      sampleReady = this.waitForInitialSample({ since, allowPaused: true, page: 'proc', afterSequence });
      sampleReady.catch(() => {});
      this.notify();
    } }).catch((error) => {
      this.loadError = error.message;
      this.settleWaiters();
      throw error;
    });
    const outcomes = await Promise.allSettled([collection]);
    outcomes.push(...await Promise.allSettled([sampleReady]));
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure) throw failure.reason;
  }

  dispose() {
    this.stopChartClock();
    this.disposed = true;
    this.pause();
    this.settleWaiters();
    this.service.dispose();
  }
}

module.exports = { MonitorSession };
