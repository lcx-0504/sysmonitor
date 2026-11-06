'use strict';
const { parseDiskIoCounters } = require('../domain/linux-parsers');
class DiskIoCollector {
  needsWarmup(value) { return value.sampleIdentity !== '[]' && (!Number.isFinite(value.readBytesPerSecond) || !Number.isFinite(value.writeBytesPerSecond)); }
  constructor() { this.previous = null; }

  accept(raw, sampledAt) {
    const counters = parseDiskIoCounters(raw);
    const sampleIdentity = JSON.stringify(counters.devices.slice().sort());
    let readBytesPerSecond = null; let writeBytesPerSecond = null;
    let resetFields = [];
    if (this.previous && this.previous.sampleIdentity === sampleIdentity && counters.devices.length) {
      const elapsedSeconds = (sampledAt - this.previous.sampledAt) / 1000;
      const readDelta = counters.readBytes - this.previous.readBytes;
      const writeDelta = counters.writeBytes - this.previous.writeBytes;
      if (elapsedSeconds > 0 && readDelta >= 0 && writeDelta >= 0) { readBytesPerSecond = readDelta / elapsedSeconds; writeBytesPerSecond = writeDelta / elapsedSeconds; }
      else if (elapsedSeconds < 0 || readDelta < 0 || writeDelta < 0) resetFields = ['readBytesPerSecond', 'writeBytesPerSecond'];
    }
    this.previous = { ...counters, sampledAt, sampleIdentity };
    return { readBytesPerSecond, writeBytesPerSecond, resetFields, sampleIdentity };
  }
}
module.exports = { DiskIoCollector };
