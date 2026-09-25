'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();

function timeoutError(message) {
  const error = new Error(message);
  error.code = 'ETIMEDOUT';
  return error;
}

function executionOptions(options = {}) {
  const current = context.getStore();
  const signal = options.signal || current && current.signal;
  if (signal && signal.aborted) throw signal.reason || new Error('Collection cancelled');
  const remaining = current ? current.deadline - Date.now() : Infinity;
  if (remaining <= 0) throw timeoutError('Collection deadline exceeded');
  return { ...options, signal, timeoutMilliseconds: Math.min(options.timeoutMilliseconds || remaining, remaining) };
}

function withCollectionContext(value, operation) { return context.run(value, operation); }

module.exports = { executionOptions, timeoutError, withCollectionContext };
