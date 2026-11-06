'use strict';
const { parseDefaultRouteInterfaces, parseNetworkCounters } = require('../domain/linux-parsers');

class NetworkCollector {
  needsWarmup(value) { return value.interfaces.length > 0 && (!Number.isFinite(value.receiveBytesPerSecond) || !Number.isFinite(value.transmitBytesPerSecond)); }
  constructor() { this.previous = null; }

  accept(deviceRaw, routeRaw, sampledAt) {
    const defaultRouteInterfaces = parseDefaultRouteInterfaces(routeRaw);
    let counters = parseNetworkCounters(deviceRaw, defaultRouteInterfaces);
    let interfaces = [...defaultRouteInterfaces].filter(name => counters.availableInterfaces.includes(name));
    if (interfaces.length === 0) {
      if (defaultRouteInterfaces.size) counters = parseNetworkCounters(deviceRaw);
      interfaces = counters.availableInterfaces;
    }
    const sampleIdentity = JSON.stringify(interfaces.slice().sort());
    let receiveBytesPerSecond = null;
    let transmitBytesPerSecond = null;
    let resetFields = [];
    if (this.previous && this.previous.sampleIdentity === sampleIdentity && interfaces.length) {
      const elapsedSeconds = (sampledAt - this.previous.sampledAt) / 1000;
      const receiveDelta = counters.receiveBytes - this.previous.receiveBytes;
      const transmitDelta = counters.transmitBytes - this.previous.transmitBytes;
      if (elapsedSeconds > 0 && receiveDelta >= 0 && transmitDelta >= 0) {
        receiveBytesPerSecond = receiveDelta / elapsedSeconds;
        transmitBytesPerSecond = transmitDelta / elapsedSeconds;
      }
      else if (elapsedSeconds < 0 || receiveDelta < 0 || transmitDelta < 0) resetFields = ['receiveBytesPerSecond', 'transmitBytesPerSecond'];
    }
    this.previous = { ...counters, sampledAt, sampleIdentity };
    return { receiveBytesPerSecond, transmitBytesPerSecond, sampleIdentity, resetFields, interfaces };
  }
}
module.exports = { NetworkCollector };
