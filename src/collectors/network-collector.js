'use strict';
const fs = require('node:fs/promises');
const { performance } = require('node:perf_hooks');
const { parseDefaultRouteInterfaces, parseNetworkCounters } = require('../domain/linux-parsers');

class NetworkCollector {
  constructor({ fileReader = fs, monotonicClock = () => performance.now() } = {}) { this.fileReader = fileReader; this.monotonicClock = monotonicClock; this.previous = null; }
  async collect() {
    const [deviceRaw, routeRaw] = await Promise.all([
      this.fileReader.readFile('/proc/net/dev', 'utf8'),
      this.fileReader.readFile('/proc/net/route', 'utf8').catch(() => ''),
    ]);
    const defaultRouteInterfaces = parseDefaultRouteInterfaces(routeRaw);
    const counters = parseNetworkCounters(deviceRaw, defaultRouteInterfaces);
    const sampledAt = this.monotonicClock();
    let receiveBytesPerSecond = null;
    let transmitBytesPerSecond = null;
    if (this.previous) {
      const elapsedSeconds = (sampledAt - this.previous.sampledAt) / 1000;
      const receiveDelta = counters.receiveBytes - this.previous.receiveBytes;
      const transmitDelta = counters.transmitBytes - this.previous.transmitBytes;
      if (elapsedSeconds > 0 && receiveDelta >= 0 && transmitDelta >= 0) {
        receiveBytesPerSecond = receiveDelta / elapsedSeconds;
        transmitBytesPerSecond = transmitDelta / elapsedSeconds;
      }
    }
    this.previous = { ...counters, sampledAt };
    return { receiveBytesPerSecond, transmitBytesPerSecond, interfaces: defaultRouteInterfaces.size ? [...defaultRouteInterfaces] : counters.availableInterfaces, usedFallbackInterfaces: defaultRouteInterfaces.size === 0 };
  }
}
module.exports = { NetworkCollector };
