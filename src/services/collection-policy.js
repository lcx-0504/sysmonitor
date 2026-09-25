'use strict';

const COLLECTION_POLICY = Object.freeze({
  cpu: { timeoutMilliseconds: 5000 },
  memory: { timeoutMilliseconds: 5000 },
  network: { timeoutMilliseconds: 5000 },
  diskIo: { timeoutMilliseconds: 5000 },
  sshTraffic: { timeoutMilliseconds: 10000 },
  processes: { timeoutMilliseconds: 12000 },
  accelerators: { timeoutMilliseconds: 32000 },
  diskTopology: { timeoutMilliseconds: 6000, cadenceMilliseconds: 10000 },
});

const INITIAL_SAMPLE_TIMEOUT_MS = 45000;
module.exports = { COLLECTION_POLICY, INITIAL_SAMPLE_TIMEOUT_MS };
