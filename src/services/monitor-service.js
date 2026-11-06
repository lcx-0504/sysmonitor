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

function demandedKeys(runnerKey, demand) {
  if (runnerKey === 'resources') return COLLECTION_RESOURCE_KEYS.filter(key => demand[key]);
  return demand[runnerKey] ? [runnerKey] : [];
}

class MonitorService {
  constructor({ runtimeConfig, isSsh, sshClientIp, sshConnectionInfo = null, acceleratorProviders = null, commandRunner = null,
    fileReader = null, systemInfo = null, statusBarAvailable = true, onSnapshot = () => {}, onCollectionSettled = () => {}, onLog = () => {} }) {
    this.runtimeConfig = runtimeConfig;
    this.onSnapshot = onSnapshot;
    this.onLog = onLog;
    this.statusBarAvailable = statusBarAvailable;
    this.processDemand = false;
    this.snapshotStore = new SnapshotStore();
    this.commandRunner = commandRunner || new CommandRunner();
    const reader = fileReader || { readFile(file, encoding) {
      const options = executionOptions();
      return fs.readFile(file, { encoding, signal: options.signal });
    } };
    const policies = collectionPolicy(runtimeConfig);
    this.scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: runtimeConfig.refreshInterval * 1000,
      onTick: () => this.onSnapshot(this.snapshotStore.read()) });
    const knownTotals = () => {
      const snapshot = this.snapshotStore.read();
      return { totalMemoryBytes: snapshot.memory.value?.totalBytes, coreCount: snapshot.cpu.value?.coreCount };
    };
    const providers = acceleratorProviders || [new NvidiaProvider({ commandRunner: this.commandRunner, systemInfo })];
    const definitions = [
      ['resources', new ResourceCollector({ commandRunner: this.commandRunner })],
      ['sshTraffic', new SshTrafficCollector({ commandRunner: this.commandRunner, isSsh, clientIp: sshClientIp, connectionInfo: sshConnectionInfo, onLog })],
      ['processes', new ProcessCollector({ commandRunner: this.commandRunner, systemInfo, knownTotals,
        gpuEnabled: () => this.demand.accelerators, refreshInterval: () => this.runtimeConfig.refreshInterval })],
      ['accelerators', new AcceleratorCollector({ providers })],
      ['diskTopology', new DiskTopologyCollector({ commandRunner: this.commandRunner, fileReader: reader, getDiskConfig: () => this.runtimeConfig.disk })],
    ];
    this.runners = definitions.map(([key, collector]) => {
      const policy = policies[key];
      const runner = new CollectorRunner({
        key, resultKeys:policy.resultKeys, grouped:key === 'resources', collector, snapshotStore: this.snapshotStore,
        minimumIntervalMilliseconds: policy.minimumIntervalMilliseconds,
        timeoutMilliseconds: policy.timeoutMilliseconds,
        onStatusChange: (name, status, error) => this.logStatus(name, status, error),
        onSettled: () => {
          if (!this.scheduler.isPaused && !this.scheduler.isCollectingOnce) onCollectionSettled(this.snapshotStore.read());
        },
      });
      this.scheduler.addRunner(runner);
      return runner;
    });
    this.lastStatuses = new Map();
    this.updateDemand(runtimeConfig, false);
  }

  updateDemand(config, refresh = true) {
    const demand = collectionDemand(config, { statusBarAvailable:this.statusBarAvailable, processes:this.processDemand });
    this.demand = demand;
    for (const runner of this.runners) this.scheduler.setRunnerDemand(runner, demandedKeys(runner.key, demand), { refresh });
  }

  setProcessDemand(demanded) {
    if (this.processDemand === demanded) return;
    this.processDemand = demanded;
    this.updateDemand(this.runtimeConfig);
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

  resetCounters() {
    for (const runner of this.runners) if (COLLECTION_POLICY[runner.key].counters) runner.requestReset();
  }

  start() { this.scheduler.start(); }
  pause() {
    this.resetCounters();
    this.scheduler.pause();
  }
  async collectOnce(options) {
    await this.scheduler.collectOnce(options);
    this.onSnapshot(this.snapshotStore.read());
  }
  resume({ force = false } = {}) {
    if (force) {
      for (const runner of this.runners) runner.markDue();
      this.resetCounters();
    }
    this.scheduler.resume();
  }
  updateConfig(runtimeConfig) {
    const intervalChanged = this.runtimeConfig.refreshInterval !== runtimeConfig.refreshInterval;
    const diskChanged = diskSelectionSignature(this.runtimeConfig.disk) !== diskSelectionSignature(runtimeConfig.disk);
    this.runtimeConfig = runtimeConfig;
    this.updateDemand(runtimeConfig);
    const policies = collectionPolicy(runtimeConfig);
    for (const runner of this.runners) runner.configure({ timeoutMilliseconds: policies[runner.key].timeoutMilliseconds });
    if (diskChanged) this.scheduler.refreshRunner(this.runners.find((runner) => runner.key === 'diskTopology'));
    if (intervalChanged) this.scheduler.setRefreshInterval(runtimeConfig.refreshInterval * 1000);
  }
  readSnapshot() { return this.snapshotStore.read(); }
  dispose() {
    this.scheduler.dispose();
    this.commandRunner.dispose();
  }
}

module.exports = { MonitorService };
