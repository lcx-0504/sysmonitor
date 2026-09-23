'use strict';

const { normalizeConfig } = require('./normalize-config');

const CONFIGURATION_SECTION = 'sysmonitor';
const CONFIGURATION_KEYS = Object.freeze(['refreshInterval', 'statusBar', 'disk', 'display']);

class ConfigStore {
  constructor({ vscode, onError = () => {}, flushDelayMilliseconds = 500 }) {
    this.vscode = vscode;
    this.onError = onError;
    this.flushDelayMilliseconds = flushDelayMilliseconds;
    this.current = null;
    this.dirtyKeys = new Set();
    this.flushTimer = null;
    this.isWriting = false;
  }

  read() {
    const configuration = this.vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
    const rawConfig = {};
    for (const key of CONFIGURATION_KEYS) rawConfig[key] = configuration.get(key);
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
    this.flushTimer = setTimeout(() => {
      this.flush().catch((error) => this.onError(error));
    }, this.flushDelayMilliseconds);
  }

  async flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.dirtyKeys.size === 0) return;

    const keys = [...this.dirtyKeys];
    this.dirtyKeys.clear();
    const configuration = this.vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
    this.isWriting = true;

    try {
      await Promise.all(keys.map((key) => configuration.update(key, this.current[key], true)));
    } catch (error) {
      for (const key of keys) this.dirtyKeys.add(key);
      throw error;
    } finally {
      this.isWriting = false;
    }
  }

  dispose() {
    if (this.dirtyKeys.size > 0) this.flush().catch((error) => this.onError(error));
    else if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }
}

module.exports = { CONFIGURATION_KEYS, ConfigStore };
