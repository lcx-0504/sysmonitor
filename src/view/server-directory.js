'use strict';

const path = require('node:path');
const { listSshHosts } = require('../ssh/ssh-config');
const INITIAL_SAMPLE_PARTITIONS = ['cpu', 'memory', 'diskIo', 'diskTopology', 'accelerators'];
const INITIAL_SAMPLE_TIMEOUT_MS = 45000;

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
    this.initialSampleWaiters = new Map();
    this.completedInitialSamples = new WeakSet();
    this.connectionStarts = new WeakMap();
    this.disposed = false;
  }

  notify(error = null) {
    if (this.disposed) return;
    this.onChange(error ? [] : this.rows(), error);
  }

  hasHost(host) { return this.hosts.includes(host); }

  async refresh() {
    try {
      const configured = this.vscode.workspace.getConfiguration('remote.SSH').get('configFile');
      this.manager.setConfigFile(configured || null);
      this.hosts = await this.loadHosts(configured || undefined);
      this.remoteFolders.clear();
      for (const host of this.hostErrors.keys()) this.clearHostError(host);
      this.notify();
    } catch (error) {
      this.logger(`SSH config: ${error.message}`);
      this.notify(error.message);
    }
  }

  rows() {
    return this.hosts.map((host) => {
      const device = this.manager.get('ssh:' + host);
      const pending = this.pendingHosts.get(host);
      const currentError = (this.hostErrors.get(host) || {}).message || (device && device.error) || null;
      const state = pending || (currentError ? 'disconnected' : device ? device.state : 'idle');
      const error = state === 'disconnected' ? currentError : null;
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

  initialSampleReady(device, since, { allowPausedModel = false } = {}) {
    if (!device || device.state !== 'connected' || !device.model) return false;
    const snapshot = device.service.readSnapshot();
    const latestPoint = device.history[device.history.length - 1];
    const renderedAt = allowPausedModel && typeof device.modelAt === 'number' ? device.modelAt : latestPoint && latestPoint.t;
    if (typeof renderedAt !== 'number') return false;
    return INITIAL_SAMPLE_PARTITIONS.every((key) => {
      const part = snapshot[key];
      return part && part.status === 'fresh' && typeof part.collectedAt === 'number'
        && part.collectedAt <= renderedAt && (!since || part.collectedAt >= since);
    });
  }

  hasCompletedInitialSample(device) {
    if (!device || device.state !== 'connected') return false;
    if (this.completedInitialSamples.has(device)) return true;
    if (!this.initialSampleReady(device, this.connectionStarts.get(device) || 0)) return false;
    this.completedInitialSamples.add(device);
    return true;
  }

  settleInitialSample(id, device) {
    const waiters = this.initialSampleWaiters.get(id);
    if (!waiters) return;
    const error = device && device.state === 'disconnected' ? new Error(device.error || 'SSH disconnected while loading') : null;
    for (const waiter of waiters) {
      if (!error && !this.initialSampleReady(device, waiter.since, { allowPausedModel: waiter.allowPaused })) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      if (error) waiter.reject(error);
      else {
        this.completedInitialSamples.add(device);
        waiter.resolve();
      }
    }
    if (waiters.size === 0) this.initialSampleWaiters.delete(id);
  }

  waitForInitialSample(host, since, { allowPaused = false } = {}) {
    const id = 'ssh:' + host;
    if (this.initialSampleReady(this.manager.get(id), since, { allowPausedModel: allowPaused })) return Promise.resolve();
    if (this.manager.paused && !allowPaused) return Promise.reject(new Error('Resume monitoring to load this server'));
    return new Promise((resolve, reject) => {
      const waiter = { since, allowPaused, resolve, reject, timer: null };
      let waiters = this.initialSampleWaiters.get(id);
      if (!waiters) { waiters = new Set(); this.initialSampleWaiters.set(id, waiters); }
      waiters.add(waiter);
      waiter.timer = setTimeout(() => {
        if (!waiters.has(waiter)) return;
        waiters.delete(waiter);
        if (waiters.size === 0) this.initialSampleWaiters.delete(id);
        reject(new Error('Timed out waiting for CPU, memory, disk and GPU data'));
      }, INITIAL_SAMPLE_TIMEOUT_MS);
      this.settleInitialSample(id, this.manager.get(id));
    });
  }

  async runAction(host, kind, action) {
    if (this.disposed) return;
    const id = 'ssh:' + host;
    const monitorAction = kind === 'monitor';
    const actionKey = `${kind}\0${host}`;
    if (monitorAction ? this.pendingHosts.has(host) : this.pendingActions.has(actionKey)) return;
    const previous = monitorAction ? this.manager.get(id) : null;
    const ready = monitorAction && this.hasCompletedInitialSample(previous);
    const needsNewSample = !previous || previous.state !== 'connected' || (!this.manager.paused && previous.service.scheduler && previous.service.scheduler.isPaused);
    const sampleAfter = monitorAction && !ready ? Math.max(needsNewSample ? Date.now() : 0, previous ? this.connectionStarts.get(previous) || 0 : 0) : 0;
    const hadHostError = monitorAction && this.hostErrors.has(host);
    if (monitorAction && !ready) {
      this.pendingHosts.set(host, previous && previous.state === 'connected' ? 'loading' : 'connecting');
      this.manager.setPreparing(id, true);
    } else if (!monitorAction) this.pendingActions.add(actionKey);
    if (monitorAction) this.clearHostError(host);
    if (monitorAction && !ready) this.notify();
    let failed = false;
    try {
      if (monitorAction && !ready && (!previous || previous.state !== 'connected')) {
        await this.connect(host);
      }
      if (monitorAction && !ready) {
        if (this.pendingHosts.get(host) !== 'loading') {
          this.pendingHosts.set(host, 'loading');
          this.notify();
        }
        await this.waitForInitialSample(host, sampleAfter);
      }
      await action();
      if (monitorAction) this.clearHostError(host);
    } catch (error) {
      failed = true;
      if (!this.disposed) {
        const message = error && error.message ? error.message : String(error);
        if (monitorAction) this.setHostError(host, message);
        else if (this.vscode.window && this.vscode.window.showErrorMessage) this.vscode.window.showErrorMessage(message);
        this.logger(`SSH ${host}: ${message}`);
      }
    } finally {
      if (monitorAction && !ready) this.manager.setPreparing(id, false);
      if (monitorAction && failed && !this.disposed) this.onActionError();
      if (monitorAction) {
        this.pendingHosts.delete(host);
        if (!ready || failed || hadHostError) this.notify();
      } else {
        this.pendingActions.delete(actionKey);
      }
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
    if (device.state === 'connecting' || device.state === 'disconnected') {
      this.completedInitialSamples.delete(device);
      this.connectionStarts.set(device, Date.now());
    } else if (device.state === 'connected') this.hasCompletedInitialSample(device);
    this.settleInitialSample(id, device);
    if (device.state === 'connected' && device.host && this.lastStatuses.get(id) !== 'connected:') this.clearHostError(device.host);
    const signature = `${device.state}:${device.error || ''}`;
    if (this.lastStatuses.get(id) !== signature || (device.host && device.state === 'connected')) {
      this.lastStatuses.set(id, signature);
      this.notify();
    }
  }

  dispose() {
    this.disposed = true;
    for (const waiters of this.initialSampleWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('Server directory disposed'));
      }
    }
    this.initialSampleWaiters.clear();
    for (const timer of this.hostErrorTimers.values()) this.cancelErrorClear(timer);
    this.hostErrorTimers.clear();
    this.hostErrors.clear();
    this.pendingActions.clear();
  }
}

module.exports = { ServerDirectory };
