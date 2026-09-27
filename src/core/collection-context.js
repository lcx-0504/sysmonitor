'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
const COLLECTION_ENV = Object.freeze({ LC_ALL: 'C', TZ: 'UTC' });

function timeoutError(message) {
  const error = new Error(message);
  error.code = 'ETIMEDOUT';
  return error;
}

function executionOptions(options = {}) {
  const current = context.getStore();
  const signal = options.signal || current && current.signal;
  const dispatchSignal = options.dispatchSignal || current && current.dispatchSignal;
  if (dispatchSignal && dispatchSignal.aborted) throw dispatchSignal.reason || new Error('Collection paused');
  if (signal && signal.aborted) throw signal.reason || new Error('Collection cancelled');
  const remaining = current ? current.deadline - Date.now() : Infinity;
  if (remaining <= 0) throw timeoutError('Collection deadline exceeded');
  return { ...options, signal, dispatchSignal, timeoutMilliseconds: Math.min(options.timeoutMilliseconds || remaining, remaining) };
}

function withCollectionContext(value, operation) { return context.run(value, operation); }

module.exports = { COLLECTION_ENV, executionOptions, timeoutError, withCollectionContext };
