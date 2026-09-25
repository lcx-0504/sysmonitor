'use strict';

const path = require('node:path');
const { listSshHosts } = require('../ssh/ssh-config');

class ServerDirectory {
  constructor({ vscode, manager, loadHosts = listSshHosts, scheduleErrorClear = setTimeout, cancelErrorClear = clearTimeout, onChange = () => {}, onActionError = () => {}, logger = () => {} }) {
    this.vscode = vscode;
    this.manager = manager;
    this.loadHosts = loadHosts;
    this.scheduleErrorClear = scheduleErrorClear;
    this.cancelErrorClear = cancelErrorClear;
    this.onChange = onChange;
    this.onActionError = onActionError;
    this.logger = logger;
    this.hosts = [];
    this.lastStatuses = new Map();
    this.pendingHosts = new Map();
    this.pendingActions = new Set();
    this.hostErrors = new Map();
    this.hostErrorTimers = new Map();
    this.remoteFolders = new Map();
    this.abortController = new AbortController();
    this.disposed = false;
    this.refreshGeneration = 0;
  }

  notify(error = null) {
    if (this.disposed) return;
    this.onChange(error ? [] : this.rows(), error);
  }

  hasHost(host) { return this.hosts.includes(host); }

  async refresh() {
    if (this.disposed) return;
    const generation = ++this.refreshGeneration;
    try {
      const configured = this.vscode.workspace.getConfiguration('remote.SSH').get('configFile');
      const hosts = await this.loadHosts(configured || undefined);
      if (this.disposed || generation !== this.refreshGeneration) return;
      this.manager.setConfigFile(configured || null);
      this.hosts = hosts;
      this.remoteFolders.clear();
      for (const host of this.hostErrors.keys()) this.clearHostError(host);
      this.notify();
    } catch (error) {
      if (this.disposed || generation !== this.refreshGeneration) return;
      this.logger(`SSH config: ${error.message}`);
      this.notify(error.message);
    }
  }

  rows() {
    return this.hosts.map((host) => {
      const device = this.manager.get('ssh:' + host);
      const pending = this.pendingHosts.get(host);
      const currentError = (this.hostErrors.get(host) || {}).message || (device && (device.error || device.loadError)) || null;
      const state = pending || (currentError ? device && device.state === 'connected' ? 'error' : 'disconnected' : device ? device.state : 'idle');
      const error = state === 'disconnected' || state === 'error' ? currentError : null;
      const snapshot = device && device.service.readSnapshot();
      const metrics = [];
      if (state === 'connected' && snapshot && device.model) {
        const performance = device.model.performance;
        if (snapshot.cpu.status === 'fresh') metrics.push(`CPU ${performance.cpu.usagePercent}%`);
        if (snapshot.memory.status === 'fresh') metrics.push(`RAM ${performance.memory.usagePercent}%`);
        if (snapshot.accelerators.status === 'fresh' && performance.gpus.length) {
          metrics.push(`GPU ${performance.gpus.filter((gpu) => gpu.isIdle).length}/${performance.gpus.length}`);
        }
      }
      return { host, state, error, busy: !!pending, metrics };
    });
  }

  clearHostError(host) {
    const timer = this.hostErrorTimers.get(host);
    if (this.hostErrorTimers.has(host)) this.cancelErrorClear(timer);
    this.hostErrorTimers.delete(host);
    this.hostErrors.delete(host);
  }

  setHostError(host, message) {
    this.clearHostError(host);
    const record = { message };
    this.hostErrors.set(host, record);
    const timer = this.scheduleErrorClear(() => {
      if (this.hostErrors.get(host) !== record) return;
      this.clearHostError(host);
      this.notify();
    }, 10000);
    this.hostErrorTimers.set(host, timer);
  }

  async connect(host) {
    const id = 'ssh:' + host;
    const device = this.manager.get(id) || this.manager.open(id);
    await device.transport.connect();
  }

  hasCompletedInitialSample(device) {
    return !!device && device.hasCompletedInitialSample();
  }

  waitForInitialSample(host, since, options = {}) {
    const device = this.manager.get('ssh:' + host);
    if (!device) return Promise.reject(new Error('Monitor session closed'));
    return device.waitForInitialSample({ ...options, since, signal: this.abortController.signal });
  }

  async runMonitorAction(host, action) {
    if (this.disposed || this.pendingHosts.has(host)) return;
    const id = 'ssh:' + host;
    const previous = this.manager.get(id);
    const ready = this.hasCompletedInitialSample(previous);
    const needsNewSample = !previous || previous.state !== 'connected' || (!this.manager.paused && previous.service.scheduler && previous.service.scheduler.isPaused);
    const sampleAfter = !ready ? Math.max(needsNewSample ? Date.now() : 0, previous ? previous.requiredSince || 0 : 0) : 0;
    const hadHostError = this.hostErrors.has(host);
    if (!ready) {
      this.pendingHosts.set(host, previous && previous.state === 'connected' ? 'loading' : 'connecting');
      this.manager.setPreparing(id, true);
    }
    this.clearHostError(host);
    if (!ready) this.notify();
    let failed = false;
    try {
      if (!ready && (!previous || previous.state !== 'connected')) {
        await this.connect(host);
      }
      if (!ready) {
        if (this.pendingHosts.get(host) !== 'loading') {
          this.pendingHosts.set(host, 'loading');
          this.notify();
        }
        await this.waitForInitialSample(host, sampleAfter);
      }
      await action();
      this.clearHostError(host);
    } catch (error) {
      failed = true;
      if (!this.disposed) {
        const message = error && error.message ? error.message : String(error);
        this.setHostError(host, message);
        this.logger(`SSH ${host}: ${message}`);
      }
    } finally {
      if (!ready) this.manager.setPreparing(id, false);
      if (failed && !this.disposed) this.onActionError();
      this.pendingHosts.delete(host);
      if (!ready || failed || hadHostError) this.notify();
    }
  }

  async runShortcutAction(host, kind, action) {
    const actionKey = `${kind}\0${host}`;
    if (this.disposed || this.pendingActions.has(actionKey)) return;
    this.pendingActions.add(actionKey);
    try {
      await action();
    } catch (error) {
      if (!this.disposed) {
        const message = error && error.message ? error.message : String(error);
        if (this.vscode.window && this.vscode.window.showErrorMessage) this.vscode.window.showErrorMessage(message);
        this.logger(`SSH ${host}: ${message}`);
      }
    } finally {
      this.pendingActions.delete(actionKey);
    }
  }

  async listRemoteFolders(host) {
    try {
      const records = await this.vscode.commands.executeCommand('remote-internal.getSshFoldersHistory', host);
      if (!Array.isArray(records)) return [];
      const seen = new Set();
      return records.filter((record) => {
        if (!record || typeof record.remote !== 'string' || !record.remote || /[\0\r\n]/.test(record.remote)
          || typeof record.folder !== 'string' || !path.posix.isAbsolute(record.folder) || /[\0\r\n]/.test(record.folder)) return false;
        const key = record.remote + '\0' + record.folder;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).map(({ remote, folder }) => ({ remote, folder }));
    } catch (error) {
      this.logger(`Remote-SSH folder history: ${error.message}`);
      return [];
    }
  }

  async refreshRemoteFolders(host) {
    const folders = await this.listRemoteFolders(host);
    this.remoteFolders.set(host, folders);
    return folders.map(({ folder }, index) => ({ index, folder }));
  }

  remoteFolder(host, index) {
    return Number.isInteger(index) ? (this.remoteFolders.get(host) || [])[index] : null;
  }

  async openEmptyRemoteWindow(host) {
    try {
      await this.vscode.commands.executeCommand('opensshremotes.openEmptyWindow', { host });
    } catch (error) {
      if (!/command .*not found/i.test(error && error.message || '')) throw error;
      await this.vscode.commands.executeCommand('vscode.newWindow', { remoteAuthority: `ssh-remote+${host}`, reuseWindow: false });
    }
  }

  onDeviceUpdate(id, device) {
    if (device.state === 'connected' && device.host && this.lastStatuses.get(id) !== 'connected:') this.clearHostError(device.host);
    const signature = `${device.state}:${device.error || ''}`;
    if (this.lastStatuses.get(id) !== signature || (device.host && device.state === 'connected')) {
      this.lastStatuses.set(id, signature);
      this.notify();
    }
  }

  dispose() {
    this.disposed = true;
    this.abortController.abort(new Error('Server directory disposed'));
    for (const timer of this.hostErrorTimers.values()) this.cancelErrorClear(timer);
    this.hostErrorTimers.clear();
    this.hostErrors.clear();
    this.pendingActions.clear();
  }
}

module.exports = { ServerDirectory };
