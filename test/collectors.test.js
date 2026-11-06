'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { parseDefaultRouteInterfaces, parseNetworkCounters, parseProcessOutput } = require('../src/domain/linux-parsers');
const { parseNvidiaCards, parseNvidiaProcesses } = require('../src/accelerators/nvidia-provider');
const { NvidiaProvider } = require('../src/accelerators/nvidia-provider');
const { SshTrafficCollector } = require('../src/collectors/ssh-traffic-collector');
const { resourceCommandFiles, resourceCommandRunner } = require('./resource-fixture');

async function sshSamples(outputs, target, options = {}) {
  let round = 0;
  const collector = new SshTrafficCollector({ isSsh: true, ...options, ...(typeof target === 'string' ? { clientIp: target } : { connectionInfo: () => target }),
    commandRunner: { async execFile() { round++; return { stdout: timedSshOutput(outputs[round - 1], round) }; } } });
  const results = [];
  for (let index = 0; index < outputs.length; index++) results.push(await collector.collect());
  return results;
}

test('SSH collection makes one query per round and matches IPv6 endpoints on a custom port', async () => {
  const {CollectorRunner}=require('../src/core/collector-runner');
  const {SnapshotStore}=require('../src/core/snapshot-store');
  let calls=0;
  const connection={serverIp:'2001:db8::2',serverPort:2222,clientIp:'2001:db8::1',clientPort:42000};
  const collector=new SshTrafficCollector({isSsh:true,connectionInfo:()=>connection,commandRunner:{async execFile(command,args){
    calls++;assert.equal(command,'sh');assert.equal(args[0],'-c');
    const seconds=calls*2;
    return {stdout:`__SYSMON_SSH_SAMPLE_START__ ${seconds}\n0 0 [2001:db8::2]:2222 [2001:db8::1]:42000\n cubic rtt:8 bytes_sent:${calls*200} bytes_received:${calls*100}\n__SYSMON_SSH_SAMPLE_END__ ${seconds}\n`};
  }}});
  const store=new SnapshotStore();
  const runner=new CollectorRunner({key:'sshTraffic',collector,snapshotStore:store,timeoutMilliseconds:1000});
  await runner.run();await runner.idle;
  assert.equal(calls,1);assert.equal(store.read().sshTraffic.value.clientDownloadBytesPerSecond,null);
  assert.equal(store.read().sshTraffic.value.latencyMilliseconds,8);
  await runner.run();await runner.idle;
  assert.equal(calls,2);assert.equal(store.read().sshTraffic.value.clientDownloadBytesPerSecond,100);
});

test('SSH loopback traffic counts the server socket without adding the client socket again', async () => {
  const connection={serverIp:'127.0.0.1',serverPort:22,clientIp:'127.0.0.1',clientPort:50576};
  const raw=(server, client)=>`0 0 127.0.0.1:22 127.0.0.1:50576\n cubic rtt:1 bytes_sent:${server} bytes_received:${server / 5}\n0 0 127.0.0.1:50576 127.0.0.1:22\n cubic rtt:2 bytes_sent:${client / 5} bytes_received:${client}\n`;
  const [, second] = await sshSamples([raw(100, 100), raw(300, 1000)], [connection]);
  assert.deepEqual([second.clientDownloadBytesPerSecond, second.clientUploadBytesPerSecond, second.latencyMilliseconds], [200, 40, 1]);
});

test('GPU cards survive process-query failure and deadline expiry with unknown occupancy', async () => {
  const {CollectorRunner}=require('../src/core/collector-runner');
  const {SnapshotStore}=require('../src/core/snapshot-store');
  const {AcceleratorCollector}=require('../src/collectors/accelerator-collector');
  for (const delayed of [false,true]) {
    let release;
    const provider=new NvidiaProvider({commandRunner:{async execFile(command,args){
      if(args[0].startsWith('--query-gpu'))return {stdout:'0, A100, 70, 100, 1000, 45, 50, 250, GPU-A'};
      if(delayed)return new Promise(resolve=>{release=()=>resolve({stdout:''});});
      throw new Error('process query unavailable');
    }}});
    const store=new SnapshotStore();
    const runner=new CollectorRunner({key:'accelerators',collector:new AcceleratorCollector({providers:[provider]}),snapshotStore:store,timeoutMilliseconds:20});
    await runner.run();
    const value=store.read().accelerators.value;
    assert.equal(value.devices[0].utilizationPercent,70);assert.equal(value.occupancyKnown,false);
    assert.equal(value.collectionErrors[0].code,'GPU_OCCUPANCY_UNAVAILABLE');
    if(release)release();await runner.idle;
  }
});

test('SSH latency matches IPv4-mapped socket addresses and RTT without a variance suffix', async () => {
  const raw = '0 0 [::ffff:10.0.0.2]:22 [::ffff:10.0.0.1]:42000\n  cubic rtt:12.5 bytes_sent:100 bytes_received:50\n';
  const [sample] = await sshSamples([raw], { serverIp: '10.0.0.2', serverPort: 22, clientIp: '10.0.0.1', clientPort: 42000 });
  assert.equal(sample.latencyMilliseconds, 12.5);
});
const { ResourceCollector } = require('../src/collectors/resource-collector');
const { NetworkCollector } = require('../src/collectors/network-collector');
const { DiskIoCollector } = require('../src/collectors/disk-io-collector');
const { ProcessCollector } = require('../src/collectors/process-collector');
const { DiskTopologyCollector } = require('../src/collectors/disk-topology-collector');
const mountInfo = (mounts) => mounts.map((mount, index) => `${index + 1} 0 8:0 / ${mount.target} rw - ${mount.fstype} source rw`).join('\n');
const dfOutput = mounts => 'Filesystem Type 1024-blocks Used Available Capacity Mounted on\n' + mounts.map(mount =>
  ['source', mount.fstype, ...['size', 'used', 'avail'].map((key, index) => Object.hasOwn(mount, key) ? mount[key] ?? '-' : [100, 40, 60][index]), '40%', mount.target].join(' ')).join('\n');
const { parseDfOutput, parseFindmntOutput, parseMountInfo } = require('../src/domain/disk');
const queryTargets = options => parseMountInfo(options.input, { mountFilter: 'all' }).map(mount => mount.mountPath);
const findmntOutput = mounts => JSON.stringify({ filesystems: mounts.map(mount => ({ target: mount.target, fstype: mount.fstype,
  size: Object.hasOwn(mount, 'size') ? mount.size : 100, used: Object.hasOwn(mount, 'used') ? mount.used : 40,
  avail: Object.hasOwn(mount, 'avail') ? mount.avail : 60, 'use%': '40%' })) });
const { parseRules } = require('../src/domain/disk');
const { SnapshotStore } = require('../src/core/snapshot-store');
const { CollectorRunner } = require('../src/core/collector-runner');

test('disk filter rules accept commas, line breaks, and Windows line endings', () => {
  assert.deepEqual(parseRules('vfat,ntfs\n/nfs\r\n/data/cache,\n'), {
    fileSystemTypes: ['vfat', 'ntfs'], pathPrefixes: ['/nfs', '/data/cache'],
  });
});

test('capacity query mount metadata omits large overlay options and preserves escaped paths', () => {
  const raw = '1 0 0:1 / /data\\040space rw - overlay overlay rw,lowerdir=' + 'x'.repeat(200000);
  const mounts = parseMountInfo(raw, { mountFilter: 'all' });
  assert.equal(mounts[0].mountPath, '/data space');
  assert.ok(mounts[0].mountInfo.length < 100);
  assert.deepEqual(parseMountInfo(mounts[0].mountInfo, { mountFilter: 'all' }).map(mount => mount.mountPath), ['/data space']);
});

test('resource collection reads stat and load averages in one command', async () => {
  const runner = resourceCommandRunner(async file => file === '/proc/stat' ? 'cpu 1 2 3 4 5 6 7 8\ncpu0 1 2 3 4 5 6 7 8\n' : '1.0 2.0 3.0 1/100 123');
  const collector = new ResourceCollector({ commandRunner: runner, keys:['cpu'] });
  const {cpu:value} = await collector.collect();
  assert.equal(value.coreCount, 1);
  assert.deepEqual(value.loadAverage, { oneMinute: 1, fiveMinutes: 2, fifteenMinutes: 3 });
  assert.deepEqual(runner.commands.map(resourceCommandFiles), [['/proc/stat', '/proc/loadavg']]);
});

test('unmeasurable overlay mounts are skipped in default and all modes without failing healthy disks', async () => {
  const paths = [];
  const mounts = [{ target: '/', fstype: 'overlay' }, { target: '/nfs', fstype: 'nfs4' },
    { target: '/data/docker-data/overlay2/container/merged', fstype: 'overlay', size: null, used: null, avail: null }];
  let config = { mountFilter: 'default' };
  const collector = new DiskTopologyCollector({ fileReader: { readFile: async () => mountInfo(mounts) }, getDiskConfig: () => config,
    commandRunner: { execFile: async (_command, args, options) => { const selected = queryTargets(options); paths.push(...selected); return { stdout: findmntOutput(mounts.filter(mount => selected.includes(mount.target))) }; } },
  });
  assert.deepEqual((await collector.collect()).map(value => value.mountPath), ['/', '/nfs']);
  assert.deepEqual(paths, mounts.map(mount => mount.target));
  config = { mountFilter: 'all' };
  assert.equal((await collector.collect()).length, 2);
});

function timedSshOutput(raw, seconds) {
  return `__SYSMON_SSH_SAMPLE_START__ ${seconds}\n${raw}\n__SYSMON_SSH_SAMPLE_END__ ${seconds}\n`;
}

test('network parser selects default-route interfaces and avoids bridge/veth double counting', () => {
  const routes = 'Iface Destination Gateway Flags RefCnt Use Metric Mask\neth0 00000000 01010101 0003 0 0 0 00000000\ndocker0 0000A8C0 00000000 0001 0 0 0 00FFFFFF\n';
  const devices = 'Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\neth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0\ndocker0: 500 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0\nveth1: 500 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0\n';
  const selected = parseDefaultRouteInterfaces(routes);
  assert.deepEqual([...selected], ['eth0']);
  assert.deepEqual(parseNetworkCounters(devices, selected), { receiveBytes: 1000, transmitBytes: 2000, availableInterfaces: ['eth0', 'docker0', 'veth1'] });
});

test('stale routes never turn a missing interface into a zero sample and fallback uses actual counters', async () => {
  let now = 0, device = 'Inter-| Receive | Transmit\n face | bytes\n';
  const collector = new NetworkCollector();
  const sample = () => collector.accept(device, 'Iface Destination Gateway Flags\neth0 00000000 0 0003\n', now);
  sample(); now = 1000;
  const missing = sample();
  assert.deepEqual(missing.interfaces, []); assert.equal(missing.receiveBytesPerSecond, null); assert.equal(collector.needsWarmup(missing), false);
  device += 'eth1: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\n'; now = 2000;
  const baseline = sample(); assert.equal(collector.needsWarmup(baseline), true); assert.deepEqual(baseline.interfaces, ['eth1']);
  device = device.replace('eth1: 100', 'eth1: 300'); now = 3000;
  const fresh = sample(); assert.equal(fresh.receiveBytesPerSecond, 200); assert.deepEqual(fresh.interfaces, ['eth1']);
});

test('process parser supports full list parsing and stable start-derived keys', () => {
  const raw = '42 root 1.5 2048 Sun Jul 13 12:34:56 2026 [jbd2/nvme0n1p2-8]\n43 alice 0.1 4096 Sun Jul 13 12:35:00 2026 /usr/bin/python train.py\n';
  const rows = parseProcessOutput(raw, 1024 * 1024 * 1024);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].processName, '[jbd2/nvme0n1p2-8]');
  assert.match(rows[0].processKey, /^42:\d+$/);
  assert.equal(rows[1].processName, 'python');
});

test('NVIDIA parsers retain stable identity and explicitly mark unmatched process mappings', () => {
  const cards = parseNvidiaCards('0, NVIDIA A100, 5, 1024, 40960, 40, 50, 300, GPU-abc');
  assert.equal(cards[0].deviceKey, 'nvidia:GPU-abc');
  const usages = parseNvidiaProcesses('10, GPU-abc, 512\n11, GPU-missing, 64', new Map(cards.map((card) => [card.providerDeviceId, card])));
  assert.equal(usages.get(10)[0].mappingStatus, 'matched');
  assert.equal(usages.get(11)[0].mappingStatus, 'unmatched');
  assert.equal(usages.get(11)[0].nativeIndex, null);
});

test('SSH counters and TCP RTT are parsed for the selected client', async () => {
  const raw = bytes => `ESTAB 0 0 10.0.0.2:22 10.0.0.1:50000\n cubic rtt:12.5/2.0 bytes_sent:${bytes * 2} bytes_received:${bytes}\n`
    + 'ESTAB 0 0 10.0.0.2:22 10.0.0.9:50000\n cubic rtt:40.0/3.0 bytes_sent:9999 bytes_received:8888\n';
  const [, second] = await sshSamples([raw(1000), raw(1500)], '10.0.0.1');
  assert.deepEqual([second.clientDownloadBytesPerSecond, second.clientUploadBytesPerSecond, second.latencyMilliseconds], [1000, 500, 12.5]);
});

test('local SSH monitoring matches one socket even when clients share an IP', async () => {
  const raw = bytes => `ESTAB 0 0 10.0.0.2:22 10.0.0.1:50000\n cubic rtt:12.5/2.0 bytes_sent:${bytes * 2} bytes_received:${bytes}\n`
    + `ESTAB 0 0 10.0.0.2:22 10.0.0.1:50001\n cubic rtt:40.0/3.0 bytes_sent:${bytes * 9} bytes_received:${bytes * 8}\n`;
  const connection = { clientIp: '10.0.0.1', clientPort: 50000, serverIp: '10.0.0.2', serverPort: 22 };
  const logs = [];
  const [, second] = await sshSamples([raw(1000), raw(1500)], connection, { onLog: message => logs.push(message) });
  assert.deepEqual([second.clientDownloadBytesPerSecond, second.clientUploadBytesPerSecond, second.latencyMilliseconds], [1000, 500, 12.5]);
  assert.deepEqual(logs, []);
});

test('an unmatched SSH connection tuple falls back to the server port and client address once', async () => {
  const header = 'Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n';
  const translated = bytes => header + `0 0 192.168.1.5:2222 10.0.0.1:61000\n cubic rtt:8 bytes_sent:${bytes * 2} bytes_received:${bytes}\n`
    + '0 0 192.168.1.5:22 10.0.0.1:61001\n cubic rtt:9 bytes_sent:7777 bytes_received:7777\n'
    + '0 0 192.168.1.5:2222 10.0.0.9:61002\n cubic rtt:9 bytes_sent:7777 bytes_received:7777\n';
  const exact = bytes => header + `0 0 10.0.0.2:2222 10.0.0.1:50000\n cubic rtt:8 bytes_sent:${bytes * 2} bytes_received:${bytes}\n`;
  const connection = { clientIp: '10.0.0.1', clientPort: 50000, serverIp: '10.0.0.2', serverPort: 2222 };
  const logs = [];
  const samples = await sshSamples([translated(1000), translated(1500), translated(2000), exact(100), exact(200)], connection, { onLog: message => logs.push(message) });
  assert.deepEqual(samples.map(sample => sample.clientDownloadBytesPerSecond), [null, 1000, 1000, null, 200]);
  assert.equal(samples[1].latencyMilliseconds, 8);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /exact connection match failed/);
  assert.match(logs[1], /restored/);
});

test('SSH collector waits for its own connection tuple before showing local SSH traffic', async () => {
  const connection = { clientIp: '10.0.0.1', clientPort: 50000, serverIp: '10.0.0.2', serverPort: 22 };
  let available = false; let calls = 0;
  const collector = new SshTrafficCollector({
    isSsh: true, connectionInfo: () => available ? connection : null,
    commandRunner: { execFile: async () => { calls++; return { stdout: timedSshOutput('ESTAB 0 0 10.0.0.2:22 10.0.0.1:50000\n cubic rtt:9.1/1.0 bytes_sent:10 bytes_received:20\n', 1) }; } },
  });
  assert.equal((await collector.collect()).isSsh, true);
  assert.equal(calls, 0);
  available = true;
  assert.equal((await collector.collect()).isSsh, true);
  assert.equal(calls, 1);
});

test('SSH traffic includes every pool connection, excludes other clients and resets on membership changes', async () => {
  const first = { clientIp: '10.0.0.1', clientPort: 50000, serverIp: '10.0.0.2', serverPort: 22 };
  const second = { ...first, clientPort: 50001 };
  let connections = [first]; let now = 0; let bytes = 100;
  const collector = new SshTrafficCollector({ isSsh: true, connectionInfo: () => connections,
    commandRunner: { async execFile() {
      return { stdout: timedSshOutput([50000, 50001, 60000].map((port) =>
        'ESTAB 0 0 10.0.0.2:22 10.0.0.1:' + port + '\n cubic rtt:10/1 bytes_sent:' + bytes + ' bytes_received:' + bytes + '\n').join(''), now / 1000) };
    } },
  });
  await collector.collect();
  now += 1000; bytes += 100;
  assert.equal((await collector.collect()).clientDownloadBytesPerSecond, 100);
  connections = [first, second];
  now += 1000; bytes += 100;
  assert.equal((await collector.collect()).clientDownloadBytesPerSecond, null);
  now += 1000; bytes += 100;
  assert.equal((await collector.collect()).clientDownloadBytesPerSecond, 200);
  connections = [second, first];
  now += 1000; bytes += 100;
  assert.equal((await collector.collect()).clientDownloadBytesPerSecond, 200);
  connections = [];
  assert.equal((await collector.collect()).isSsh, true);
});

test('the SSH socket query asks ss for numeric addresses without -H, which older ss lacks, and skips its header line', async () => {
  let args;
  const header = 'Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n';
  const collector = new SshTrafficCollector({
    isSsh: true,
    clientIp: '10.0.0.1',
    commandRunner: { execFile: async (_command, commandArgs) => { args = commandArgs; return { stdout: timedSshOutput(header + 'ESTAB 0 0 10.0.0.2:22 10.0.0.1:50000\n cubic rtt:9.1/1.0 bytes_sent:10 bytes_received:20\n', 1) }; } },
  });
  const result = await collector.collect();
  assert.match(args[1], /\bss -t -i -n state established/);
  assert.doesNotMatch(args[1], /ss -H/);
  assert.equal(result.latencyMilliseconds, 9.1);
});

test('SSH traffic retains the last complete baseline through missing socket samples', async () => {
  const first = { clientIp: '10.0.0.1', clientPort: 50000, serverIp: '10.0.0.2', serverPort: 22 };
  const second = { ...first, clientPort: 50001 };
  let seconds = 0, missing = false, bytes = 1_800_000_000;
  let connections = [first];
  const collector = new SshTrafficCollector({ isSsh: true, connectionInfo: () => connections,
    commandRunner: { async execFile() {
      const raw = missing ? '' : `0 0 10.0.0.2:22 10.0.0.1:50000\n cubic bytes_sent:${bytes} bytes_received:1000\n`;
      return { stdout: timedSshOutput(raw, seconds) };
    } },
  });
  await collector.collect();
  seconds = 2; missing = true;
  assert.equal((await collector.collect()).clientDownloadBytesPerSecond, null);
  seconds = 4; missing = false; bytes += 200_000;
  assert.equal((await collector.collect()).clientDownloadBytesPerSecond, 50_000);
  seconds = 6; bytes += 200_000;
  assert.equal((await collector.collect()).clientDownloadBytesPerSecond, 100_000);
  connections = [first, second]; seconds = 8;
  assert.equal((await collector.collect()).clientDownloadBytesPerSecond, null);
  assert.ok(collector.previous);
});

test('SSH rates use server uptime even when delayed responses arrive almost together', async () => {
  let remoteSeconds = 100, bytes = 1_000_000_000;
  const collector = new SshTrafficCollector({ isSsh: true, clientIp: '10.0.0.1',
    commandRunner: { async execFile() {
      return { stdout: timedSshOutput(`0 0 10.0.0.2:22 10.0.0.1:50000\n cubic bytes_sent:${bytes} bytes_received:1000\n`, remoteSeconds) };
    } },
  });
  await collector.collect();
  remoteSeconds += 2; bytes += 1_000_000;
  assert.equal((await collector.collect()).clientDownloadBytesPerSecond, 500_000);
  bytes += 100;
  assert.equal((await collector.collect()).clientDownloadBytesPerSecond, null, 'same uptime timestamp cannot produce an infinite or tiny-interval rate');
  remoteSeconds = 1;
  assert.equal((await collector.collect()).clientDownloadBytesPerSecond, null, 'server reboot establishes a new baseline');
});

test('SSH traffic preserves its baseline on command timeout and only matches an exact client IP', async () => {
  let timeout = false, seconds = 0, bytes = 500_000_000;
  const collector = new SshTrafficCollector({ isSsh: true, clientIp: '10.0.0.1', commandRunner: { async execFile() {
    if (timeout) throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    return { stdout: timedSshOutput(`0 0 10.0.0.2:22 10.0.0.1:50000\n cubic bytes_sent:${bytes} bytes_received:1000\n`
      + '0 0 10.0.0.2:22 10.0.0.10:50001\n cubic bytes_sent:9000000000 bytes_received:9000000000\n', seconds) };
  } } });
  await collector.collect();
  timeout = true;
  await assert.rejects(collector.collect(), { code: 'ETIMEDOUT' });
  timeout = false; seconds = 10; bytes += 100_000;
  assert.equal((await collector.collect()).clientDownloadBytesPerSecond, 10_000);
  seconds = 12; bytes += 100_000;
  assert.equal((await collector.collect()).clientDownloadBytesPerSecond, 50_000);
});

test('GPU identity uses the same UTC process key as the process table', async () => {
  const calls = [];
  const start = 'Mon Jul 13 12:34:56 2026';
  const commandRunner = { async execFile(command, args) {
    calls.push(command);
    if (command === 'ps') return { stdout: '22 1000 alice ' + start };
    return { stdout: args[0].startsWith('--query-gpu') ? '0, A100, 10, 100, 1000, 45, 50, 300, GPU-a' : '22, GPU-a, 100' };
  } };
  const result = await new NvidiaProvider({ commandRunner, userId: 1000 }).collect();
  const process = parseProcessOutput('22 alice 1.0 2048 ' + start + ' train', 1e9)[0];
  assert.equal(result.usagesByPid.get(22)[0].processKey, process.processKey);
  assert.equal(result.usagesByPid.get(22)[0].userName, 'alice');
  assert.equal(result.usagesByPid.get(22)[0].identityKnown, true);
  assert.deepEqual(result.currentUserDeviceKeys, ['nvidia:GPU-a']);
  assert.deepEqual(calls, ['nvidia-smi', 'nvidia-smi', 'ps']);
});

test('hundreds of GPU PIDs require one identity query and no per-PID reads', async () => {
  const calls = [];
  const pids = Array.from({ length: 200 }, (_, index) => index + 1);
  const commandRunner = { async execFile(command, args) {
    calls.push(command);
    if (command === 'ps') {
      assert.equal(args[1].split(',').length, 200);
      return { stdout: pids.map(pid => pid + ' 1000 alice Mon Jul 13 12:34:56 2026').join('\n') };
    }
    return { stdout: args[0].startsWith('--query-gpu') ? '0, A100, 10, 100, 1000, 45, 50, 300, GPU-a' : pids.map(pid => pid + ', GPU-a, 1').join('\n') };
  } };
  const value = await new NvidiaProvider({ commandRunner, userId: 1000 }).collect();
  assert.equal(value.usagesByPid.size, 200);
  assert.deepEqual(calls, ['nvidia-smi', 'nvidia-smi', 'ps']);
});

test('failed optional GPU identities preserve current core readings and report a warning', async () => {
  const commandRunner = { async execFile(command, args) {
    if (command === 'ps') throw Object.assign(new Error('identity query failed'), { code: 'EREMOTE', stderr: 'identity query failed' });
    return { stdout: args[0].startsWith('--query-gpu') ? '0, A100, 10, 100, 1000, 45, 50, 300, GPU-a' : '22, GPU-a, 100' };
  } };
  const value = await new NvidiaProvider({ commandRunner, userId: 1000 }).collect();
  assert.equal(value.devices[0].utilizationPercent, 10);
  assert.deepEqual(value.collectionErrors, [{ code:'GPU_IDENTITY_UNAVAILABLE', message:'identity query failed' }]);
  assert.equal(value.usagesByPid.get(22)[0].identityKnown, false);
  assert.deepEqual(value.currentUserDeviceKeys, []);
});

test('a deadline during optional GPU identity lookup publishes core metrics with a warning', async () => {
  const { AcceleratorCollector } = require('../src/collectors/accelerator-collector');
  const provider = new NvidiaProvider({ userId: 1000, commandRunner: { async execFile(command, args, options) {
    if (command === 'ps') return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    return { stdout: args[0].startsWith('--query-gpu') ? '0, A100, 10, 100, 1000, 45, 50, 300, GPU-a' : '22, GPU-a, 100' };
  } } });
  const store = new SnapshotStore();
  const runner = new CollectorRunner({ key: 'accelerators', collector: new AcceleratorCollector({ providers: [provider] }), snapshotStore: store,
    timeoutMilliseconds: 20 });
  await runner.run(); await runner.idle;
  assert.equal(store.read().accelerators.status, 'fresh');
  assert.equal(store.read().accelerators.value.devices[0].utilizationPercent, 10);
  assert.equal(store.read().accelerators.value.collectionErrors[0].code, 'GPU_IDENTITY_UNAVAILABLE');
  assert.match(store.read().accelerators.value.collectionErrors[0].message, /timed out/);
});

test('an empty GPU occupation list needs no process or user identity lookup', async () => {
  const calls = [];
  const provider = new NvidiaProvider({ commandRunner: { async execFile(command, args) {
    calls.push(command);
    assert.equal(command, 'nvidia-smi');
    return { stdout: args[0].startsWith('--query-gpu') ? '0, A100, 90, 70000, 80000, 45, 50, 300, GPU-a' : '' };
  } }, fileReader: { readFile() { throw new Error('No process file should be read'); } }, systemInfo: { userId() { throw new Error('No user lookup should be made'); } } });
  const value = await provider.collect();
  assert.equal(value.usagesByPid.size, 0);
  assert.deepEqual(value.currentUserDeviceKeys, []);
  assert.deepEqual(calls, ['nvidia-smi', 'nvidia-smi']);
});

test('resource collection exposes normalized CPU and memory snapshots', async () => {
  const cpuReads = ['cpu  10 0 10 80 0 0 0 0\ncpu0 1 0 1 8\n', 'cpu  20 0 20 160 0 0 0 0\ncpu0 1 0 1 8\n'];
  const resources = new ResourceCollector({ keys:['cpu','memory'], commandRunner:resourceCommandRunner(async file =>
    file === '/proc/stat' ? cpuReads.shift() : file === '/proc/loadavg' ? '1 2 3 1/10 5' : 'MemTotal: 1000 kB\nMemAvailable: 400 kB\n') });
  assert.equal((await resources.collect()).cpu.usagePercent, null);
  const value = await resources.collect();
  assert.equal(value.cpu.usagePercent, 20);
  assert.deepEqual(value.memory, { totalBytes: 1024000, availableBytes: 409600, usedBytes: 614400, usagePercent: 60 });
});

test('network and disk I/O collectors calculate rates only after a valid baseline', async () => {
  let now = 0;
  const networkReads = [
    'Inter-| Receive | Transmit\n face |x\neth0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\n',
    'Iface Destination Gateway Flags\neth0 00000000 0 0003\n',
    'Inter-| Receive | Transmit\n face |x\neth0: 300 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0\n',
    'Iface Destination Gateway Flags\neth0 00000000 0 0003\n',
  ];
  const network = new NetworkCollector();
  assert.equal(network.accept(networkReads.shift(),networkReads.shift(),now).receiveBytesPerSecond, null); now = 1000;
  assert.equal(network.accept(networkReads.shift(),networkReads.shift(),now).receiveBytesPerSecond, 200);
  const diskReads = ['8 0 sda 0 0 10 0 0 0 20 0 0 0 0\n', '8 0 sda 0 0 12 0 0 0 24 0 0 0 0\n']; now = 0;
  const disk = new DiskIoCollector();
  assert.equal(disk.accept(diskReads.shift(),now).readBytesPerSecond, null); now = 1000;
  assert.equal(disk.accept(diskReads.shift(),now).readBytesPerSecond, 1024);
});

test('counter rates mark decreasing counters and reversed clocks for reset in every rate collector', async () => {
  const { counterRates } = require('../src/utils/counter-rates');
  const fields = { readBytesPerSecond: 'readBytes' };
  assert.deepEqual(counterRates(null, { sampledAt: 1000, readBytes: 10 }, fields), { rates: { readBytesPerSecond: null }, resetFields: [], clockReversed: false });
  assert.deepEqual(counterRates({ sampledAt: 1000, readBytes: 10 }, { sampledAt: 3000, readBytes: 30 }, fields).rates, { readBytesPerSecond: 10 });
  assert.deepEqual(counterRates({ sampledAt: 1000, readBytes: 10 }, { sampledAt: 1000, readBytes: 30 }, fields).resetFields, []);
  assert.deepEqual(counterRates({ sampledAt: 1000, readBytes: 10 }, { sampledAt: 3000, readBytes: 5 }, fields),
    { rates: { readBytesPerSecond: null }, resetFields: ['readBytesPerSecond'], clockReversed: false });
  assert.equal(counterRates({ sampledAt: 3000, readBytes: 10 }, { sampledAt: 1000, readBytes: 30 }, fields).clockReversed, true);

  const stats = (read, write) => `8 0 sda 0 0 ${read} 0 0 0 ${write} 0 0 0 0\n`;
  const disk = new DiskIoCollector();
  disk.accept(stats(10, 20), 0);
  assert.deepEqual(disk.accept(stats(14, 28), 2000), { readBytesPerSecond: 1024, writeBytesPerSecond: 2048, resetFields: [], sampleIdentity: '["8:0:sda"]' });
  assert.deepEqual(disk.accept(stats(1, 30), 3000).resetFields, ['readBytesPerSecond', 'writeBytesPerSecond']);

  const route = 'Iface Destination Gateway Flags\neth0 00000000 0 0003\n';
  const devices = (received, sent) => `Inter-| Receive | Transmit\n face |x\neth0: ${received} 0 0 0 0 0 0 0 ${sent} 0 0 0 0 0 0 0\n`;
  const network = new NetworkCollector();
  network.accept(devices(100, 200), route, 2000);
  const reversed = network.accept(devices(300, 400), route, 1000);
  assert.deepEqual([reversed.receiveBytesPerSecond, reversed.transmitBytesPerSecond], [null, null]);
  assert.deepEqual(reversed.resetFields, ['receiveBytesPerSecond', 'transmitBytesPerSecond']);

  let seconds = 5, sent = 100;
  const ssh = new SshTrafficCollector({ isSsh: true,
    connectionInfo: () => ({ serverIp: '10.0.0.2', serverPort: 22, clientIp: '10.0.0.1', clientPort: 50000 }),
    commandRunner: { async execFile() {
      return { stdout: timedSshOutput(`0 0 10.0.0.2:22 10.0.0.1:50000\n cubic rtt:2/1 bytes_sent:${sent} bytes_received:50`, seconds) };
    } } });
  await ssh.collect();
  seconds = 6; sent = 300;
  assert.equal((await ssh.collect()).clientDownloadBytesPerSecond, 200);
  sent = 100;
  assert.deepEqual((await ssh.collect()).resetFields, ['clientUploadBytesPerSecond', 'clientDownloadBytesPerSecond']);
  seconds = 4;
  assert.deepEqual((await ssh.collect()).resetFields, ['clientUploadBytesPerSecond', 'clientDownloadBytesPerSecond', 'latencyMilliseconds']);
});

test('process and disk topology collectors use async command adapters', async () => {
  const processCollector = new ProcessCollector({ commandRunner: { execFile: async () => ({ stdout: '__SYSMON_PROCESSES__ 1 0\n7 root 1.0 2048 Sun Jul 13 12:34:56 2026 /bin/test --flag\n__SYSMON_SESSIONS__\n' }) }, osModule: { totalmem: () => 1024 * 1024 * 1024, cpus:() => [0,1,2,3] } });
  assert.equal((await processCollector.collect()).rows[0].processName, 'test');
  let args;
  const topologyCollector = new DiskTopologyCollector({ fileReader: { readFile: async () => mountInfo([{ target: '/data', fstype: 'ext4' }]) }, commandRunner: { execFile: async (_command, commandArgs, options) => { args = options; return { stdout: JSON.stringify({ filesystems: [{ target: '/data', fstype: 'ext4', size: 1024000, used: 512000, avail: 409600, 'use%': '56%' }] }) }; } }, getDiskConfig: () => ({ mountFilter: 'all' }) });
  assert.deepEqual(await topologyCollector.collect(), [{ mountPath: '/data', fileSystemType: 'ext4', totalBytes: 1024000, usedBytes: 512000, availableBytes: 409600, usagePercent: 56 }]);
  assert.deepEqual(queryTargets(args), ['/data']);
  assert.deepEqual(parseDfOutput('Filesystem Type 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 ext4 1000 500 400 56% /data\n', { mountFilter: 'all' }), [{ mountPath: '/data', fileSystemType: 'ext4', totalBytes: 1024000, usedBytes: 512000, availableBytes: 409600, usagePercent: 56 }]);
});

test('disk discovery includes local and NFS mounts before the first capacity snapshot', async () => {
  const table = mountInfo([{ target: '/', fstype: 'ext4' }, { target: '/data', fstype: 'xfs' }, { target: '/nfs-one', fstype: 'nfs' }, { target: '/nfs-two', fstype: 'nfs4' }]);
  const calls = [];
  const collector = new DiskTopologyCollector({ fileReader: { readFile: async () => table }, getDiskConfig: () => ({ mountFilter: 'default' }), commandRunner: {
    async execFile(command, args, options) {
      calls.push([command, args, options]);
      return { stdout: findmntOutput([{ target: '/', fstype: 'ext4' }, { target: '/data', fstype: 'xfs' }, { target: '/nfs-one', fstype: 'nfs' }, { target: '/nfs-two', fstype: 'nfs4' }]) };
    },
  } });
  const mounts = await collector.collect();
  assert.deepEqual(mounts.map((mount) => mount.mountPath), ['/', '/data', '/nfs-one', '/nfs-two']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'findmnt');
  assert.deepEqual(queryTargets(calls[0][2]), ['/', '/data', '/nfs-one', '/nfs-two']);
});

test('disk timeout and cancellation do not launch a full-filesystem fallback query', async () => {
  for (const code of ['ETIMEDOUT', 'ABORT_ERR']) {
    const commands = [];
    const collector = new DiskTopologyCollector({ fileReader: { readFile: async () => mountInfo([{ target: '/', fstype: 'ext4' }]) }, getDiskConfig: () => ({}), commandRunner: {
      async execFile(command) { commands.push(command); throw Object.assign(new Error('stopped'), { code }); },
    } });
    await assert.rejects(collector.collect(), { code });
    assert.deepEqual(commands, ['findmnt']);
  }
});


test('mounts without capacity are skipped independently of filesystem names and display modes', () => {
  const valid = [
    { target: '/', fstype: 'ext4', size: 1000, used: 400, avail: 500 },
    { target: '/nfs', fstype: 'nfs', size: 2000, used: 700, avail: 1200 },
    { target: '/new-storage', fstype: 'unrecognized-storage', size: 3000, used: 1000, avail: 2000 },
  ];
  const missing = [
    ['rpc_pipefs', '/run/rpc_pipefs'],
    ['fuse.portal', '/run/user/1000/doc'],
    ['bpf', '/sys/fs/bpf'],
    ['overlay', '/data/docker-data/overlay2/container/merged'],
    ['unrecognized-filesystem', '/unmeasurable'],
  ];
  for (const diskConfig of [
    { mountFilter: 'default' }, { mountFilter: 'more' }, { mountFilter: 'all' },
    { mountFilter: 'custom', hideVirtualFs: false },
  ]) {
    for (const capacity of [null, 0, '-']) {
      const filesystems = [...valid, ...missing.map(([fstype, target]) => ({ fstype, target, size: capacity, used: capacity, avail: capacity }))];
      const expected = ['/', '/nfs', '/new-storage'];
      assert.deepEqual(parseFindmntOutput(JSON.stringify({ filesystems }), diskConfig).map((mount) => mount.mountPath), expected);
      const df = 'Filesystem Type 1024-blocks Used Available Capacity Mounted on\n'
        + filesystems.map((entry) => ['source', entry.fstype, entry.size == null ? '-' : entry.size, entry.used == null ? '-' : entry.used, entry.avail == null ? '-' : entry.avail, '-', entry.target].join(' ')).join('\n');
      assert.deepEqual(parseDfOutput(df, diskConfig).map((mount) => mount.mountPath), expected);
    }
  }
});

test('invalid capacities in successful batch output are skipped without inventing zeros', async () => {
  const mounts = [{ target: '/', fstype: 'overlay', size: null, used: null, avail: null },
    { target: '/invalid', fstype: 'nfs', size: 1000, used: 400, avail: 'unknown' },
    { target: '/valid', fstype: 'ext4', size: 1000, used: 400, avail: 500 }];
  let calls = 0;
  const collector = new DiskTopologyCollector({ fileReader: { readFile: async () => mountInfo(mounts) },
    getDiskConfig: () => ({ mountFilter: 'all' }), commandRunner: { execFile: async () => { calls++; return { stdout: findmntOutput(mounts) }; } },
  });
  assert.deepEqual((await collector.collect()).map(value => value.mountPath), ['/valid']);
  assert.equal(calls, 1);
});

test('a failed or malformed disk batch retains the entire previous snapshot', async () => {
  const previous = [{ mountPath: '/', fileSystemType: 'ext4', totalBytes: 1000, usedBytes: 400, availableBytes: 500 }];
  for (const failure of ['command', 'io', 'malformed']) {
    const store = new SnapshotStore(); store.commit('diskTopology', previous);
    let calls = 0;
    const collector = new DiskTopologyCollector({ fileReader: { readFile: async () => mountInfo([{ target: '/', fstype: 'ext4' }, { target: '/nfs', fstype: 'nfs4' }]) },
      getDiskConfig: () => ({ mountFilter: 'all' }), commandRunner: { execFile: async () => {
        calls++;
        if (failure === 'malformed') return { stdout: 'malformed data' };
        throw Object.assign(new Error('capacity command failed: ' + failure), { code: 'EREMOTE' });
      } },
    });
    const runner = new CollectorRunner({ key: 'diskTopology', collector, snapshotStore: store, timeoutMilliseconds: 1000 });
    await runner.run(); await runner.idle;
    assert.equal(calls, 2);
    assert.equal(store.read().diskTopology.status, 'stale');
    assert.equal(store.read().diskTopology.value, previous);
    assert.ok(store.read().diskTopology.lastError.message);
  }
});

test('excluded mount paths and types are removed before a single batch command', async () => {
  const calls = [];
  const collector = new DiskTopologyCollector({
    fileReader: { readFile: async () => mountInfo([{ target: '/', fstype: 'ext4' }, { target: '/ext_workspace', fstype: 'nfs4' }, { target: '/ext_workspace/nested', fstype: 'xfs' }, { target: '/other-nfs', fstype: 'nfs' }]) },
    getDiskConfig: () => ({ mountFilter: 'custom', customPathExclude: '/ext_workspace', customFsExclude: 'nfs' }),
    commandRunner: { async execFile(command, args, options) { calls.push([command, args, options]); return { stdout: findmntOutput([{ target: '/', fstype: 'ext4' }]) }; } },
  });
  assert.deepEqual((await collector.collect()).map(value => value.mountPath), ['/']);
  assert.equal(calls.length, 1);
  assert.deepEqual(queryTargets(calls[0][2]), ['/']);
});

test('an empty filtered mount list never runs an unfiltered df command', async () => {
  const collector = new DiskTopologyCollector({ fileReader: { readFile: async () => mountInfo([{ target: '/nfs', fstype: 'nfs4' }]) },
    getDiskConfig: () => ({ mountFilter: 'custom', customPathExclude: '/nfs' }),
    commandRunner: { execFile() { assert.fail('No command should run'); } },
  });
  assert.deepEqual(await collector.collect(), []);
});

test('a missing findmnt falls back to one explicitly filtered df batch', async () => {
  const calls = [];
  const mounts = [{ target: '/', fstype: 'ext4' }, { target: '/nfs', fstype: 'nfs4' }];
  const collector = new DiskTopologyCollector({ fileReader: { readFile: async () => mountInfo(mounts) }, getDiskConfig: () => ({ mountFilter: 'all' }),
    commandRunner: { async execFile(command, args) {
      calls.push([command, args]);
      if (command === 'findmnt') throw Object.assign(new Error('findmnt not found'), { code: 127 });
      return { stdout: dfOutput(mounts) };
    } },
  });
  assert.equal((await collector.collect()).length, 2);
  assert.deepEqual(calls[1], ['df', ['-PTk', '--', '/', '/nfs']]);
  assert.equal(calls.length, 2);
});

test('a timed out disk batch keeps previous values and ignores late output', async () => {
  const previous = [{ mountPath: '/', fileSystemType: 'ext4', totalBytes: 1000, usedBytes: 400, availableBytes: 500 }];
  let release; const calls = [];
  const store = new SnapshotStore(); store.commit('diskTopology', previous);
  const collector = new DiskTopologyCollector({
    fileReader: { readFile: async () => mountInfo([{ target: '/', fstype: 'ext4' }, { target: '/nfs', fstype: 'nfs4' }, { target: '/data', fstype: 'ext4' }]) },
    getDiskConfig: () => ({ mountFilter: 'all' }), commandRunner: { execFile: async (_command, args, options) => {
      calls.push(options); return new Promise(resolve => { release = resolve; });
    } },
  });
  const runner = new CollectorRunner({ key: 'diskTopology', collector, snapshotStore: store, timeoutMilliseconds: 20 });
  await runner.run();
  assert.equal(store.read().diskTopology.lastError.code, 'ETIMEDOUT');
  assert.equal(store.read().diskTopology.value, previous);
  assert.equal(runner.startIfDue(Infinity), false);
  release({ stdout: findmntOutput([{ target: '/', fstype: 'ext4', size: 2000 }, { target: '/data', fstype: 'ext4' }]) });
  await runner.idle;
  assert.equal(store.read().diskTopology.value, previous);
  assert.equal(calls.length, 1);
  assert.deepEqual(queryTargets(calls[0]), ['/', '/nfs', '/data']);
});

test('excluding a failed target lets the next disk batch recover', async () => {
  let excluded = false; const calls = [];
  const store = new SnapshotStore();
  const mounts = [{ target: '/', fstype: 'ext4' }, { target: '/nfs', fstype: 'nfs4' }, { target: '/data', fstype: 'ext4' }];
  const collector = new DiskTopologyCollector({ fileReader: { readFile: async () => mountInfo(mounts) },
    getDiskConfig: () => ({ mountFilter: 'custom', customPathExclude: excluded ? '/nfs' : '' }),
    commandRunner: { execFile: async (_command, args, options) => {
      const selected = args.includes('--') ? args.slice(args.indexOf('--') + 1) : queryTargets(options);
      if (options?.input) calls.push(options);
      if (selected.includes('/nfs')) throw Object.assign(new Error('capacity query: /nfs: Input/output error'), { code: 'EREMOTE' });
      return { stdout: findmntOutput(mounts.filter(mount => selected.includes(mount.target))) };
    } },
  });
  const runner = new CollectorRunner({ key: 'diskTopology', collector, snapshotStore: store, timeoutMilliseconds: 1000 });
  await runner.run(); await runner.idle;
  assert.equal(store.read().diskTopology.value, null);
  assert.equal(store.read().diskTopology.lastError.code, 'EREMOTE');
  excluded = true;
  await runner.run(); await runner.idle;
  assert.equal(store.read().diskTopology.status, 'fresh');
  assert.deepEqual(store.read().diskTopology.value.map(value => value.mountPath), ['/', '/data']);
  assert.deepEqual(calls.map(queryTargets), [['/', '/nfs', '/data'], ['/', '/data']]);
});

test('changing a disk selection cancels its old query and publishes the new result on the next tick', { timeout: 2000 }, async t => {
  const { MonitorService } = require('../src/services/monitor-service');
  const { normalizeConfig } = require('../src/config/normalize-config');
  const { executionOptions } = require('../src/core/collection-context');
  const mounts = [{ target: '/', fstype: 'ext4' }, { target: '/nfs', fstype: 'nfs4' }, { target: '/data', fstype: 'ext4' }];
  const calls = [], published = []; let oldSignal, started, completed;
  const firstStarted = new Promise(resolve => { started = resolve; });
  const latestPublished = new Promise(resolve => { completed = resolve; });
  const service = new MonitorService({ runtimeConfig: normalizeConfig({ disk: { mountFilter: 'all' } }), isSsh: false,
    fileReader: { async readFile(file) { assert.equal(file, '/proc/self/mountinfo'); return mountInfo(mounts); } },
    commandRunner: { dispose() {}, async execFile(command, args, options) {
      options = executionOptions(options);
      assert.equal(command, 'findmnt'); const selected = queryTargets(options); calls.push(selected);
      if (selected.includes('/nfs')) {
        oldSignal = options.signal; started();
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
      }
      return { stdout: findmntOutput(mounts.filter(mount => selected.includes(mount.target))) };
    } },
    onSnapshot(snapshot) { published.push(snapshot); },
    onCollectionSettled(snapshot) { if (snapshot.diskTopology.status === 'fresh') completed(snapshot.diskTopology.value); },
  });
  t.after(() => service.dispose());
  const disk = service.runners.find(runner => runner.key === 'diskTopology');
  service.runners = service.scheduler.runners = [disk]; service.start(); await firstStarted;
  service.updateConfig(normalizeConfig({ disk: { mountFilter: 'custom', customPathExclude: '/nfs' } }));
  const value = await latestPublished;
  assert.equal(published.at(-1).diskTopology.value, null);
  service.scheduler.tick();
  assert.deepEqual(published.at(-1).diskTopology.value, value);
  assert.equal(oldSignal.aborted, true);
  assert.deepEqual(calls, [['/', '/nfs', '/data'], ['/', '/data']]);
  assert.deepEqual(value.map(mount => mount.mountPath), ['/', '/data']);
  assert.equal(service.readSnapshot().diskTopology.lastError, null);
});
