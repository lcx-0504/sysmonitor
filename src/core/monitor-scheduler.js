'use strict';

class MonitorScheduler {
  constructor({ refreshIntervalMilliseconds, onTick, clock = () => Date.now() }) {
    this.refreshIntervalMilliseconds = refreshIntervalMilliseconds;
    this.onTick = onTick;
    this.clock = clock;
    this.runners = [];
    this.timer = null;
    this.isPaused = false;
  }

  addRunner(runner) { this.runners.push(runner); }

  tick() {
    if (this.isPaused) return;
    const now = this.clock();
    for (const runner of this.runners) runner.startIfDue(now);
    this.onTick(now);
  }

  start() {
    this.stop();
    this.isPaused = false;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.refreshIntervalMilliseconds);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  pause() { this.isPaused = true; this.stop(); }
  resume() { this.start(); }

  setRefreshInterval(refreshIntervalMilliseconds) {
    this.refreshIntervalMilliseconds = refreshIntervalMilliseconds;
    for (const runner of this.runners) {
      if (runner.cadenceSource === 'refreshInterval') runner.setCadence(refreshIntervalMilliseconds);
    }
    if (!this.isPaused) this.start();
  }

  dispose() {
    this.stop();
    for (const runner of this.runners) runner.invalidate();
  }
}

module.exports = { MonitorScheduler };
