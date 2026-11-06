'use strict';
const { parseDiskIoCounters } = require('../domain/linux-parsers');
const { counterRates } = require('../utils/counter-rates');

const DISK_IO_RATES = Object.freeze({ readBytesPerSecond: 'readBytes', writeBytesPerSecond: 'writeBytes' });

class DiskIoCollector {
  constructor() {
    this.previous = null;
  }

  needsWarmup(value) {
    return value.sampleIdentity !== '[]' && (!Number.isFinite(value.readBytesPerSecond) || !Number.isFinite(value.writeBytesPerSecond));
  }

  accept(raw, sampledAt) {
    const counters = parseDiskIoCounters(raw);
    const sampleIdentity = JSON.stringify(counters.devices.slice().sort());
    const current = { ...counters, sampledAt, sampleIdentity };
    const comparable = this.previous && this.previous.sampleIdentity === sampleIdentity && counters.devices.length > 0;
    const { rates, resetFields } = counterRates(comparable ? this.previous : null, current, DISK_IO_RATES);
    this.previous = current;
    return { ...rates, resetFields, sampleIdentity };
  }
}
module.exports = { DiskIoCollector };
