'use strict';
const { parseDefaultRouteInterfaces, parseNetworkCounters } = require('../domain/linux-parsers');
const { counterRates } = require('../utils/counter-rates');

const NETWORK_RATES = Object.freeze({ receiveBytesPerSecond: 'receiveBytes', transmitBytesPerSecond: 'transmitBytes' });

class NetworkCollector {
  constructor() {
    this.previous = null;
  }

  needsWarmup(value) {
    return value.interfaces.length > 0 && (!Number.isFinite(value.receiveBytesPerSecond) || !Number.isFinite(value.transmitBytesPerSecond));
  }

  accept(deviceRaw, routeRaw, sampledAt) {
    const defaultRouteInterfaces = parseDefaultRouteInterfaces(routeRaw);
    let counters = parseNetworkCounters(deviceRaw, defaultRouteInterfaces);
    let interfaces = [...defaultRouteInterfaces].filter(name => counters.availableInterfaces.includes(name));
    if (interfaces.length === 0) {
      if (defaultRouteInterfaces.size) counters = parseNetworkCounters(deviceRaw);
      interfaces = counters.availableInterfaces;
    }
    const sampleIdentity = JSON.stringify(interfaces.slice().sort());
    const current = { ...counters, sampledAt, sampleIdentity };
    const comparable = this.previous && this.previous.sampleIdentity === sampleIdentity && interfaces.length > 0;
    const { rates, resetFields } = counterRates(comparable ? this.previous : null, current, NETWORK_RATES);
    this.previous = current;
    return { ...rates, sampleIdentity, resetFields, interfaces };
  }
}
module.exports = { NetworkCollector };
