'use strict';
function getAcceleratorAvailability(occupied, complete) {
  if (!complete) return 'unknown';
  return occupied ? 'busy' : 'idle';
}
module.exports = { getAcceleratorAvailability };
