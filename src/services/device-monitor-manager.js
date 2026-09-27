'use strict';

const { MonitorSession } = require('./monitor-session');
const { SshTransport } = require('../ssh/ssh-transport');
const { RemoteSystemInfo } = require('../ssh/remote-system-info');

class DeviceMonitorManager {
  constructor({ configStore, language, localLinux, configFile = null, onUpdate = () => {}, onLog = () => {},
    onResidualProcesses = () => {}, onPauseChange = () => {} }) {
    Object.assign(this, { configStore, language, localLinux, configFile, onUpdate, onLog, onResidualProcesses, onPauseChange });
    this.devices = new Map();
    this.visibleIds = new Set();
    this.preparingIds = new Set();
    this.paused = false;
    if (localLinux) this.open('local');
  }

  open(id) {
    if (this.devices.has(id)) return this.devices.get(id);
    const remote = id !== 'local';
    const host = remote ? id.slice(4) : null;
    const transport = remote ? new SshTransport({ host, configFile: this.configFile,
      onLog: (message) => this.onLog(id + ': ' + message),
      onResidualProcesses: (pids, acknowledge) => {
        this.setPaused(true);
        return this.onResidualProcesses(host, pids, acknowledge);
      },
      shouldReconnect: () => {
        const device = this.devices.get(id);
        return !!device && !this.paused && device.running;
      },
    }) : null;
    const device = new MonitorSession({
      id, host, transport, configStore: this.configStore, language: this.language,
      isPaused: () => this.paused,
      onUpdate: (session) => this.onUpdate(id, session),
      onLog: (message) => this.onLog(id + ': ' + message),
      serviceOptions: {
        isSsh: remote, sshClientIp: '',
        ...(remote ? {
          commandRunner: transport, fileReader: transport,
          sshConnectionInfo: () => transport.sshConnections,
          systemInfo: new RemoteSystemInfo({ fileReader: transport, commandRunner: transport }),
        } : {}),
      },
    });
    this.devices.set(id, device);
    if (this.shouldRun(id)) device.start();
    return device;
  }

  sync(openIds, visibleIds = []) {
    this.visibleIds = new Set(visibleIds);
    const wanted = new Set([...openIds, ...this.preparingIds]);
    if (this.localLinux) wanted.add('local');
    for (const id of wanted) if (id === 'local' || id.startsWith('ssh:')) this.open(id);
    for (const [id, device] of this.devices) {
      if (!wanted.has(id)) { device.dispose(); this.devices.delete(id); }
    }
    this.applyVisibility();
  }

  shouldRun(id) {
    return !this.paused && (id === 'local' || !this.configStore.getCurrent().servers.visibleOnly
      || this.visibleIds.has(id) || this.preparingIds.has(id));
  }

  applyVisibility() {
    for (const [id, device] of this.devices) {
      const shouldRun = this.shouldRun(id);
      if (shouldRun && !device.running) device.resume();
      if (!shouldRun && device.running) device.pause();
    }
  }

  setPaused(paused) {
    const changed = this.paused !== paused;
    this.paused = paused;
    this.applyVisibility();
    if (changed) this.onPauseChange(paused);
  }
  setPreparing(id, preparing) {
    if (preparing) this.preparingIds.add(id);
    else this.preparingIds.delete(id);
    this.applyVisibility();
  }
  updateConfig() {
    for (const device of this.devices.values()) device.updateConfig();
    this.applyVisibility();
  }
  setConfigFile(configFile) {
    if (configFile === this.configFile) return;
    this.configFile = configFile;
    const remoteIds = [...this.devices.keys()].filter((id) => id !== 'local');
    for (const id of remoteIds) {
      this.devices.get(id).dispose();
      this.devices.delete(id);
      this.open(id);
    }
    this.applyVisibility();
  }
  get(id) { return this.devices.get(id) || null; }
  dispose() {
    for (const device of this.devices.values()) device.dispose();
    this.devices.clear();
    this.preparingIds.clear();
  }
}

module.exports = { DeviceMonitorManager };
