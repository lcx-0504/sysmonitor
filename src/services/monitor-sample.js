'use strict';

const PERFORMANCE_PARTITIONS = ['cpu', 'memory', 'network', 'sshTraffic', 'diskIo', 'diskTopology', 'accelerators'];

function hasSettledSample(snapshot, { since = 0, through = Infinity, afterSequence = -1, keys = PERFORMANCE_PARTITIONS } = {}) {
  return keys.every((key) => {
    const part = snapshot[key];
    if (!part) return false;
    const succeeded = Number.isFinite(part.collectedAt) && part.collectedAt >= since && part.collectedAt <= through && part.collectedSequence > afterSequence;
    const failed = part.lastError && part.failureSequence > afterSequence && part.attemptedAt >= since && part.attemptedAt <= through;
    return !!(succeeded || failed);
  });
}

module.exports = { hasSettledSample };
