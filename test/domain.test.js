'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

test('CPU utilization counts guest and guest_nice time once', () => {
  const { CpuCollector } = require('../src/collectors/cpu-collector');
  const { parseCpuStat } = require('../src/domain/linux-parsers');
  const info = { coreCount:1, loadAverage:[0,0,0] };
  for (const counters of ['100 0 0 100 0 0 0 0 100 0', '0 100 0 100 0 0 0 0 0 100']) {
    const collector = new CpuCollector();
    collector.accept('cpu 0 0 0 0 0 0 0 0 0 0\n', info);
    assert.equal(collector.accept('cpu ' + counters + '\n', info).usagePercent, 50);
  }
  assert.deepEqual(parseCpuStat('cpu 1 2 3 4 5 6 7 8 9 10\n'), {idle:9,total:36});
  assert.deepEqual(parseCpuStat('cpu 1 2 3 4\n'), {idle:4,total:10});
});

test('disk counters include MMC and NVMe whole devices and exclude their partitions', () => {
  const { parseDiskIoCounters } = require('../src/domain/linux-parsers');
  const output = ['mmcblk0', 'mmcblk0p1', 'nvme0n1', 'nvme0n1p1'].map((name, index) => `8 ${index} ${name} 0 0 10 0 0 0 20 0 0 0 0`).join('\n');
  const value = parseDiskIoCounters(output);
  assert.deepEqual(value.devices, ['8:0:mmcblk0', '8:2:nvme0n1']);
  assert.equal(value.readBytes, 20 * 512);
});

const { parseProcessName } = require('../src/domain/process');
const { getAcceleratorAvailability } = require('../src/domain/accelerator-availability');
const {
  formatBytesPerSecond,
  formatDiskBytes,
  formatMemoryBytes,
  formatDuration,
  formatSize,
  formatSizePair,
} = require('../src/utils/format');

test('process name parser keeps Linux kernel thread names intact', () => {
  assert.equal(parseProcessName('[jbd2/nvme0n1p2-8]'), '[jbd2/nvme0n1p2-8]');
  assert.equal(parseProcessName('[md0_raid1]'), '[md0_raid1]');
  assert.equal(parseProcessName('[kworker/0:1 events]'), '[kworker/0:1 events]');
});

test('process name parser extracts basename only for normal executable paths', () => {
  assert.equal(parseProcessName('/usr/bin/python train.py'), 'python');
  assert.equal(parseProcessName('node server.js'), 'node');
  assert.equal(parseProcessName(''), '');
});

test('process start identity is independent of the local timezone', () => {
  const parser = JSON.stringify(require.resolve('../src/domain/linux-parsers'));
  const script = `const { parseProcessOutput } = require(${parser}); process.stdout.write(parseProcessOutput('42 user 1.0 2048 Sat Sep 26 00:00:00 2026 python', 1e9)[0].processKey);`;
  for (const TZ of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
    const key = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, TZ } });
    assert.equal(key, '42:' + Date.parse('2026-09-26T00:00:00Z'));
  }
});

test('size, rate and duration formatters use consistent binary units and one decimal', () => {
  assert.equal(formatBytesPerSecond(1024), '1.0 K/s');
  assert.equal(formatBytesPerSecond(1048576), '1.0 M/s');
  assert.equal(formatBytesPerSecond(1073741824), '1.0 G/s');
  assert.equal(formatMemoryBytes(1073741824), '1.0 G');
  assert.equal(formatDiskBytes(1099511627776), '1.0T');
  assert.equal(formatSize(0), '0.0 K');
  assert.equal(formatSize(1024 ** 5), '1024.0 T');
  assert.equal(formatSizePair(40.7 * 1024 ** 3, 80 * 1024 ** 3), '40.7 / 80.0G');
  assert.equal(formatSizePair(512 * 1024 ** 2, 80 * 1024 ** 3), '512.0M / 80.0G');
  assert.equal(formatSizePair(NaN, 80 * 1024 ** 3), '— / 80.0G');
  assert.equal(formatDuration(9.8), '9.8 ms');
  assert.equal(formatDuration(1000), '1.0 s');
  assert.equal(formatDuration(60000), '1.0 m');
  assert.equal(formatDuration(3600000), '1.0 h');
});

test('accelerator availability has one shared idle policy and preserves unknown capability', () => {
  assert.equal(getAcceleratorAvailability(false, true), 'idle');
  assert.equal(getAcceleratorAvailability(true, true), 'busy');
  assert.equal(getAcceleratorAvailability(false, false), 'unknown');
  assert.equal(getAcceleratorAvailability(true, false), 'unknown');
});

test('common collection error codes have localized messages that keep useful details', () => {
  const { catalogs, localizeError } = require('../src/i18n');
  const codes = ['EINCOMPLETE', 'EREMOTE', 'EPLATFORM', 'EMAXBUFFER', 'ENOENT', 'PS_UNSUPPORTED'];
  for (const language of Object.keys(catalogs)) {
    const messages = codes.map(code => localizeError({ code, message: 'detail text' }, language));
    assert.equal(new Set(messages).size, codes.length, language);
    for (const message of messages) assert.ok(message && message !== 'detail text', language + ': ' + message);
  }
  assert.equal(localizeError({ code: 'EREMOTE', message: 'ps: bad -o argument' }, 'en'), 'Remote command failed: ps: bad -o argument');
  assert.equal(localizeError({ code: 'ENOENT', message: 'spawn findmnt ENOENT' }, 'zh-CN'), '缺少所需的命令或文件：spawn findmnt ENOENT');
  assert.equal(localizeError({ code: 'EREMOTE', message: '' }, 'zh-TW'), '遠端命令執行失敗');
  assert.equal(localizeError({ code: 'EPLATFORM', message: 'Remote host is not Linux' }, 'zh-CN'), '服务器不是 Linux 系统');
  assert.equal(localizeError({ code: 'UNKNOWN', message: 'raw detail' }, 'zh-CN'), 'raw detail');
});
