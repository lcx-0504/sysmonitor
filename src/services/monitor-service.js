'use strict';

const { AcceleratorCollector } = require('../collectors/accelerator-collector');
const { CpuCollector } = require('../collectors/cpu-collector');
const { DiskIoCollector } = require('../collectors/disk-io-collector');
const { DiskTopologyCollector } = require('../collectors/disk-topology-collector');
const { MemoryCollector } = require('../collectors/memory-collector');
const { NetworkCollector } = require('../collectors/network-collector');
const { ProcessCollector } = require('../collectors/process-collector');
const { SshTrafficCollector } = require('../collectors/ssh-traffic-collector');
const { NvidiaProvider } = require('../accelerators/nvidia-provider');
const { CollectorRunner } = require('../core/collector-runner');
const { CommandRunner } = require('../core/command-runner');
const { MonitorScheduler } = require('../core/monitor-scheduler');
const { SnapshotStore } = require('../core/snapshot-store');
const fs = require('node:fs/promises');
const { executionOptions } = require('../core/collection-context');
const { COLLECTION_POLICY } = require('./collection-policy');

class MonitorService {
  constructor({ runtimeConfig, isSsh, sshClientIp, sshConnectionInfo = null, acceleratorProviders = null, commandRunner = null, fileReader = null, systemInfo = null, onSnapshot = () => {}, onLog = () => {} }) {
    this.runtimeConfig = runtimeConfig;
    this.onSnapshot = onSnapshot;
    this.onLog = onLog;
    this.snapshotStore = new SnapshotStore();
    this.commandRunner = commandRunner || new CommandRunner();
    const reader = fileReader || { readFile(file, encoding) {
      const options = executionOptions();
      return fs.readFile(file, { encoding, signal: options.signal });
    } };
    const collectorInputs = { fileReader: reader, ...(systemInfo ? { systemInfo } : {}) };
    const refreshMilliseconds = runtimeConfig.refreshInterval * 1000;
    this.scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: refreshMilliseconds, onTick: () => {} });
    const definitions = [
      ['cpu', new CpuCollector(collectorInputs)],
      ['memory', new MemoryCollector(collectorInputs)],
      ['network', new NetworkCollector(collectorInputs)],
      ['diskIo', new DiskIoCollector(collectorInputs)],
      ['sshTraffic', new SshTrafficCollector({ commandRunner: this.commandRunner, isSsh, clientIp: sshClientIp, connectionInfo: sshConnectionInfo, timeoutMilliseconds: COLLECTION_POLICY.sshTraffic.timeoutMilliseconds })],
      ['processes', new ProcessCollector({ commandRunner: this.commandRunner, ...collectorInputs, timeoutMilliseconds: COLLECTION_POLICY.processes.timeoutMilliseconds })],
      ['accelerators', new AcceleratorCollector({ providers: acceleratorProviders || [new NvidiaProvider({ commandRunner: this.commandRunner, ...collectorInputs })] })],
      ['diskTopology', new DiskTopologyCollector({ commandRunner: this.commandRunner, getDiskConfig: () => this.runtimeConfig.disk })],
    ];
    this.runners = definitions.map(([key, collector]) => {
      const policy = COLLECTION_POLICY[key];
      const runner = new CollectorRunner({
        key, collector, snapshotStore: this.snapshotStore,
        cadenceMilliseconds: policy.cadenceMilliseconds || refreshMilliseconds,
        timeoutMilliseconds: policy.timeoutMilliseconds,
        onStatusChange: (name, status, error) => this.logStatus(name, status, error),
        onSettled: () => { if (!this.scheduler.isPaused) this.onSnapshot(this.snapshotStore.read()); },
      });
      runner.cadenceSource = key === 'diskTopology' ? 'fixed' : 'refreshInterval';
      this.scheduler.addRunner(runner);
      return runner;
    });
    this.lastStatuses = new Map();
  }

  logStatus(key, status, error) {
    const signature = `${status}:${error && (error.code || error.message) || ''}`;
    if (this.lastStatuses.get(key) === signature) return;
    this.lastStatuses.set(key, signature);
    this.onLog(`${key}: ${status}${error ? ` (${error.code || error.message})` : ''}`);
  }

  start() { this.scheduler.start(); }
  pause() { this.scheduler.pause(); }
  resume({ force = false } = {}) {
    if (force) for (const runner of this.runners) runner.nextDueAt = 0;
    this.scheduler.resume();
  }
  updateConfig(runtimeConfig) {
    const intervalChanged = this.runtimeConfig.refreshInterval !== runtimeConfig.refreshInterval;
    this.runtimeConfig = runtimeConfig;
    if (intervalChanged) this.scheduler.setRefreshInterval(runtimeConfig.refreshInterval * 1000);
  }
  readSnapshot() { return this.snapshotStore.read(); }
  dispose() { this.scheduler.dispose(); this.commandRunner.dispose(); }
}

module.exports = { MonitorService };
