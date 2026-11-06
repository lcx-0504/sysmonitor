'use strict';
const { DEFAULT_CONFIG } = require('../config/default-config');

const COLLECTION_POLICY = Object.freeze({
  resources: { budget: 'standardTimeout', resultKeys:['cpu','memory','network','diskIo'], counters: true },
  sshTraffic: { budget: 'standardTimeout', counters: true },
  processes: { budget: 'extendedTimeout' },
  accelerators: { budget: 'extendedTimeout' },
  diskTopology: { budget: 'extendedTimeout', minimumIntervalMilliseconds: 10000 },
});

function effectiveCollection(config) {
  if (config.collection?.custom === false) return DEFAULT_CONFIG.collection;
  return { ...DEFAULT_CONFIG.collection, ...config.collection };
}

function collectionPolicy(config) {
  const settings = effectiveCollection(config);
  return Object.fromEntries(Object.entries(COLLECTION_POLICY).map(([key, { budget, ...policy }]) => [key, {
    ...policy, timeoutMilliseconds: settings[budget] * 1000,
  }]));
}

function sshTransportOptions(config) {
  const settings = effectiveCollection(config);
  return { connectionTimeoutMilliseconds: settings.connectionTimeout * 1000, maxConnections: settings.sshPoolSize };
}

module.exports = { COLLECTION_POLICY, collectionPolicy, effectiveCollection, sshTransportOptions };
