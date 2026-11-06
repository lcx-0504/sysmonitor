'use strict';

const { parseCpuStat } = require('../domain/linux-parsers');

class CpuCollector {
  needsWarmup(value) { return !Number.isFinite(value.usagePercent); }
  constructor() { this.previous = null; }

  accept(raw, info) {
    const counters = parseCpuStat(raw);
    let usagePercent = null;
    const resetFields = this.previous && counters.total < this.previous.total ? ['usagePercent'] : [];
    if (this.previous) {
      const totalDelta = counters.total - this.previous.total;
      const idleDelta = counters.idle - this.previous.idle;
      if (totalDelta > 0 && idleDelta >= 0) usagePercent = Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
    }
    this.previous = counters;
    if (!Number.isInteger(info.coreCount) || info.coreCount <= 0 || info.loadAverage.length !== 3 || !info.loadAverage.every(Number.isFinite)) throw Object.assign(new Error('Incomplete CPU information'), { code: 'EINCOMPLETE' });
    const [oneMinute, fiveMinutes, fifteenMinutes] = info.loadAverage;
    return { usagePercent, resetFields, coreCount: info.coreCount, loadAverage: { oneMinute, fiveMinutes, fifteenMinutes } };
  }
}
module.exports = { CpuCollector };
