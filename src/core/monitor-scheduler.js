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
    this.generation = 0;
  }

  addRunner(runner) { this.runners.push(runner); }

  tick() {
    if (this.isPaused) return;
    const now = this.clock();
    for (const runner of this.runners) runner.startIfDue(now);
    this.onTick(now);
  }

  start() {
    this.generation++;
    this.stop();
    this.isPaused = false;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.refreshIntervalMilliseconds);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  pause() {
    this.generation++;
    this.isPaused = true;
    this.stop();
    for (const runner of this.runners) runner.invalidate({ abortRunning: false, reason: 'Monitoring paused' });
  }
  resume() { this.start(); }

  collectOnce() {
    if (this.oneShot) return this.oneShot;
    const generation = this.generation;
    this.stop();
    this.isCollectingOnce = true;
    this.oneShot = Promise.allSettled(this.runners.map(async (runner) => {
      await runner.whenIdle();
      if (generation === this.generation) await runner.run(this.clock());
    })).then((results) => {
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
    }).finally(() => {
      this.isCollectingOnce = false;
      this.oneShot = null;
      if (generation === this.generation && !this.isPaused) {
        this.timer = setInterval(() => this.tick(), this.refreshIntervalMilliseconds);
      }
    });
    return this.oneShot;
  }

  setRefreshInterval(refreshIntervalMilliseconds) {
    this.refreshIntervalMilliseconds = refreshIntervalMilliseconds;
    for (const runner of this.runners) {
      if (runner.cadenceSource === 'refreshInterval') runner.setCadence(refreshIntervalMilliseconds);
    }
    if (!this.isPaused) this.start();
  }

  dispose() {
    this.generation++;
    this.isPaused = true;
    this.stop();
    for (const runner of this.runners) runner.invalidate();
  }
}

module.exports = { MonitorScheduler };
