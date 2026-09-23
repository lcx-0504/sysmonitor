'use strict';

class CollectorRunner {
  constructor({ key, collector, snapshotStore, cadenceMilliseconds, timeoutMilliseconds, clock = () => Date.now(), onStatusChange = () => {} }) {
    this.key = key;
    this.collector = collector;
    this.snapshotStore = snapshotStore;
    this.cadenceMilliseconds = cadenceMilliseconds;
    this.timeoutMilliseconds = timeoutMilliseconds;
    this.clock = clock;
    this.onStatusChange = onStatusChange;
    this.isRunning = false;
    this.nextDueAt = 0;
    this.generation = 0;
  }

  setCadence(cadenceMilliseconds) { this.cadenceMilliseconds = cadenceMilliseconds; }
  isDue(now) { return now >= this.nextDueAt; }
  invalidate() { this.generation += 1; }

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
    let timeoutId;
    try {
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          const error = new Error(`${this.key} collection timed out`);
          error.code = 'ETIMEDOUT';
          reject(error);
        }, this.timeoutMilliseconds);
      });
      const result = await Promise.race([this.collector.collect(), timeoutPromise]);
      if (generation !== this.generation) return;
      this.snapshotStore.commit(this.key, result, this.clock());
      this.onStatusChange(this.key, 'fresh');
    } catch (error) {
      if (generation !== this.generation) return;
      this.snapshotStore.fail(this.key, error, attemptedAt, error && error.code === 'ENOENT');
      this.onStatusChange(this.key, this.snapshotStore.read()[this.key].status, error);
    } finally {
      clearTimeout(timeoutId);
      this.isRunning = false;
    }
  }
}

module.exports = { CollectorRunner };
