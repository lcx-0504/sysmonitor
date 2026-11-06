'use strict';

// Converts two observations of cumulative counters into per-second rates.
// `counters` maps each rate field to the counter it is derived from; both observations carry `sampledAt`.
// A clock that moved backwards or a counter that decreased marks every rate field for reset.
function counterRates(previous, current, counters) {
  const fields = Object.keys(counters);
  const rates = Object.fromEntries(fields.map(field => [field, null]));
  if (!previous) return { rates, resetFields: [], clockReversed: false };
  const seconds = (current.sampledAt - previous.sampledAt) / 1000;
  const deltas = fields.map(field => current[counters[field]] - previous[counters[field]]);
  if (seconds > 0 && deltas.every(delta => delta >= 0)) {
    fields.forEach((field, index) => {
      rates[field] = deltas[index] / seconds;
    });
    return { rates, resetFields: [], clockReversed: false };
  }
  const reset = seconds < 0 || deltas.some(delta => delta < 0);
  return { rates, resetFields: reset ? fields : [], clockReversed: seconds < 0 };
}

module.exports = { counterRates };
