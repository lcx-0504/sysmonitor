'use strict';
const { withCollectionContext, timeoutError } = require('./collection-context');

class CollectorRunner {
  constructor({ key, collector, snapshotStore, cadenceMilliseconds, timeoutMilliseconds, clock = () => Date.now(), onStatusChange = () => {}, onSettled = () => {} }) {
    this.key = key;
    this.collector = collector;
    this.snapshotStore = snapshotStore;
    this.cadenceMilliseconds = cadenceMilliseconds;
    this.timeoutMilliseconds = timeoutMilliseconds;
    this.clock = clock;
    this.onStatusChange = onStatusChange;
    this.onSettled = onSettled;
    this.controller = null;
    this.dispatchController = null;
    this.idle = Promise.resolve();
    this.isRunning = false;
    this.nextDueAt = 0;
    this.generation = 0;
  }

  setCadence(cadenceMilliseconds) { this.cadenceMilliseconds = cadenceMilliseconds; }
  isDue(now) { return now >= this.nextDueAt; }
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

  startIfDue(now = this.clock()) {
    if (this.isRunning || !this.isDue(now)) return false;
    this.run(now);
    return true;
  }

  run(attemptedAt = this.clock()) {
    if (this.isRunning) return this.execution;
    this.isRunning = true;
    this.collectionSettled = true;
    this.pendingCollection = Promise.resolve();
    this.execution = this.collect(attemptedAt);
    this.idle = Promise.allSettled([this.execution, this.pendingCollection]).then(() => { this.isRunning = false; });
    return this.execution;
  }

  async collect(attemptedAt) {
    this.nextDueAt = attemptedAt + this.cadenceMilliseconds;
    this.snapshotStore.markAttempted(this.key, attemptedAt);
    const generation = this.generation;
    const controller = new AbortController();
    const dispatchController = new AbortController();
    this.controller = controller;
    this.dispatchController = dispatchController;
    let timeoutId;
    let collection;
    try {
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          const error = timeoutError(`${this.key} collection timed out`);
          controller.abort(error);
          reject(error);
        }, this.timeoutMilliseconds);
      });
      collection = Promise.resolve(withCollectionContext({ signal: controller.signal, dispatchSignal: dispatchController.signal,
        deadline: Date.now() + this.timeoutMilliseconds }, () => this.collector.collect()));
      // Keep the slot until non-cancellable work and snapshot publication settle.
      this.collectionSettled = false;
      this.pendingCollection = collection.finally(() => { this.collectionSettled = true; });
      const result = await Promise.race([collection, timeoutPromise]);
      if (generation !== this.generation) return;
      this.snapshotStore.commit(this.key, result, this.clock());
      this.onStatusChange(this.key, 'fresh');
    } catch (error) {
      if (generation !== this.generation) return;
      if (controller.signal.aborted && controller.signal.reason) error = controller.signal.reason;
      this.snapshotStore.fail(this.key, error, attemptedAt, error && error.code === 'ENOENT');
      this.onStatusChange(this.key, this.snapshotStore.read()[this.key].status, error);
    } finally {
      clearTimeout(timeoutId);
      if (this.controller === controller) this.controller = null;
      if (this.dispatchController === dispatchController) this.dispatchController = null;
      if (generation === this.generation) this.onSettled(this.key);
    }
  }
}

module.exports = { CollectorRunner };
