'use strict';

const { AcceleratorCollector } = require('../collectors/accelerator-collector');
const { ResourceCollector } = require('../collectors/resource-collector');
const { DiskTopologyCollector } = require('../collectors/disk-topology-collector');
const { ProcessCollector } = require('../collectors/process-collector');
const { SshTrafficCollector } = require('../collectors/ssh-traffic-collector');
const { NvidiaProvider } = require('../accelerators/nvidia-provider');
const { CollectorRunner } = require('../core/collector-runner');
const { CommandRunner } = require('../core/command-runner');
const { MonitorScheduler } = require('../core/monitor-scheduler');
const { SnapshotStore } = require('../core/snapshot-store');
const fs = require('node:fs/promises');
const { executionOptions } = require('../core/collection-context');
const { collectionPolicy, COLLECTION_POLICY } = require('./collection-policy');
const { diskSelectionSignature } = require('../domain/disk');
const { collectionDemand } = require('./collection-demand');
const COLLECTION_RESOURCE_KEYS = COLLECTION_POLICY.resources.resultKeys;

class MonitorService {
  constructor({ runtimeConfig, isSsh, sshClientIp, sshConnectionInfo = null, acceleratorProviders = null, commandRunner = null, resourceCommandRunner = null, fileReader = null, systemInfo = null, statusBarAvailable = true, onSnapshot = () => {}, onCollectionSettled = () => {}, onLog = () => {} }) {
    this.runtimeConfig = runtimeConfig;
    this.onSnapshot = onSnapshot;
    this.onLog = onLog;
    this.statusBarAvailable = statusBarAvailable;
    this.snapshotStore = new SnapshotStore();
    this.commandRunner = commandRunner || new CommandRunner();
    const reader = fileReader || { readFile(file, encoding) {
      const options = executionOptions();
      return fs.readFile(file, { encoding, signal: options.signal });
    } };
    const collectorInputs = { fileReader: reader, ...(systemInfo ? { systemInfo } : {}) };
    const refreshMilliseconds = runtimeConfig.refreshInterval * 1000;
    const policies = collectionPolicy(runtimeConfig);
    this.scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: refreshMilliseconds,
      onTick: () => this.onSnapshot(this.snapshotStore.read()) });
    const definitions = [
      ['resources', new ResourceCollector({ ...collectorInputs, commandRunner:resourceCommandRunner })],
      ['sshTraffic', new SshTrafficCollector({ commandRunner: this.commandRunner, isSsh, clientIp: sshClientIp, connectionInfo: sshConnectionInfo, timeoutMilliseconds: policies.sshTraffic.timeoutMilliseconds })],
      ['processes', new ProcessCollector({ commandRunner: this.commandRunner, ...collectorInputs, gpuEnabled: () => this.demand.accelerators, timeoutMilliseconds: policies.processes.timeoutMilliseconds })],
      ['accelerators', new AcceleratorCollector({ providers: acceleratorProviders || [new NvidiaProvider({ commandRunner: this.commandRunner, ...collectorInputs })] })],
      ['diskTopology', new DiskTopologyCollector({ commandRunner: this.commandRunner, fileReader: reader, getDiskConfig: () => this.runtimeConfig.disk, timeoutMilliseconds: policies.diskTopology.timeoutMilliseconds })],
    ];
    this.runners = definitions.map(([key, collector]) => {
      const policy = policies[key];
      const runner = new CollectorRunner({
        key, resultKeys:policy.resultKeys, grouped:key === 'resources', collector, snapshotStore: this.snapshotStore,
        cadenceMilliseconds: Math.max(policy.cadenceMilliseconds || 0, refreshMilliseconds),
        timeoutMilliseconds: policy.timeoutMilliseconds,
        onStatusChange: (name, status, error) => this.logStatus(name, status, error),
        onSettled: () => { if (!this.scheduler.isPaused && !this.scheduler.isCollectingOnce) onCollectionSettled(this.snapshotStore.read()); },
      });
      runner.minimumCadenceMilliseconds = policy.cadenceMilliseconds || 0;
      this.scheduler.addRunner(runner);
      return runner;
    });
    this.lastStatuses = new Map();
    this.updateDemand(runtimeConfig, false);
  }

  updateDemand(config, refresh = true) {
    const demand = collectionDemand(config, { statusBarAvailable:this.statusBarAvailable });
    this.demand = demand;
    for (const runner of this.runners) {
      const keys = runner.key === 'resources' ? COLLECTION_RESOURCE_KEYS.filter(key => demand[key]) : demand[runner.key] ? [runner.key] : [];
      this.scheduler.setRunnerDemand(runner, keys, { refresh });
    }
  }

  requiredKeys(page = 'perf') {
    return Object.keys(this.demand).filter(key => this.demand[key] && (key !== 'processes' || page === 'proc'));
  }

  logStatus(key, status, error) {
    const signature = `${status}:${error && (error.code || error.message) || ''}`;
    if (this.lastStatuses.get(key) === signature) return;
    this.lastStatuses.set(key, signature);
    this.onLog(`${key}: ${status}${error ? ` (${error.code || error.message})` : ''}`);
  }

  start() { this.scheduler.start(); }
  pause() { this.scheduler.pause(); }
  async collectOnce(options) {
    await this.scheduler.collectOnce(options);
    this.onSnapshot(this.snapshotStore.read());
  }
  resume({ force = false } = {}) {
    if (force) for (const runner of this.runners) runner.nextDueAt = 0;
    this.scheduler.resume();
  }
  updateConfig(runtimeConfig) {
    const intervalChanged = this.runtimeConfig.refreshInterval !== runtimeConfig.refreshInterval;
    const diskChanged = diskSelectionSignature(this.runtimeConfig.disk) !== diskSelectionSignature(runtimeConfig.disk);
    this.runtimeConfig = runtimeConfig;
    this.updateDemand(runtimeConfig);
    const policies = collectionPolicy(runtimeConfig);
    for (const runner of this.runners) {
      runner.timeoutMilliseconds = policies[runner.key].timeoutMilliseconds;
      runner.collector.timeoutMilliseconds = runner.timeoutMilliseconds;
    }
    if (diskChanged) this.scheduler.refreshRunner(this.runners.find((runner) => runner.key === 'diskTopology'));
    if (intervalChanged) this.scheduler.setRefreshInterval(runtimeConfig.refreshInterval * 1000);
  }
  readSnapshot() { return this.snapshotStore.read(); }
  dispose() { this.scheduler.dispose(); this.commandRunner.dispose(); }
}

module.exports = { MonitorService };
