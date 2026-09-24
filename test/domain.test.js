'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseProcessName } = require('../src/domain/process');
const { getAcceleratorAvailability } = require('../src/domain/accelerator-availability');
const {
  formatBytesPerSecond,
  formatBytesPerSecondShort,
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

test('size, rate and duration formatters use consistent binary units and one decimal', () => {
  assert.equal(formatBytesPerSecond(1024), '1.0 K/s');
  assert.equal(formatBytesPerSecond(1048576), '1.0 M/s');
  assert.equal(formatBytesPerSecond(1073741824), '1.0 G/s');
  assert.equal(formatBytesPerSecondShort(1024), '1.0K/s');
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
  assert.equal(getAcceleratorAvailability({ utilizationPercent: 4, memory: { usedBytes: 9, totalBytes: 100 } }), 'idle');
  assert.equal(getAcceleratorAvailability({ utilizationPercent: 5, memory: { usedBytes: 0, totalBytes: 100 } }), 'busy');
  assert.equal(getAcceleratorAvailability({ utilizationPercent: null, memory: { usedBytes: 0, totalBytes: 100 } }), 'unknown');
});
