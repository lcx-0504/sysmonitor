'use strict';

const { isDeepStrictEqual } = require('node:util');
const { normalizeConfig } = require('./normalize-config');
const { upgradeConfiguration, upgradeSetting } = require('./upgrade-config');
const { settingSchema } = require('./config-schema');

const CONFIGURATION_SECTION = 'sysmonitor';
const CONFIGURATION_KEYS = Object.freeze(['refreshInterval', 'timeouts', 'statusBar', 'disk', 'display', 'servers']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => Array.isArray(value) ? value.map(clone) : isObject(value) ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) : value;
function changesBetween(before, after, path = []) {
  if (isDeepStrictEqual(before, after)) return [];
  if (isObject(before) || isObject(after)) return [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
    .flatMap(key => changesBetween(Object.hasOwn(before || {}, key) ? before[key] : undefined, Object.hasOwn(after || {}, key) ? after[key] : undefined, [...path, key]));
  return [{ path, value: after }];
}
function applyChanges(value, changes) {
  let result = clone(value);
  for (const change of changes) {
    if (!change.path.length) { result = clone(change.value); continue; }
    if (!isObject(result)) result = {};
    let target = result;
    for (const key of change.path.slice(0, -1)) {
      if (!Object.hasOwn(target, key) || !isObject(target[key])) Object.defineProperty(target, key, { value: {}, writable: true, enumerable: true, configurable: true });
      target = target[key];
    }
    const key = change.path.at(-1);
    if (change.value === undefined) delete target[key];
    else Object.defineProperty(target, key, { value: clone(change.value), writable: true, enumerable: true, configurable: true });
  }
  return result;
}

class ConfigStore {
  constructor({ vscode, onError = () => {}, onUpgradeError = onError }) {
    Object.assign(this, { vscode, onError, onUpgradeError });
    this.current = null;
    this.pending = new Map();
    this.inFlight = new Map();
    this.listeners = new Set();
    this.saveListeners = new Set();
    this.saveState = { status: 'saved', error: null };
    this.revision = 0;
    this.flushPromise = null;
  }

  get dirtyKeys() { return new Set(this.pending.keys()); }
  get isWriting() { return this.flushPromise !== null; }
  raw(configuration, key) {
    const value = configuration.inspect(key)?.globalValue;
    return upgradeSetting(key, value) || value;
  }
  queue(key, changes) {
    if (!this.pending.has(key)) this.pending.set(key, new Map());
    for (const change of changes) this.pending.get(key).set(JSON.stringify(change.path), { ...clone(change), revision: ++this.revision });
  }

  read() {
    const configuration = this.vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
    const rawConfig = {};
    for (const key of CONFIGURATION_KEYS) {
      const raw = this.raw(configuration, key);
      const active = this.inFlight.get(key);
      if (active && !isDeepStrictEqual(raw, active.baseline) && !isDeepStrictEqual(raw, active.value) && !isDeepStrictEqual(raw, active.observed)) {
        const localPaths = [...(this.pending.get(key)?.values() || [])].filter(change => change.local !== false).map(change => JSON.stringify(change.path));
        const external = changesBetween(active.observed, raw).filter(change => !localPaths.includes(JSON.stringify(change.path))).map(change => ({ ...change, local: false }));
        if (external.length) this.queue(key, external);
        active.observed = clone(raw);
      }
      rawConfig[key] = applyChanges(raw, this.pending.get(key)?.values() || []);
    }
    this.current = normalizeConfig(rawConfig);
    return this.current;
  }

  getCurrent() {
    return this.current || this.read();
  }
  getSaveState() { return this.saveState; }
  setSaveState(status, error = null) {
    const next = { status, error: error ? error.message || String(error) : null };
    if (isDeepStrictEqual(next, this.saveState)) return;
    this.saveState = next;
    for (const listener of this.saveListeners) listener(next);
  }

  async upgrade() {
    this.read();
    try { await upgradeConfiguration(this.vscode); }
    catch (error) { this.onUpgradeError(error); }
    return this.refresh();
  }

  refresh() {
    const previous = this.current;
    const current = this.read();
    if (!isDeepStrictEqual(current, previous)) for (const listener of this.listeners) listener(current);
    return current;
  }

  onDidChange(listener) { this.listeners.add(listener); return { dispose:() => this.listeners.delete(listener) }; }
  onDidChangeSaveState(listener) { this.saveListeners.add(listener); return { dispose: () => this.saveListeners.delete(listener) }; }

  update(key, changes) {
    if (!CONFIGURATION_KEYS.includes(key) || !Array.isArray(changes) || changes.some(change => !change || !Array.isArray(change.path) || !settingSchema(key, change.path) || settingSchema(key, change.path).type === 'object')) throw new Error('Invalid configuration changes');
    if (!changes.length) return this.getCurrent();
    this.refresh();
    const next = normalizeConfig({ ...this.current, [key]: applyChanges(this.current[key], changes) });
    this.queue(key, changes.map(change => ({ path: change.path, value: change.path.reduce((value, segment) => value?.[segment], next[key]), local: true })));
    this.refresh();
    this.setSaveState('saving');
    queueMicrotask(() => { if (!this.flushPromise && this.pending.size) this.flush().catch(() => {}); });
    return this.current;
  }

  flush() {
    if (this.flushPromise) return this.flushPromise;
    if (!this.pending.size) return Promise.resolve();
    this.setSaveState('saving');
    this.flushPromise = this.writePending().then(() => this.setSaveState('saved'), error => {
      this.setSaveState('error', error); this.onError(error); throw error;
    }).finally(() => {
      this.flushPromise = null;
      this.refresh();
    });
    return this.flushPromise;
  }

  async writePending() {
    const configuration = this.vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
    while (this.pending.size) {
      this.refresh();
      const batch = [...this.pending].map(([key, values]) => {
        const changes = [...values.values()];
        const baseline = this.raw(configuration, key);
        const value = applyChanges(baseline, changes);
        this.inFlight.set(key, { baseline, observed: clone(baseline), value });
        return { key, changes, value };
      });
      const results = await Promise.allSettled(batch.map(({ key, value }) => Promise.resolve().then(() => configuration.update(key, value, true))));
      this.refresh();
      for (let index = 0; index < batch.length; index++) {
        const { key, changes } = batch[index];
        this.inFlight.delete(key);
        if (results[index].status === 'rejected') continue;
        const pending = this.pending.get(key);
        for (const change of changes) if (pending.get(JSON.stringify(change.path))?.revision === change.revision) pending.delete(JSON.stringify(change.path));
        if (!pending.size) this.pending.delete(key);
      }
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    }
  }

  dispose() {
    if (this.pending.size) this.flush().catch(() => {});
  }
}

module.exports = { CONFIGURATION_KEYS, ConfigStore };
