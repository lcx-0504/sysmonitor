'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { DEFAULT_CONFIG } = require('../src/config/default-config');
const { normalizeConfig } = require('../src/config/normalize-config');
const { ConfigStore } = require('../src/config/config-store');

test('legacy partial objects are deeply completed without changing explicit values', () => {
  const normalized = normalizeConfig({
    refreshInterval: 3,
    statusBar: {
      ram: false,
      gpu: { summary: false },
    },
    display: { charts: false },
  });

  assert.equal(normalized.refreshInterval, 3);
  assert.equal(normalized.statusBar.ram, false);
  assert.equal(normalized.statusBar.cpu, true);
  assert.equal(normalized.statusBar.gpu.summary, false);
  assert.equal(normalized.statusBar.gpu.metric, 'both');
  assert.equal(normalized.display.charts, false);
  assert.equal(normalized.display.sparkMinutes, 5);
  assert.equal(normalized.display.tabularNums, true);
  assert.equal(normalized.display.showGpuUsers, true);
  assert.equal(normalized.display.showGpuPicker, true);
  assert.equal(normalized.display.hiddenGroups.system, false);
});

test('unknown fields survive in-memory normalization for forward and downgrade compatibility', () => {
  const normalized = normalizeConfig({
    futureTopLevel: 'keep',
    statusBar: {
      futureStatusField: 42,
      gpu: { futureProviderOption: true },
    },
    disk: { futureDiskOption: 'keep' },
  });

  assert.equal(normalized.futureTopLevel, 'keep');
  assert.equal(normalized.statusBar.futureStatusField, 42);
  assert.equal(normalized.statusBar.gpu.futureProviderOption, true);
  assert.equal(normalized.disk.futureDiskOption, 'keep');
});

test('invalid values are normalized and GPU card preferences are not clipped to current hardware', () => {
  const normalized = normalizeConfig({
    refreshInterval: 100,
    statusBar: {
      alignment: 'center',
      diskIO: 'invalid',
      net: 'invalid',
      gpu: {
        cards: [7, 1, 7, -1, 2.5, '3'],
        firstN: 0,
        mode: 'invalid',
      },
    },
    display: { sparkMinutes: -5 },
  });

  assert.equal(normalized.refreshInterval, 30);
  assert.equal(normalized.statusBar.alignment, DEFAULT_CONFIG.statusBar.alignment);
  assert.equal(normalized.statusBar.diskIO, 'off');
  assert.equal(normalized.statusBar.net, 'off');
  assert.deepEqual(normalized.statusBar.gpu.cards, [1, 7]);
  assert.equal(normalized.statusBar.gpu.firstN, 1);
  assert.equal(normalized.statusBar.gpu.mode, 'off');
  assert.equal(normalized.display.sparkMinutes, 1);
});

test('legacy string disk filter is migrated in memory', () => {
  const normalized = normalizeConfig({ disk: 'vfat,/proc' });
  assert.deepEqual(normalized.disk, {
    mountFilter: 'vfat,/proc',
    hideParentMounts: true,
  });
});

test('ConfigStore writes normalized values globally and does not write during reads', async () => {
  const stored = {
    refreshInterval: 2,
    statusBar: { cpu: false },
    disk: undefined,
    display: undefined,
  };
  const updates = [];
  const vscode = {
    workspace: {
      getConfiguration(section) {
        assert.equal(section, 'sysmonitor');
        return {
          get: (key) => stored[key],
          update: async (key, value, target) => {
            updates.push({ key, value, target });
            stored[key] = value;
          },
        };
      },
    },
  };

  const configStore = new ConfigStore({ vscode, flushDelayMilliseconds: 60_000 });
  const config = configStore.read();
  assert.equal(config.statusBar.cpu, false);
  assert.equal(config.statusBar.ram, true);
  assert.deepEqual(updates, []);

  configStore.update('refreshInterval', 7);
  configStore.update('statusBar', { ...config.statusBar, ram: false });
  await configStore.flush();

  assert.deepEqual(updates.map(({ key, target }) => ({ key, target })), [
    { key: 'refreshInterval', target: true },
    { key: 'statusBar', target: true },
  ]);
  assert.equal(stored.refreshInterval, 7);
  assert.equal(stored.statusBar.ram, false);
  configStore.dispose();
});

test('ConfigStore restores dirty keys after a failed write and always releases writing state', async () => {
  let shouldFail = true;
  const errors = [];
  const vscode = {
    workspace: {
      getConfiguration() {
        return {
          get: () => undefined,
          update: async () => {
            if (shouldFail) throw new Error('write failed');
          },
        };
      },
    },
  };

  const configStore = new ConfigStore({ vscode, onError: (error) => errors.push(error), flushDelayMilliseconds: 60_000 });
  configStore.update('refreshInterval', 5);
  await assert.rejects(configStore.flush(), /write failed/);
  assert.equal(configStore.isWriting, false);
  assert.equal(configStore.dirtyKeys.has('refreshInterval'), true);

  shouldFail = false;
  await configStore.flush();
  assert.equal(configStore.dirtyKeys.size, 0);
  assert.deepEqual(errors, []);
  configStore.dispose();
});
