'use strict';

const PERFORMANCE_PARTITIONS = ['cpu', 'memory', 'diskIo', 'diskTopology', 'accelerators'];

function hasCompletePerformanceSample(snapshot, { since = 0, through = Infinity } = {}) {
  return PERFORMANCE_PARTITIONS.every((key) => {
    const part = snapshot[key];
    return part && part.status === 'fresh' && Number.isFinite(part.collectedAt)
      && part.collectedAt >= since && part.collectedAt <= through;
  });
}

module.exports = { hasCompletePerformanceSample };
