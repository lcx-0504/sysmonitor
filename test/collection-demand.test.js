'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeConfig } = require('../src/config/normalize-config');
const { collectionDemand } = require('../src/services/collection-demand');
const { MonitorService } = require('../src/services/monitor-service');
const { ResourceCollector } = require('../src/collectors/resource-collector');
const { SnapshotStore } = require('../src/core/snapshot-store');
const { CollectorRunner } = require('../src/core/collector-runner');
const { buildMonitorViewModel } = require('../src/services/monitor-view-model');
const { resourceCommandFiles, resourceCommandRunner } = require('./resource-fixture');

const hiddenGroups = { cpu:true, memory:true, disk:true, network:true, gpuCards:true, gpuSummary:true };
const disabledConfig = () => normalizeConfig({ display:{hiddenGroups}, statusBar:{barEnabled:false} });

test('panel and the applicable status bar share one metric demand calculation', () => {
  const config = disabledConfig();
  assert.deepEqual(collectionDemand(config), {
    cpu:false, memory:false, network:false, diskIo:false, diskTopology:false, sshTraffic:false, accelerators:false, processes:false,
  });
  assert.equal(collectionDemand(config, { processes:true }).processes, true);
  config.statusBar.barEnabled = true;
  config.statusBar.diskIO = 'read';
  config.statusBar.gpu.summary = false;
  config.statusBar.gpu.mode = 'my';
  const local = collectionDemand(config);
  assert.equal(local.cpu, true); assert.equal(local.memory, true); assert.equal(local.diskIo, true);
  assert.equal(local.diskTopology, false); assert.equal(local.accelerators, true);
  assert.deepEqual(collectionDemand(config, {statusBarAvailable:false}), collectionDemand(disabledConfig()));
});

test('disabled modules leave scheduling, failures and initial readiness together', t => {
  const service = new MonitorService({runtimeConfig:normalizeConfig({}), isSsh:false});
  service.pause(); t.after(() => service.dispose());
  for (const key of ['cpu','memory','diskIo','diskTopology','accelerators']) service.snapshotStore.fail(key, new Error('failed'));
  service.updateConfig(disabledConfig());
  service.setProcessDemand(true);
  assert.deepEqual(service.requiredKeys(), []);
  assert.deepEqual(service.requiredKeys('proc'), ['processes']);
  for (const runner of service.runners) assert.equal(runner.enabled, runner.key === 'processes');
  for (const key of Object.keys(service.demand).filter(key => key !== 'processes')) {
    assert.equal(service.readSnapshot()[key].status, 'disabled', key);
    assert.equal(service.readSnapshot()[key].lastError, null, key);
    assert.equal(service.readSnapshot()[key].value, null, key);
  }
  const model = buildMonitorViewModel(service.readSnapshot());
  assert.deepEqual(model.performance.gpus, []);
  assert.equal(model.sources.accelerators.state, 'disabled');
  service.updateConfig(normalizeConfig({}));
  assert.ok(service.runners.every(runner => runner.enabled));
  assert.equal(service.readSnapshot().cpu.status, 'loading');
});

test('a hidden disk is omitted from the resource read and cannot fail the other resources', async () => {
  const read = [];
  const files = {
    '/proc/stat':'cpu 10 0 10 80\ncpu0 1 0 1 8\n', '/proc/loadavg':'1 2 3 1/10 5\n',
    '/proc/meminfo':'MemTotal: 1000 kB\nMemAvailable: 400 kB\n',
    '/proc/net/dev':'Inter-| Receive | Transmit\nface | bytes\neth0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\n', '/proc/net/route':'',
  };
  const collector = new ResourceCollector({commandRunner:resourceCommandRunner(async file => {
    read.push(file); if (!(file in files)) throw new Error('disk unavailable'); return files[file];
  })});
  collector.setKeys(['cpu','memory','network']);
  assert.deepEqual(Object.keys(await collector.collect()), ['cpu','memory','network']);
  assert.equal(read.includes('/proc/diskstats'), false);
});

test('a single selected resource is still transported and committed as a grouped result', async () => {
  let commandText;
  const collector = new ResourceCollector({keys:['memory'], commandRunner:{async execFile(command,args) {
    assert.equal(command, 'sh'); commandText = args[1];
    return {stdout:'__SYSMON_RESOURCE_0__\nMemTotal: 1000 kB\nMemAvailable: 400 kB\n\n__SYSMON_RESOURCE_1__\n12.00 12.01\n'};
  }}});
  const store = new SnapshotStore();
  const runner = new CollectorRunner({key:'resources', grouped:true, resultKeys:['memory'], collector, snapshotStore:store,
    timeoutMilliseconds:1000});
  await runner.run();
  assert.equal(store.read().memory.value.usagePercent, 60);
  assert.deepEqual(resourceCommandFiles(commandText), ['/proc/meminfo']);
  assert.equal(store.read().cpu.value, null);
});

test('disabling an in-flight resource suppresses its late result and re-enabling resets it', async t => {
  const config = disabledConfig(); config.display.hiddenGroups.memory = false;
  const service = new MonitorService({runtimeConfig:config,isSsh:false}); service.pause();
  t.after(() => service.dispose());
  const resources = service.runners.find(runner => runner.key === 'resources');
  let finish;
  resources.collector.collect = () => new Promise(resolve => {finish=resolve;});
  const collecting = resources.run();
  service.updateConfig(disabledConfig());
  finish({memory:{usagePercent:99}}); await collecting; await resources.idle;
  assert.equal(service.readSnapshot().memory.status, 'disabled');
  assert.equal(service.readSnapshot().memory.value, null);
  service.updateConfig(config);
  resources.collector.collect = async () => ({memory:{usagePercent:20}});
  await resources.run();
  assert.equal(service.readSnapshot().memory.value.usagePercent, 20);
});

test('the configured local status bar does not keep remote server collectors running', t => {
  const config = disabledConfig(); config.statusBar.barEnabled = true;
  const service = new MonitorService({runtimeConfig:config,isSsh:true,statusBarAvailable:false});
  t.after(() => service.dispose());
  assert.deepEqual(service.requiredKeys(), []);
  assert.equal(service.runners.find(runner => runner.key === 'resources').enabled, false);
});

test('re-enabling counter resources establishes a fresh baseline', async () => {
  let sectors=10;
  const collector=new ResourceCollector({keys:['diskIo'],commandRunner:resourceCommandRunner(async()=>`8 0 sda 0 0 ${sectors} 0 0 0 20 0 0 0 0 0\n`)});
  assert.equal((await collector.collect()).diskIo.readBytesPerSecond,null);
  collector.setKeys([]); sectors=100000;
  collector.setKeys(['diskIo']);
  assert.equal((await collector.collect()).diskIo.readBytesPerSecond,null);
});

test('process CPU normalization is available without the CPU utilization collector', async () => {
  const {ProcessCollector}=require('../src/collectors/process-collector');
  const collector=new ProcessCollector({commandRunner:{execFile:async()=>({stdout:'__SYSMON_PROCESSES__ 1 0\n7 root 50.0 2048 Sun Jul 13 12:34:56 2026 /bin/test\n__SYSMON_SESSIONS__\n'})},
    systemInfo:{totalMemoryBytes:async()=>1024**3,coreCount:async()=>4}});
  const store=new SnapshotStore(); store.reset('cpu','disabled'); store.commit('processes',await collector.collect());
  const model=buildMonitorViewModel(store.read());
  assert.equal(model.processes[0].cpu,50); assert.equal(model.processes[0].cpuWhole,12.5);
});

test('the server list drops disabled metric summaries along with their samples', t => {
  const {ServerDirectory}=require('../src/view/server-directory');
  const service=new MonitorService({runtimeConfig:normalizeConfig({}),isSsh:true,statusBarAvailable:false});
  service.pause(); t.after(()=>service.dispose());
  service.snapshotStore.commit('cpu',{usagePercent:80,coreCount:4,loadAverage:{oneMinute:1,fiveMinutes:2,fifteenMinutes:3}});
  const device={service,state:'connected',displayError:()=>null,isCollectionPaused:()=>service.isPaused(),model:buildMonitorViewModel(service.readSnapshot())};
  const directory=new ServerDirectory({vscode:{},manager:{get:()=>device}});
  t.after(()=>directory.dispose()); directory.hosts=['fixture'];
  assert.deepEqual(directory.rows()[0].metrics,['CPU 80%']);
  service.updateConfig(disabledConfig()); device.model=buildMonitorViewModel(service.readSnapshot());
  assert.deepEqual(directory.rows()[0].metrics,[]);
});
