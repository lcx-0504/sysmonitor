'use strict';
const fs = require('node:fs/promises');
const { performance } = require('node:perf_hooks');
const { parseDiskIoCounters } = require('../domain/linux-parsers');
class DiskIoCollector {
  constructor({ fileReader = fs, monotonicClock = () => performance.now() } = {}) { this.fileReader = fileReader; this.monotonicClock = monotonicClock; this.previous = null; }
  async collect() {
    const counters = parseDiskIoCounters(await this.fileReader.readFile('/proc/diskstats', 'utf8'));
    const sampledAt = this.monotonicClock();
    let readBytesPerSecond = null; let writeBytesPerSecond = null;
    if (this.previous) {
      const elapsedSeconds = (sampledAt - this.previous.sampledAt) / 1000;
      const readDelta = counters.readBytes - this.previous.readBytes;
      const writeDelta = counters.writeBytes - this.previous.writeBytes;
      if (elapsedSeconds > 0 && readDelta >= 0 && writeDelta >= 0) { readBytesPerSecond = readDelta / elapsedSeconds; writeBytesPerSecond = writeDelta / elapsedSeconds; }
    }
    this.previous = { ...counters, sampledAt };
    return { readBytesPerSecond, writeBytesPerSecond };
  }
}
module.exports = { DiskIoCollector };
