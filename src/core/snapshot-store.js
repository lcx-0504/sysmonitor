'use strict';

const PARTITIONS = Object.freeze([
  'cpu', 'memory', 'network', 'diskIo', 'diskTopology',
  'sshTraffic', 'processes', 'accelerators',
]);

const createPartition = () => Object.freeze({
  value: null,
  status: 'loading',
  attemptedAt: null,
  collectedAt: null,
  failureCount: 0,
  lastError: null,
});

class SnapshotStore {
  constructor() {
    this.sequence = 0;
    this.snapshot = Object.freeze(Object.fromEntries(PARTITIONS.map((key) => [key, createPartition()])));
  }

  read() { return this.snapshot; }

  markAttempted(key, attemptedAt) {
    this.replace(key, { ...this.snapshot[key], attemptedAt });
  }

  commit(key, value, collectedAt = Date.now()) {
    this.replace(key, Object.freeze({
      value,
      status: 'fresh',
      attemptedAt: this.snapshot[key].attemptedAt,
      collectedAt,
      failureCount: 0,
      lastError: null,
    }));
  }

  fail(key, error, attemptedAt = Date.now(), isUnavailable = false) {
    const previous = this.snapshot[key];
    const hasValue = previous.value !== null;
    this.replace(key, Object.freeze({
      ...previous,
      status: isUnavailable && !hasValue ? 'unavailable' : hasValue ? 'stale' : 'loading',
      attemptedAt,
      failureCount: previous.failureCount + 1,
      lastError: error ? { code: error.code || null, message: error.message || String(error) } : null,
    }));
  }

  replace(key, partition) {
    if (!PARTITIONS.includes(key)) throw new Error(`Unknown snapshot partition: ${key}`);
    this.sequence += 1;
    this.snapshot = Object.freeze({ ...this.snapshot, [key]: partition, sequence: this.sequence });
  }
}

module.exports = { PARTITIONS, SnapshotStore };
