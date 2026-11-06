'use strict';

const { parseCpuStat } = require('../domain/linux-parsers');
const { incompleteError } = require('../utils/errors');

const validLoadAverage = values => values.length === 3 && values.every(Number.isFinite);

class CpuCollector {
  constructor() {
    this.previous = null;
  }

  needsWarmup(value) { return !Number.isFinite(value.usagePercent); }

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
    if (!Number.isInteger(info.coreCount) || info.coreCount <= 0 || !validLoadAverage(info.loadAverage)) throw incompleteError('Incomplete CPU information');
    const [oneMinute, fiveMinutes, fifteenMinutes] = info.loadAverage;
    return { usagePercent, resetFields, coreCount: info.coreCount, loadAverage: { oneMinute, fiveMinutes, fifteenMinutes } };
  }
}
module.exports = { CpuCollector };
