'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const { parseCpuStat } = require('../domain/linux-parsers');

class CpuCollector {
  constructor({ fileReader = fs, osModule = os } = {}) { this.fileReader = fileReader; this.osModule = osModule; this.previous = null; }
  async collect() {
    const counters = parseCpuStat(await this.fileReader.readFile('/proc/stat', 'utf8'));
    let usagePercent = null;
    if (this.previous) {
      const totalDelta = counters.total - this.previous.total;
      const idleDelta = counters.idle - this.previous.idle;
      if (totalDelta > 0 && idleDelta >= 0) usagePercent = Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
    }
    this.previous = counters;
    const [oneMinute, fiveMinutes, fifteenMinutes] = this.osModule.loadavg();
    return { usagePercent, coreCount: this.osModule.cpus().length, loadAverage: { oneMinute, fiveMinutes, fifteenMinutes } };
  }
}
module.exports = { CpuCollector };
