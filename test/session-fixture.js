'use strict';

const { MonitorSession } = require('../src/services/monitor-session');
const { SnapshotStore } = require('../src/core/snapshot-store');
const { normalizeConfig } = require('../src/config/normalize-config');

function createSessionFixture({ id = 'local', remote = false, paused = false, onUpdate = () => {}, service = {}, configStore = { getCurrent: () => normalizeConfig({}) } } = {}) {
  const store = new SnapshotStore();
  let publish;
  const transport = remote ? {
    onState() {},
    async connect() { this.onState('connected'); },
    async retryNow() { return this.connect(); },
    dispose() {},
  } : null;
  const session = new MonitorSession({ id, host: remote ? id.slice(4) : null, transport, configStore,
    language: 'en', onUpdate,
    createService(options) {
      publish = () => options.onSnapshot(store.read());
      return {
        scheduler: { isPaused: true },
        pause() { this.scheduler.isPaused = true; },
        resume() { this.scheduler.isPaused = false; },
        async collectOnce({ onStart = () => {} } = {}) { onStart(); },
        updateConfig() {}, dispose() {}, readSnapshot: () => store.read(), ...service,
      };
    },
  });
  session.paused = paused;
  const values = {
    cpu: { usagePercent: 12, coreCount: 4, loadAverage: { oneMinute: 1, fiveMinutes: 2, fifteenMinutes: 3 } },
    memory: { usagePercent: 20, usedBytes: 20, availableBytes: 80, totalBytes: 100 },
    diskIo: { readBytesPerSecond: 1, writeBytesPerSecond: 2 },
    diskTopology: [], accelerators: { devices: [], usagesByPid: new Map(), currentUserDeviceKeys: [] },
    processes: [],
  };
  function commit(keys = Object.keys(values), time = Date.now()) {
    for (const key of keys) store.commit(key, values[key], time);
    publish();
  }
  return { session, store, commit, publish, transport, values };
}

module.exports = { createSessionFixture };
