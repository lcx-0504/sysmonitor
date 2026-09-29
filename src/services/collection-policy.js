'use strict';

const COLLECTION_POLICY = Object.freeze({
  cpu: { timeoutMilliseconds: 10000 },
  memory: { timeoutMilliseconds: 10000 },
  network: { timeoutMilliseconds: 10000 },
  diskIo: { timeoutMilliseconds: 10000 },
  sshTraffic: { timeoutMilliseconds: 10000 },
  processes: { timeoutMilliseconds: 20000 },
  accelerators: { timeoutMilliseconds: 32000 },
  diskTopology: { timeoutMilliseconds: 10000, cadenceMilliseconds: 10000 },
});

const INITIAL_SAMPLE_TIMEOUT_MS = 45000;
module.exports = { COLLECTION_POLICY, INITIAL_SAMPLE_TIMEOUT_MS };
