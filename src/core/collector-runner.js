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
    this.isRunning = false;
    this.nextDueAt = 0;
    this.generation = 0;
  }

  setCadence(cadenceMilliseconds) { this.cadenceMilliseconds = cadenceMilliseconds; }
  isDue(now) { return now >= this.nextDueAt; }
  invalidate() { this.generation += 1; if (this.controller) this.controller.abort(new Error('Collection disposed')); }

  startIfDue(now = this.clock()) {
    if (this.isRunning || !this.isDue(now)) return false;
    this.run(now);
    return true;
  }

  async run(attemptedAt = this.clock()) {
    this.isRunning = true;
    this.nextDueAt = attemptedAt + this.cadenceMilliseconds;
    this.snapshotStore.markAttempted(this.key, attemptedAt);
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
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
      collection = Promise.resolve(withCollectionContext({ signal: controller.signal, deadline: Date.now() + this.timeoutMilliseconds }, () => this.collector.collect()));
      // Keep the slot until non-cancellable work has also settled.
      const release = () => { this.isRunning = false; };
      collection.then(release, release);
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
      if (!collection) this.isRunning = false;
      if (this.controller === controller) this.controller = null;
      if (generation === this.generation) this.onSettled(this.key);
    }
  }
}

module.exports = { CollectorRunner };
