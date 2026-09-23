'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { parseDefaultRouteInterfaces, parseNetworkCounters, parseProcessOutput } = require('../src/domain/linux-parsers');
const { parseNvidiaCards, parseNvidiaProcesses } = require('../src/accelerators/nvidia-provider');
const { NvidiaProvider } = require('../src/accelerators/nvidia-provider');
const { parseSshByteCounters, SshTrafficCollector } = require('../src/collectors/ssh-traffic-collector');
const { CpuCollector } = require('../src/collectors/cpu-collector');
const { MemoryCollector } = require('../src/collectors/memory-collector');
const { NetworkCollector } = require('../src/collectors/network-collector');
const { DiskIoCollector } = require('../src/collectors/disk-io-collector');
const { ProcessCollector } = require('../src/collectors/process-collector');
const { DiskTopologyCollector } = require('../src/collectors/disk-topology-collector');

test('network parser selects default-route interfaces and avoids bridge/veth double counting', () => {
  const routes = 'Iface Destination Gateway Flags RefCnt Use Metric Mask\neth0 00000000 01010101 0003 0 0 0 00000000\ndocker0 0000A8C0 00000000 0001 0 0 0 00FFFFFF\n';
  const devices = 'Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\neth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0\ndocker0: 500 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0\nveth1: 500 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0\n';
  const selected = parseDefaultRouteInterfaces(routes);
  assert.deepEqual([...selected], ['eth0']);
  assert.deepEqual(parseNetworkCounters(devices, selected), { receiveBytes: 1000, transmitBytes: 2000, availableInterfaces: ['eth0', 'docker0', 'veth1'] });
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

test('SSH counters and TCP RTT are parsed for the selected client', () => {
  const raw = 'ESTAB 0 0 10.0.0.2:22 10.0.0.1:50000\n cubic rtt:12.5/2.0 bytes_sent:2000 bytes_received:1000\n';
  assert.deepEqual(parseSshByteCounters(raw, '10.0.0.1'), { serverSentBytes: 2000, serverReceivedBytes: 1000, latencyMilliseconds: 12.5 });
});

test('SSH collector requests numeric socket addresses so port 22 can be matched', async () => {
  let args;
  const collector = new SshTrafficCollector({
    isSsh: true,
    clientIp: '10.0.0.1',
    commandRunner: { execFile: async (_command, commandArgs) => { args = commandArgs; return { stdout: 'ESTAB 0 0 10.0.0.2:22 10.0.0.1:50000\n cubic rtt:9.1/1.0 bytes_sent:10 bytes_received:20\n' }; } },
    monotonicClock: () => 1000,
  });
  const result = await collector.collect();
  assert.equal(args.includes('-n'), true);
  assert.equal(result.latencyMilliseconds, 9.1);
});

test('NVIDIA provider exposes cards and processes only after the complete atomic chain', async () => {
  const calls = [];
  const commandRunner = {
    async execFile(command, args) {
      calls.push([command, args[0]]);
      if (command === 'getconf') return { stdout: '100\n' };
      if (args[0].startsWith('--query-gpu')) return { stdout: '0, A100, 10, 100, 1000, 45, 50, 300, GPU-a' };
      return { stdout: '22, GPU-a, 100' };
    },
  };
  const fileReader = {
    async readFile(filePath) {
      if (filePath === '/proc/stat') return 'btime 1000\n';
      if (filePath.endsWith('/stat')) { const fields = Array(20).fill('0'); fields[0] = 'S'; fields[19] = '200'; return `22 (python) ${fields.join(' ')}`; }
      return 'Uid:\t1000\n';
    },
  };
  const result = await new NvidiaProvider({ commandRunner, fileReader, userId: 1000 }).collect();
  assert.equal(result.devices.length, 1);
  assert.equal(result.usagesByPid.get(22)[0].mappingStatus, 'matched');
  assert.equal(result.usagesByPid.get(22)[0].processKey, '22:1002000');
  assert.deepEqual(calls.filter(([command]) => command === 'nvidia-smi').length, 2);
});

test('GPU process key matches ps lstart when the kernel start tick has a fractional second', async () => {
  const commandRunner = {
    async execFile(command, args) {
      if (command === 'getconf') return { stdout: '100\n' };
      if (args[0].startsWith('--query-gpu')) return { stdout: '0, A100, 10, 100, 1000, 45, 50, 300, GPU-a' };
      return { stdout: '22, GPU-a, 100' };
    },
  };
  const fileReader = {
    async readFile(filePath) {
      if (filePath === '/proc/stat') return 'btime 1000\n';
      if (filePath.endsWith('/stat')) {
        const fields = Array(20).fill('0'); fields[0] = 'S'; fields[19] = '259';
        return `22 (python) ${fields.join(' ')}`;
      }
      return 'Uid:\t1000\n';
    },
  };
  const result = await new NvidiaProvider({ commandRunner, fileReader, userId: 1000 }).collect();
  assert.equal(result.usagesByPid.get(22)[0].processKey, '22:1002000');
});

test('CPU and memory collectors expose normalized independent snapshots', async () => {
  const cpuReads = ['cpu  10 0 10 80 0 0 0 0\n', 'cpu  20 0 20 160 0 0 0 0\n'];
  const cpu = new CpuCollector({ fileReader: { readFile: async () => cpuReads.shift() }, osModule: { loadavg: () => [1, 2, 3], cpus: () => [{}, {}] } });
  assert.equal((await cpu.collect()).usagePercent, null);
  assert.equal((await cpu.collect()).usagePercent, 20);
  const memory = new MemoryCollector({ fileReader: { readFile: async () => 'MemTotal: 1000 kB\nMemAvailable: 400 kB\n' } });
  assert.deepEqual(await memory.collect(), { totalBytes: 1024000, availableBytes: 409600, usedBytes: 614400, usagePercent: 60 });
});

test('network and disk I/O collectors calculate rates only after a valid baseline', async () => {
  let now = 0;
  const networkReads = [
    'Inter-| Receive | Transmit\n face |x\neth0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\n',
    'Iface Destination Gateway Flags\neth0 00000000 0 0003\n',
    'Inter-| Receive | Transmit\n face |x\neth0: 300 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0\n',
    'Iface Destination Gateway Flags\neth0 00000000 0 0003\n',
  ];
  const network = new NetworkCollector({ fileReader: { readFile: async () => networkReads.shift() }, monotonicClock: () => now });
  assert.equal((await network.collect()).receiveBytesPerSecond, null); now = 1000;
  assert.equal((await network.collect()).receiveBytesPerSecond, 200);
  const diskReads = ['8 0 sda 0 0 10 0 0 0 20 0 0 0 0\n', '8 0 sda 0 0 12 0 0 0 24 0 0 0 0\n']; now = 0;
  const disk = new DiskIoCollector({ fileReader: { readFile: async () => diskReads.shift() }, monotonicClock: () => now });
  assert.equal((await disk.collect()).readBytesPerSecond, null); now = 1000;
  assert.equal((await disk.collect()).readBytesPerSecond, 1024);
});

test('process and disk topology collectors use async command adapters', async () => {
  const processCollector = new ProcessCollector({ commandRunner: { execFile: async () => ({ stdout: '7 root 1.0 2048 Sun Jul 13 12:34:56 2026 /bin/test --flag\n' }) }, osModule: { totalmem: () => 1024 * 1024 * 1024 } });
  assert.equal((await processCollector.collect())[0].processName, 'test');
  const topologyCollector = new DiskTopologyCollector({ commandRunner: { execFile: async () => ({ stdout: JSON.stringify({ filesystems: [{ fstype: 'ext4', size: 1000, used: 500, 'use%': '50%', target: '/data' }] }) }) }, getDiskConfig: () => ({ mountFilter: 'all' }) });
  assert.deepEqual(await topologyCollector.collect(), [{ mountPath: '/data', fileSystemType: 'ext4', totalBytes: 1000, usedBytes: 500, usagePercent: 50 }]);
});
