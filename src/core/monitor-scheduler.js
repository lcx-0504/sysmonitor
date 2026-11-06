'use strict';

class MonitorScheduler {
  constructor({ refreshIntervalMilliseconds, onTick, clock = () => Date.now() }) {
    this.refreshIntervalMilliseconds = refreshIntervalMilliseconds;
    this.onTick = onTick;
    this.clock = clock;
    this.runners = [];
    this.timer = null;
    this.isPaused = false;
    this.isCollectingOnce = false;
    this.oneShot = null;
    this.oneShotStarted = false;
    this.oneShotGeneration = null;
    this.refreshes = new Map();
    this.generation = 0;
    this.runnerChanges = new AbortController();
  }

  get activeRunners() { return this.runners.filter(runner => runner.enabled !== false); }

  signalRunnerChange() {
    const previous = this.runnerChanges;
    this.runnerChanges = new AbortController();
    previous.abort();
  }

  async settleCurrent(generation, promises) {
    while (generation === this.generation) {
      const signal = this.runnerChanges.signal;
      let wake;
      const changed = new Promise(resolve => {
        wake = () => resolve(null);
        signal.addEventListener('abort', wake, { once:true });
      });
      const results = await Promise.race([Promise.allSettled(promises()), changed]);
      signal.removeEventListener('abort', wake);
      if (signal.aborted) continue;
      return results;
    }
    return [];
  }

  async waitForIdle(generation) {
    const results = await this.settleCurrent(generation, () => this.activeRunners.map(runner => Promise.resolve().then(() => runner.whenIdle())));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  startTimer() {
    if (this.timer !== null || this.isPaused || this.isCollectingOnce) return;
    this.timer = setInterval(() => this.tick(), this.refreshIntervalMilliseconds);
  }

  addRunner(runner) {
    runner.cadenceCycles = this.cadenceCycles(runner);
    this.runners.push(runner);
  }

  cadenceCycles(runner) {
    return Math.max(1, Math.ceil((runner.minimumIntervalMilliseconds || 0) / this.refreshIntervalMilliseconds));
  }

  setRunnerDemand(runner, resultKeys, { refresh = true } = {}) {
    if (!runner.setDemand(resultKeys)) return;
    this.queueRefresh(runner, refresh);
  }

  refreshRunner(runner) {
    runner.invalidate({ reason: 'Collection configuration changed' });
    runner.markDue();
    return this.queueRefresh(runner);
  }

  queueRefresh(runner, refresh = true) {
    this.signalRunnerChange();
    if (runner.enabled === false || !refresh) {
      this.refreshes.delete(runner);
      return Promise.resolve();
    }
    const request = {};
    this.refreshes.set(runner, request);
    request.promise = Promise.resolve().then(() => runner.whenIdle()).then(() => {
      if (this.refreshes.get(runner) !== request) return;
      const oneShot = this.isCollectingOnce && this.oneShotStarted && this.oneShotGeneration === this.generation;
      if (runner.enabled !== false && (oneShot || !this.isPaused && !this.isCollectingOnce)) return runner.run(this.clock());
    }).catch(error => {
      if (this.refreshes.get(runner) !== request || runner.enabled === false) return;
      runner.reportFailure(error);
      runner.onSettled(runner.key);
    }).finally(() => {
      if (this.refreshes.get(runner) !== request) return;
      this.refreshes.delete(runner);
    });
    return request.promise;
  }

  tick({ advance = true } = {}) {
    if (this.isPaused || this.isCollectingOnce) return;
    const now = this.clock();
    for (const runner of this.activeRunners) {
      if (advance) runner.advanceCycle();
      runner.startIfDue();
    }
    this.onTick(now);
  }

  start() {
    this.generation++;
    this.signalRunnerChange();
    this.stop();
    this.isPaused = false;
    this.tick({ advance: false });
    this.startTimer();
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  pause() {
    this.generation++;
    this.signalRunnerChange();
    this.isPaused = true;
    this.stop();
    this.refreshes.clear();
    for (const runner of this.runners) runner.invalidate({ abortRunning: false, reason: 'Monitoring paused' });
  }
  resume() { this.start(); }

  collectOnce({ onStart = () => {} } = {}) {
    if (this.oneShot) return this.oneShot;
    const generation = this.generation;
    this.oneShotGeneration = generation;
    this.stop();
    this.isCollectingOnce = true;
    this.oneShotStarted = false;
    this.oneShot = this.waitForIdle(generation).then(async () => {
      if (generation !== this.generation) return [];
      onStart();
      this.oneShotStarted = true;
      const running = new Map(this.activeRunners.map(runner => [runner, runner.run(this.clock())]));
      const results = await this.settleCurrent(generation, () => [...running].filter(([runner]) => runner.enabled !== false).map(([, promise]) => promise));
      while (generation === this.generation && this.refreshes.size) {
        results.push(...await this.settleCurrent(generation, () => [...this.refreshes.values()].map(request => request.promise)));
      }
      return results;
    }).then((results) => {
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
    }).finally(() => {
      this.isCollectingOnce = false;
      this.oneShotStarted = false;
      this.oneShot = null;
      this.startTimer();
    });
    return this.oneShot;
  }

  setRefreshInterval(refreshIntervalMilliseconds) {
    this.refreshIntervalMilliseconds = refreshIntervalMilliseconds;
    for (const runner of this.runners) runner.cadenceCycles = this.cadenceCycles(runner);
    if (!this.isPaused) this.start();
  }

  dispose() {
    this.generation++;
    this.signalRunnerChange();
    this.isPaused = true;
    this.stop();
    this.refreshes.clear();
    for (const runner of this.runners) runner.invalidate();
  }
}

module.exports = { MonitorScheduler };
