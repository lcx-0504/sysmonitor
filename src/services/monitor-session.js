'use strict';

const { MonitorService } = require('./monitor-service');
const { buildMonitorViewModel } = require('./monitor-view-model');
const { hasSettledSample } = require('./monitor-sample');
const { sshTransportOptions } = require('./collection-policy');
const { MetricHistory } = require('../core/metric-history');
const { FrameClock } = require('../core/frame-clock');

function processesSettled(snapshot) {
  const partition = snapshot.processes;
  return !!partition && (partition.value != null || !!partition.lastError);
}

class MonitorSession {
  constructor({ id = 'local', host = null, transport = null, configStore,
    isPaused = null, chartClock, onUpdate = () => {}, onLog = () => {}, serviceOptions = {}, createService = (options) => new MonitorService(options) }) {
    Object.assign(this, { id, host, transport, configStore, onUpdate });
    this.paused = false;
    this.isPaused = isPaused || (() => this.paused);
    this.state = transport ? 'connecting' : 'connected';
    this.error = null;
    this.model = null;
    this.presentedSnapshot = null;
    this.modelAt = null;
    this.metricHistory = new MetricHistory(configStore.getCurrent().refreshInterval * 1000);
    this.sampleUpdates = [];
    this.ready = false;
    this.hasInitialFrame = false;
    this.frameClock = new FrameClock({ periodMilliseconds:configStore.getCurrent().refreshInterval * 1000, now:chartClock,
      historyWindowMilliseconds:() => configStore.getCurrent().display.sparkMinutes * 60000,
      capture:(times, readyAt) => this.captureChartFrames(times, readyAt),
      publish:(frames, emit) => {
        this.sampleUpdates = frames;
        if (emit) this.notify();
      } });
    this.processesPending = false;
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
    this.transportSubscription = transport ? transport.onDidChangeState((state, error) => this.setConnection(state, error)) : null;
  }

  notify() {
    if (!this.disposed) this.onUpdate(this);
  }

  chartSamples() { return this.metricHistory.retainedSamples(); }

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
    if (state === 'connected' && this.running && !this.retryTask) this.resume();
    else if (state !== 'connected') this.service.pause();
    this.settleWaiters();
    this.notify();
  }

  resume() {
    if (this.disposed) return;
    this.running = true;
    this.metricHistory.resume();
    if (this.transport) this.transport.setIdle(false);
    if (this.transport && this.state !== 'connected') {
      this.transport.connect().catch(() => {});
      this.notify();
      return;
    }
    this.service.resume({ force: true });
    if (!this.ready && !this.requiredKeys().length) this.acceptSnapshot(this.service.readSnapshot());
    if (this.hasInitialFrame && !this.frameClock.running) this.startChartClock();
    this.notify();
  }

  start() { this.resume(); }
  pause() {
    this.stopChartClock();
    this.running = false;
    this.metricHistory.stop(this.frameClock.now());
    this.service.pause();
    if (this.transport) this.transport.setIdle(true);
    if (this.isPaused()) for (const waiter of this.waiters) waiter.finish(new Error('Monitoring paused'));
    this.notify();
  }
  setPaused(paused) {
    this.paused = paused;
    if (paused) this.pause();
    else this.resume();
  }
  setProcessDemand(demanded) {
    if (this.service.processDemand === demanded) return;
    this.service.setProcessDemand(demanded);
    this.processesPending = demanded;
    if (!this.presentedSnapshot) return;
    this.projectSnapshot({ ...this.presentedSnapshot, processes: this.service.readSnapshot().processes });
    this.notify();
  }
  updateConfig() {
    const config = this.configStore.getCurrent();
    this.frameClock.flush();
    this.metricHistory.setSampleInterval(config.refreshInterval * 1000, this.frameClock.now());
    if (this.frameClock.periodMilliseconds !== config.refreshInterval * 1000) {
      this.stopChartClock();
      this.frameClock.setPeriod(config.refreshInterval * 1000);
    }
    if (this.transport) this.transport.updateOptions(sshTransportOptions(config));
    this.service.updateConfig(config);
    this.sampleUpdates = [];
    if (this.state === 'connected') this.acceptSnapshot(this.service.readSnapshot(), { emit:false });
    else if (this.model) this.projectSnapshot(this.service.readSnapshot());
    this.notify();
  }

  hasInitialSample(snapshot, { since = 0, page = 'perf', afterSequence = this.requiredSequence, through = Date.now() } = {}) {
    return hasSettledSample(snapshot, { since: Math.max(since, this.requiredSince), through, afterSequence, keys: this.requiredKeys(page) });
  }

  acceptInitialSnapshot(snapshot) {
    if ((!this.ready && this.hasInitialSample(snapshot)) || [...this.waiters].some(waiter => this.hasInitialSample(snapshot, waiter))) {
      this.acceptSnapshot(snapshot);
    } else if (this.processesPending && this.model && this.state === 'connected' && processesSettled(snapshot)) {
      this.projectSnapshot({ ...this.presentedSnapshot, processes: snapshot.processes });
      this.notify();
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
    if (processesSettled(snapshot)) this.processesPending = false;
    this.presentedSnapshot = snapshot;
    this.model = buildMonitorViewModel(snapshot, this.configStore.getCurrent().disk);
    this.metricHistory.syncSources(this.model, this.frameClock.now());
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
        if (error) reject(error);
        else resolve();
      } };
      const onAbort = () => waiter.finish(signal.reason || new Error('Monitor wait cancelled'));
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.add(waiter);
      this.settleWaiters();
    });
  }

  waiterError() {
    if (this.disposed) return 'Monitor session disposed';
    if (this.state === 'disconnected') return this.error || 'SSH disconnected while loading';
    return this.loadError;
  }

  settleWaiters() {
    const error = this.waiterError();
    for (const waiter of this.waiters) {
      if (!error && !this.initialSampleReady(waiter.since, waiter.page, waiter.afterSequence)) continue;
      waiter.finish(error ? new Error(error) : null);
    }
  }

  viewState() {
    const snapshot = this.presentedSnapshot || this.service.readSnapshot();
    const failures = Object.entries(snapshot)
      .filter(([, part]) => part && part.status !== 'disabled' && part.lastError)
      .map(([key, part]) => ({ key, code: part.lastError.code, message: part.lastError.message }));
    if (!snapshot.accelerators.lastError) {
      for (const error of snapshot.accelerators.value?.collectionErrors || []) failures.push({ key: 'accelerators', code: error.code, message: error.message });
    }
    const processes = snapshot.processes;
    const processesReady = !!processes && processes.value !== null;
    const connected = this.state === 'connected';
    return { ready: this.ready, canPresent: this.ready || this.hasInitialFrame, hasSnapshot: !!this.model, processesReady, connected,
      loading: connected && !this.ready && !this.loadError, error: this.loadError, collecting: !!this.retryTask, failures };
  }

  snapshotMessage(hydrate = false) {
    const retryAfter = this.transport && this.transport.retryAfter;
    const canPresent = this.ready || this.hasInitialFrame;
    return { cmd: 'snapshot', deviceId: this.id, viewModel: canPresent ? this.model : null,
      sampleTime: this.modelAt,
      instant: hydrate,
      samples: hydrate ? this.chartSamples() : this.sampleUpdates,
      replaceSamples: hydrate,
      timeline: this.metricHistory.timeline(this.frameClock.now()),
      status: this.viewState(),
      connection: { state: this.state, error: this.error, ready: this.ready, canPresent, retryAfter: Number.isFinite(retryAfter) ? retryAfter : null },
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
      if (!this.ready) {
        this.requiredSequence = afterSequence;
        this.requiredSince = since;
      }
      sampleReady = this.waitForInitialSample({ since, allowPaused: true, page: 'proc', afterSequence });
      sampleReady.catch(() => {});
      this.notify();
    } }).catch((error) => {
      this.loadError = error.message;
      this.settleWaiters();
      throw error;
    });
    // The sample wait only exists once onStart has run, so it is awaited after the collection settles.
    const [collected] = await Promise.allSettled([collection]);
    const [sampled] = await Promise.allSettled([sampleReady]);
    if (collected.status === 'rejected') throw collected.reason;
    if (sampled.status === 'rejected') throw sampled.reason;
  }

  dispose() {
    this.disposed = true;
    this.transportSubscription?.dispose();
    this.pause();
    this.settleWaiters();
    this.service.dispose();
  }
}

module.exports = { MonitorSession };
