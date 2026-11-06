'use strict';
const { withCollectionContext, timeoutError } = require('./collection-context');
const { setTimeout: delay } = require('node:timers/promises');

// Counter-derived metrics need a second observation before their first publication.
const COUNTER_WARMUP_INTERVAL_MS = 100;

async function collectReadyValue(collector, signal, onPartial) {
  let value = await collector.collect({ onPartial });
  while (collector.needsWarmup?.(value)) {
    await delay(COUNTER_WARMUP_INTERVAL_MS, undefined, { signal });
    value = await collector.collect({ onPartial });
  }
  return value;
}

class CollectorRunner {
  constructor({ key, resultKeys = [key], grouped = resultKeys.length > 1, collector, snapshotStore, minimumIntervalMilliseconds = 0,
    timeoutMilliseconds, clock = () => Date.now(), onStatusChange = () => {}, onSettled = () => {} }) {
    this.key = key;
    this.collector = collector;
    this.resultKeys = resultKeys;
    this.grouped = grouped;
    this.enabled = true;
    this.resetOnNextRun = false;
    this.snapshotStore = snapshotStore;
    this.minimumIntervalMilliseconds = minimumIntervalMilliseconds;
    this.cadenceCycles = 1;
    this.elapsedCycles = Infinity;
    this.timeoutMilliseconds = timeoutMilliseconds;
    this.clock = clock;
    this.onStatusChange = onStatusChange;
    this.onSettled = onSettled;
    this.controller = null;
    this.dispatchController = null;
    this.generation = 0;
    // A run lasts until both its result handling (execution) and the collector call itself (pendingCollection)
    // have settled; a timed-out collector can keep running after execution has reported the timeout.
    this.isRunning = false;
    this.execution = Promise.resolve();
    this.pendingCollection = Promise.resolve();
    this.collectionSettled = true;
    this.idle = Promise.resolve();
  }

  configure({ timeoutMilliseconds = this.timeoutMilliseconds } = {}) {
    this.timeoutMilliseconds = timeoutMilliseconds;
  }

  requestReset() { this.resetOnNextRun = true; }
  markDue() { this.elapsedCycles = Infinity; }
  advanceCycle() { this.elapsedCycles += 1; }
  setDemand(resultKeys) {
    const previous = this.enabled ? this.resultKeys : [];
    if (previous.length === resultKeys.length && previous.every((key, index) => key === resultKeys[index])) return false;
    this.invalidate({ reason: 'Collection demand changed' });
    for (const key of new Set([...previous, ...resultKeys])) {
      if (previous.includes(key) !== resultKeys.includes(key)) this.snapshotStore.reset(key, resultKeys.includes(key) ? 'loading' : 'disabled');
    }
    this.resultKeys = resultKeys;
    this.enabled = resultKeys.length > 0;
    this.collector.setKeys?.(resultKeys);
    this.requestReset();
    this.markDue();
    return true;
  }

  reportFailure(error, attemptedAt = this.clock()) {
    for (const key of this.resultKeys) {
      this.snapshotStore.fail(key, error, attemptedAt, error && error.code === 'ENOENT');
      this.onStatusChange(key, this.snapshotStore.read()[key].status, error);
    }
  }
  isDue() { return this.elapsedCycles >= this.cadenceCycles; }
  invalidate({ abortRunning = true, reason = 'Collection disposed' } = {}) {
    this.generation += 1;
    const error = new Error(reason);
    if (this.dispatchController) this.dispatchController.abort(error);
    if (abortRunning && this.controller) this.controller.abort(error);
  }

  async whenIdle() {
    if (!this.isRunning) return;
    await this.execution;
    if (!this.collectionSettled) throw Object.assign(new Error(`${this.key} previous collection is still running`), { code: 'EBUSY' });
    await this.idle;
  }

  startIfDue() {
    if (!this.enabled || this.isRunning || !this.isDue()) return false;
    this.run();
    return true;
  }

  run(attemptedAt = this.clock()) {
    if (!this.enabled) return Promise.resolve();
    if (this.isRunning) return this.execution;
    if (this.resetOnNextRun) {
      this.collector.reset?.();
      this.resetOnNextRun = false;
    }
    this.isRunning = true;
    this.collectionSettled = true;
    this.pendingCollection = Promise.resolve();
    this.execution = this.collect(attemptedAt);
    this.idle = Promise.allSettled([this.execution, this.pendingCollection]).then(() => {
      this.isRunning = false;
    });
    return this.execution;
  }

  async collect(attemptedAt) {
    this.elapsedCycles = 0;
    for (const key of this.resultKeys) this.snapshotStore.markAttempted(key, attemptedAt);
    const generation = this.generation;
    const controller = new AbortController();
    const dispatchController = new AbortController();
    this.controller = controller;
    this.dispatchController = dispatchController;
    let timeoutId;
    let collection;
    let partial;
    try {
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          const error = timeoutError(`${this.key} collection timed out`);
          controller.abort(error);
          reject(error);
        }, this.timeoutMilliseconds);
      });
      collection = Promise.resolve(withCollectionContext({ signal: controller.signal, dispatchSignal: dispatchController.signal,
        deadline: Date.now() + this.timeoutMilliseconds }, () => collectReadyValue(this.collector, controller.signal, value => { partial = value; })));
      // Keep the slot until non-cancellable work and snapshot publication settle.
      this.collectionSettled = false;
      this.pendingCollection = collection.finally(() => { this.collectionSettled = true; });
      const result = await Promise.race([collection, timeoutPromise]);
      if (generation !== this.generation) return;
      this.commit(result);
    } catch (error) {
      if (generation !== this.generation) return;
      if (controller.signal.aborted && controller.signal.reason) error = controller.signal.reason;
      if (partial?.failureCode) {
        const collectionErrors = [...partial.value.collectionErrors || [], { code: partial.failureCode, message: error.message }];
        this.commit({ ...partial.value, collectionErrors }, error);
        return;
      }
      if (partial) this.commit(partial.value);
      this.reportFailure(error, attemptedAt);
    } finally {
      clearTimeout(timeoutId);
      if (this.controller === controller) this.controller = null;
      if (this.dispatchController === dispatchController) this.dispatchController = null;
      if (generation === this.generation) this.onSettled(this.key);
    }
  }

  commit(result, error) {
    const now = this.clock();
    for (const key of this.resultKeys) {
      const value = this.grouped ? result[key] : result;
      this.snapshotStore.commit(key, value, value?.sampledAt ?? now);
      this.onStatusChange(key, 'fresh', error);
    }
  }
}

module.exports = { CollectorRunner };
