'use strict';

const PERFORMANCE_PARTITIONS = ['cpu', 'memory', 'diskIo', 'diskTopology', 'accelerators'];

function hasCompletePerformanceSample(snapshot, { since = 0, through = Infinity, afterSequence = -1 } = {}) {
  return PERFORMANCE_PARTITIONS.every((key) => {
    const part = snapshot[key];
    return part && part.status === 'fresh' && Number.isFinite(part.collectedAt)
      && part.collectedAt >= since && part.collectedAt <= through
      && (afterSequence < 0 || part.collectedSequence > afterSequence);
  });
}

function performanceSampleError(snapshot, afterSequence) {
  for (const key of PERFORMANCE_PARTITIONS) {
    const part = snapshot[key];
    if (part && part.lastError && part.failureSequence > afterSequence) return part.lastError;
  }
  return null;
}

module.exports = { hasCompletePerformanceSample, performanceSampleError };
