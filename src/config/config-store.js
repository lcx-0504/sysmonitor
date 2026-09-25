'use strict';

const { normalizeConfig } = require('./normalize-config');

const CONFIGURATION_SECTION = 'sysmonitor';
const CONFIGURATION_KEYS = Object.freeze(['refreshInterval', 'statusBar', 'disk', 'display', 'servers']);

class ConfigStore {
  constructor({ vscode, onError = () => {}, flushDelayMilliseconds = 500 }) {
    this.vscode = vscode;
    this.onError = onError;
    this.flushDelayMilliseconds = flushDelayMilliseconds;
    this.current = null;
    this.dirtyKeys = new Set();
    this.flushTimer = null;
    this.isWriting = false;
    this.flushPromise = null;
  }

  read() {
    const configuration = this.vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
    const rawConfig = {};
    for (const key of CONFIGURATION_KEYS) {
      rawConfig[key] = this.current && this.dirtyKeys.has(key) ? this.current[key] : configuration.get(key);
    }
    this.current = normalizeConfig(rawConfig);
    return this.current;
  }

  getCurrent() {
    return this.current || this.read();
  }

  refresh() {
    return this.read();
  }

  update(key, value) {
    if (!CONFIGURATION_KEYS.includes(key)) throw new Error(`Unknown sysmonitor configuration key: ${key}`);
    const nextConfig = normalizeConfig({ ...this.getCurrent(), [key]: value });
    this.current = nextConfig;
    this.dirtyKeys.add(key);
    this.scheduleFlush();
    return this.current;
  }

  scheduleFlush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.flushPromise) return;
    this.flushTimer = setTimeout(() => {
      this.flush().catch((error) => this.onError(error));
    }, this.flushDelayMilliseconds);
  }

  flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.flushPromise) return this.flushPromise;
    if (this.dirtyKeys.size === 0) return Promise.resolve();
    this.isWriting = true;
    this.flushPromise = this.writePending().finally(() => {
      this.isWriting = false;
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  async writePending() {
    const configuration = this.vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
    while (this.dirtyKeys.size > 0) {
      const keys = [...this.dirtyKeys];
      const values = this.current;
      this.dirtyKeys.clear();
      const results = await Promise.allSettled(keys.map((key) => Promise.resolve().then(() => configuration.update(key, values[key], true))));
      const failures = results.filter((result, index) => {
        if (result.status !== 'rejected') return false;
        this.dirtyKeys.add(keys[index]);
        return true;
      });
      if (failures.length) throw failures[0].reason;
    }
  }

  dispose() {
    if (this.dirtyKeys.size > 0) this.flush().catch((error) => this.onError(error));
    else if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }
}

module.exports = { CONFIGURATION_KEYS, ConfigStore };
