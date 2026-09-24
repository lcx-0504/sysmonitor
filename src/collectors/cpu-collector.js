'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const { parseCpuStat } = require('../domain/linux-parsers');

class CpuCollector {
  constructor({ fileReader = fs, osModule = os, systemInfo = null } = {}) { this.fileReader = fileReader; this.osModule = osModule; this.systemInfo = systemInfo; this.previous = null; }
  async collect() {
    const counters = parseCpuStat(await this.fileReader.readFile('/proc/stat', 'utf8'));
    let usagePercent = null;
    if (this.previous) {
      const totalDelta = counters.total - this.previous.total;
      const idleDelta = counters.idle - this.previous.idle;
      if (totalDelta > 0 && idleDelta >= 0) usagePercent = Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
    }
    this.previous = counters;
    const info = this.systemInfo ? await this.systemInfo.cpuInfo() : { coreCount: this.osModule.cpus().length, loadAverage: this.osModule.loadavg() };
    const [oneMinute, fiveMinutes, fifteenMinutes] = info.loadAverage;
    return { usagePercent, coreCount: info.coreCount, loadAverage: { oneMinute, fiveMinutes, fifteenMinutes } };
  }
}
module.exports = { CpuCollector };
