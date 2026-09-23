'use strict';
function getAcceleratorAvailability(device) {
  if (device.utilizationPercent === null || !device.memory || !device.memory.totalBytes) return 'unknown';
  const memoryUsagePercent = device.memory.usedBytes / device.memory.totalBytes * 100;
  return device.utilizationPercent < 5 && memoryUsagePercent < 10 ? 'idle' : 'busy';
}
module.exports = { getAcceleratorAvailability };
