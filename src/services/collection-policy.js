'use strict';
const { DEFAULT_CONFIG } = require('../config/default-config');

const COLLECTION_POLICY = Object.freeze({
  resources: { budget: 'standard', resultKeys:['cpu','memory','network','diskIo'], counters: true },
  sshTraffic: { budget: 'standard', counters: true },
  processes: { budget: 'extended' },
  accelerators: { budget: 'extended' },
  diskTopology: { budget: 'extended', minimumIntervalMilliseconds: 10000 },
});

function effectiveTimeouts(config) {
  return config.timeouts?.enabled === false ? DEFAULT_CONFIG.timeouts : { ...DEFAULT_CONFIG.timeouts, ...config.timeouts };
}
function collectionPolicy(config) {
  const timeouts = effectiveTimeouts(config);
  return Object.fromEntries(Object.entries(COLLECTION_POLICY).map(([key, { budget, ...policy }]) => [key, {
    ...policy, timeoutMilliseconds: timeouts[budget] * 1000,
  }]));
}
module.exports = { COLLECTION_POLICY, collectionPolicy, effectiveTimeouts };
