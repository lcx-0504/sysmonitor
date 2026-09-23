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

class MonitorService {
  constructor({ runtimeConfig, isSsh, sshClientIp, acceleratorProviders = null, onTick = () => {}, onLog = () => {} }) {
    this.runtimeConfig = runtimeConfig;
    this.onTick = onTick;
    this.onLog = onLog;
    this.snapshotStore = new SnapshotStore();
    this.commandRunner = new CommandRunner();
    const refreshMilliseconds = runtimeConfig.refreshInterval * 1000;
    this.scheduler = new MonitorScheduler({ refreshIntervalMilliseconds: refreshMilliseconds, onTick: () => this.onTick(this.snapshotStore.read()) });
    const definitions = [
      ['cpu', new CpuCollector(), refreshMilliseconds, 1000],
      ['memory', new MemoryCollector(), refreshMilliseconds, 1000],
      ['network', new NetworkCollector(), refreshMilliseconds, 1000],
      ['diskIo', new DiskIoCollector(), refreshMilliseconds, 1000],
      ['sshTraffic', new SshTrafficCollector({ commandRunner: this.commandRunner, isSsh, clientIp: sshClientIp }), refreshMilliseconds, 2500],
      ['processes', new ProcessCollector({ commandRunner: this.commandRunner }), refreshMilliseconds, 3500],
      ['accelerators', new AcceleratorCollector({ providers: acceleratorProviders || [new NvidiaProvider({ commandRunner: this.commandRunner })] }), refreshMilliseconds, 32000],
      ['diskTopology', new DiskTopologyCollector({ commandRunner: this.commandRunner, getDiskConfig: () => this.runtimeConfig.disk }), 10000, 6000],
    ];
    this.runners = definitions.map(([key, collector, cadenceMilliseconds, timeoutMilliseconds]) => {
      const runner = new CollectorRunner({ key, collector, snapshotStore: this.snapshotStore, cadenceMilliseconds, timeoutMilliseconds, onStatusChange: (name, status, error) => this.logStatus(name, status, error) });
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
  resume() { this.scheduler.resume(); }
  updateConfig(runtimeConfig) {
    const intervalChanged = this.runtimeConfig.refreshInterval !== runtimeConfig.refreshInterval;
    this.runtimeConfig = runtimeConfig;
    if (intervalChanged) this.scheduler.setRefreshInterval(runtimeConfig.refreshInterval * 1000);
  }
  readSnapshot() { return this.snapshotStore.read(); }
  dispose() { this.scheduler.dispose(); this.commandRunner.dispose(); }
}

module.exports = { MonitorService };
