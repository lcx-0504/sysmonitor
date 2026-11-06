'use strict';
const { DEFAULT_CONFIG } = require('../config/default-config');
const { performance } = require('node:perf_hooks');

function monotonicTimeline(wallNow = () => Date.now(), monotonicNow = () => performance.now()) {
  const origin = wallNow(), started = monotonicNow();
  return () => origin + monotonicNow() - started;
}

class FrameClock {
  constructor({ periodMilliseconds, capture, publish, historyWindowMilliseconds = () => DEFAULT_CONFIG.display.sparkMinutes * 60000,
    now = monotonicTimeline(), setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { periodMilliseconds, capture, publish, historyWindowMilliseconds, now, setTimer, clearTimer });
    this.running = false;
    this.nextAt = null;
    this.timer = null;
  }

  start(emit = true) {
    this.stop();
    this.running = true;
    this.nextAt = this.now();
    this.flush(emit);
    this.schedule();
  }

  flush(emit = true) {
    if (!this.running) return;
    const through = this.now(), times = [];
    const earliest = through - this.historyWindowMilliseconds() - 2 * this.periodMilliseconds;
    if (this.nextAt < earliest) this.nextAt += Math.ceil((earliest - this.nextAt) / this.periodMilliseconds) * this.periodMilliseconds;
    while (this.nextAt <= through) {
      times.push(this.nextAt);
      this.nextAt += this.periodMilliseconds;
    }
    if (times.length) this.publish(this.capture(times, through), emit);
  }

  schedule() {
    if (!this.running) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flush();
      this.schedule();
    }, Math.max(1, this.nextAt - this.now()));
  }

  stop() {
    this.running = false;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  setPeriod(periodMilliseconds) {
    if (periodMilliseconds === this.periodMilliseconds) return;
    this.periodMilliseconds = periodMilliseconds;
    if (this.running) this.start(false);
  }
}

module.exports = { FrameClock, monotonicTimeline };
