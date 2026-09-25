'use strict';

const { MonitorService } = require('./monitor-service');
const { buildMonitorViewModel } = require('./monitor-view-model');
const { SshTransport } = require('../ssh/ssh-transport');
const { RemoteSystemInfo } = require('../ssh/remote-system-info');
const HISTORY_RESUME_PARTITIONS = ['cpu', 'memory', 'diskIo', 'diskTopology', 'accelerators'];

function updateDeviceConnection(device, state, error, time = Date.now()) {
  if ((state === 'connecting' || state === 'disconnected') && device.history.length) device.resumeHistoryAfter = time;
  if (state === 'connected' && device.resumeHistoryAfter !== null) device.resumeHistoryAfter = time;
  device.state = state;
  device.error = error ? error.message : null;
}

function canRecordDeviceSample(device, snapshot, remote) {
  if (!remote) return true;
  if (device.state !== 'connected') return false;
  if (device.resumeHistoryAfter === null) return true;
  const ready = HISTORY_RESUME_PARTITIONS.every((key) => {
    const part = snapshot[key];
    return part && part.status === 'fresh' && typeof part.collectedAt === 'number'
      && part.collectedAt >= device.resumeHistoryAfter;
  });
  if (ready) device.resumeHistoryAfter = null;
  return ready;
}

function deviceHistoryPoint(model, time = Date.now()) {
  const performance = model.performance;
  return {
    t: time,
    cpu: performance.cpu.usagePercent,
    ram: performance.memory.usagePercent,
    netTx: performance.network.transmitBytesPerSecond,
    netRx: performance.network.receiveBytesPerSecond,
    diskR: performance.diskIo.readBytesPerSecond,
    diskW: performance.diskIo.writeBytesPerSecond,
    sshTx: performance.sshTraffic.uploadBytesPerSecond || 0,
    sshRx: performance.sshTraffic.downloadBytesPerSecond || 0,
    gpus: performance.gpus.map((gpu) => ({ idx: gpu.idx, util: gpu.util })),
  };
}

class DeviceMonitorManager {
  constructor({ configStore, language, localLinux, configFile = null, onUpdate = () => {}, onLog = () => {} }) {
    this.configStore = configStore;
    this.language = language;
    this.localLinux = localLinux;
    this.configFile = configFile;
    this.onUpdate = onUpdate;
    this.onLog = onLog;
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
    let transport = null;
    let systemInfo = null;
    if (remote) {
      transport = new SshTransport({ host, configFile: this.configFile,
        shouldReconnect: () => {
          const device = this.devices.get(id);
          return !!device && !this.paused && !device.service.scheduler.isPaused;
        },
        onState: (state, error) => {
        const device = this.devices.get(id);
        if (device) {
          updateDeviceConnection(device, state, error);
          this.onUpdate(id, device);
        }
        } });
      systemInfo = new RemoteSystemInfo({ fileReader: transport, commandRunner: transport });
    }
    const device = { id, host, transport, state: remote ? 'connecting' : 'connected', error: null, model: null, modelAt: null, history: [], resumeHistoryAfter: null, service: null };
    const service = new MonitorService({
      runtimeConfig: this.configStore.getCurrent(),
      isSsh: remote,
      sshClientIp: '',
      sshConnectionInfo: remote ? () => transport.sshConnection : null,
      ...(remote ? { commandRunner: transport, fileReader: transport, systemInfo } : {}),
      onLog: (message) => this.onLog(`${id}: ${message}`),
      onTick: (snapshot) => {
        if (!canRecordDeviceSample(device, snapshot, remote)) return;
        device.model = buildMonitorViewModel(snapshot, this.language, this.configStore.getCurrent().disk);
        const now = Date.now();
        device.modelAt = now;
        if (this.paused) { this.onUpdate(id, device); return; }
        device.history.push(deviceHistoryPoint(device.model, now));
        const cutoff = now - this.configStore.getCurrent().display.sparkMinutes * 60000 - 60000;
        while (device.history.length > 2 && device.history[1].t < cutoff) device.history.shift();
        this.onUpdate(id, device);
      },
    });
    device.service = service;
    this.devices.set(id, device);
    const shouldRun = !this.paused && (id === 'local' || !this.configStore.getCurrent().servers.visibleOnly || this.visibleIds.has(id) || this.preparingIds.has(id));
    if (shouldRun) service.start();
    else service.pause();
    return device;
  }

  sync(openIds, visibleIds = []) {
    this.visibleIds = new Set(visibleIds);
    const wanted = new Set(openIds);
    for (const id of this.preparingIds) wanted.add(id);
    if (this.localLinux) wanted.add('local');
    for (const id of wanted) if (id === 'local' || id.startsWith('ssh:')) this.open(id);
    for (const [id, device] of this.devices) {
      if (!wanted.has(id)) { device.service.dispose(); this.devices.delete(id); }
    }
    this.applyVisibility();
  }

  applyVisibility() {
    const visibleOnly = this.configStore.getCurrent().servers.visibleOnly;
    for (const [id, device] of this.devices) {
      const shouldRun = !this.paused && (id === 'local' || !visibleOnly || this.visibleIds.has(id) || this.preparingIds.has(id));
      if (shouldRun && device.service.scheduler.isPaused) device.service.resume();
      if (!shouldRun && !device.service.scheduler.isPaused) device.service.pause();
    }
  }

  setPaused(paused) { this.paused = paused; this.applyVisibility(); }
  setPreparing(id, preparing) {
    if (preparing) this.preparingIds.add(id);
    else this.preparingIds.delete(id);
    this.applyVisibility();
  }
  updateConfig() {
    for (const device of this.devices.values()) device.service.updateConfig(this.configStore.getCurrent());
    this.applyVisibility();
  }
  setConfigFile(configFile) {
    if (configFile === this.configFile) return;
    this.configFile = configFile;
    const remoteIds = [...this.devices.keys()].filter((id) => id !== 'local');
    for (const id of remoteIds) {
      this.devices.get(id).service.dispose();
      this.devices.delete(id);
      this.open(id);
    }
    this.applyVisibility();
  }
  get(id) { return this.devices.get(id) || null; }
  dispose() {
    for (const device of this.devices.values()) device.service.dispose();
    this.devices.clear();
    this.preparingIds.clear();
  }
}

module.exports = { DeviceMonitorManager, deviceHistoryPoint, updateDeviceConnection, canRecordDeviceSample };
