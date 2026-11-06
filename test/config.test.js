'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { collectionPolicy } = require('../src/services/collection-policy');
const { effectiveTimeouts } = require('../src/services/collection-policy');

test('manifest and UI descriptors share the same collection defaults and bounds', () => {
  const properties = require('../package.json').contributes.configuration.properties;
  const { REFRESH_SETTING, COLLECTION_FIELDS } = require('../src/config/default-config');
  const refresh = properties['sysmonitor.refreshInterval'];
  for (const key of ['default', 'minimum', 'maximum']) assert.equal(refresh[key], REFRESH_SETTING[key]);
  const timeouts = properties['sysmonitor.timeouts'];
  for (const field of COLLECTION_FIELDS) {
    assert.equal(timeouts.default[field.key], field.default);
    for (const key of ['minimum', 'maximum']) assert.equal(timeouts.properties[field.key][key], field[key]);
  }
  for (const property of Object.values(properties)) assert.equal(property.scope, 'application');
  const keywords = require('../package.json').keywords;
  assert.ok(keywords.includes('server')); assert.ok(keywords.includes('ssh')); assert.ok(keywords.length <= 30);
});

test('SSH pool settings use bounded integers and follow the custom policy switch', () => {
  for (const [raw, expected] of [[0, 1], [9, 8], [2.6, 3], [null, 4]]) {
    const config = normalizeConfig({ timeouts: { enabled: true, sshPoolSize: raw } });
    assert.equal(config.timeouts.sshPoolSize, expected);
    assert.equal(effectiveTimeouts(config).sshPoolSize, expected);
    config.timeouts.enabled = false;
    assert.equal(effectiveTimeouts(config).sshPoolSize, 4);
    assert.equal(config.timeouts.sshPoolSize, expected);
  }
});

test('timeout defaults, validation, and shared module budgets', () => {
  const defaults = normalizeConfig({});
  assert.deepEqual(defaults.timeouts, { enabled: false, connection: 15, standard: 10, extended: 30, sshPoolSize: 4 });
  const config = normalizeConfig({ timeouts: { enabled: true, connection: 1, standard: 20.6, extended: 150 } });
  assert.deepEqual(config.timeouts, { enabled: true, connection: 5, standard: 21, extended: 120, sshPoolSize: 4 });
  const policy = collectionPolicy(config);
  assert.equal(policy.resources.timeoutMilliseconds, 21000);
  assert.equal(policy.diskTopology.timeoutMilliseconds, 120000);
  assert.equal(policy.processes.timeoutMilliseconds, 120000);
  assert.equal(policy.accelerators.timeoutMilliseconds, 120000);
  assert.equal(policy.diskTopology.minimumIntervalMilliseconds, 10000);
  config.timeouts.enabled = false;
  assert.equal(collectionPolicy(config).resources.timeoutMilliseconds, 10000);
  assert.equal(collectionPolicy(config).accelerators.timeoutMilliseconds, 30000);
  assert.equal(config.timeouts.extended, 120);
});

const { DEFAULT_CONFIG } = require('../src/config/default-config');
const { normalizeConfig } = require('../src/config/normalize-config');

test('the upgrade entry adds a policy switch while normalization uses explicit current settings', () => {
  const { upgradeSetting } = require('../src/config/upgrade-config');
  const timeouts = { connection:20, standard:15, extended:40 };
  assert.equal(upgradeSetting('timeouts', timeouts).enabled, true);
  assert.equal(upgradeSetting('timeouts', { connection:15, standard:10, extended:30 }).enabled, false);
  assert.equal(upgradeSetting('timeouts', { enabled:false, ...timeouts }), null);
  assert.equal(normalizeConfig({ timeouts }).timeouts.enabled, false);
  assert.equal(normalizeConfig({ timeouts:upgradeSetting('timeouts', timeouts) }).timeouts.enabled, true);
});
const { ConfigStore } = require('../src/config/config-store');
function updateSetting(store, key, value) {
  const changes = [];
  const visit = (value, path) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
    else changes.push({ path, value });
  };
  visit(value, []);
  return store.update(key, changes);
}

const { setActionVisibilityContexts } = require('../src/view/action-visibility');

function scopedSettings(global = {}, workspace = {}, folders = {}) {
  const { DEFAULT_CONFIG } = require('../src/config/default-config');
  const writes = [];
  const targets = { Global:1, Workspace:2, WorkspaceFolder:3 };
  const configuration = uri => ({
    inspect: key => ({ defaultValue:DEFAULT_CONFIG[key], globalValue:global[key], workspaceValue:workspace[key], workspaceFolderValue:folders[uri]?.[key] }),
    get() { throw new Error('merged configuration should not be read'); },
    async update(key, value, target) {
      writes.push({ key, value, target, uri });
      const destination = target === true || target === targets.Global ? global : target === targets.Workspace ? workspace : folders[uri];
      destination[key] = value;
    },
  });
  const vscode = { ConfigurationTarget:targets, workspace:{
    workspaceFolders:Object.keys(folders).map(uri => ({ uri })),
    getConfiguration(section, uri) { assert.equal(section, 'sysmonitor'); assert.equal(uri, undefined); return configuration(uri); },
  } };
  return { vscode, writes, global, workspace, folders };
}

test('configuration upgrade only changes user settings and preserves unrelated fields', async () => {
  const fixture = scopedSettings(
    { disk:{ mountFilter:'custom', showVirtualFs:false, customFsExclude:'vfat', future:7 },
      display:{ charts:false, hiddenGroups:{ system:true, cpu:false, disk:true } },
      timeouts:{ standard:20 } },
    { disk:{ showVirtualFs:true, hideVirtualFs:true, customPathExclude:'/nfs' },
      display:{ hiddenGroups:{ system:false, memory:true } }, timeouts:{ standard:10 } },
    { a:{ disk:{ showVirtualFs:true }, timeouts:{ enabled:false, extended:60 } },
      b:{ display:{ hiddenGroups:{ system:true } }, timeouts:{ extended:60 } } },
  );
  const originalWorkspace = structuredClone(fixture.workspace), originalFolders = structuredClone(fixture.folders);
  const store = new ConfigStore({ vscode:fixture.vscode });
  await store.upgrade();
  assert.deepEqual(fixture.global.disk, { mountFilter:'custom', hideVirtualFs:true, customFsExclude:'vfat', future:7 });
  assert.deepEqual(fixture.workspace, originalWorkspace);
  assert.deepEqual(fixture.folders, originalFolders);
  assert.deepEqual(fixture.global.display, { charts:false, hiddenGroups:{ cpu:false, memory:true, disk:true } });
  assert.equal(fixture.global.timeouts.enabled, true);
  assert.equal(store.getCurrent().timeouts.enabled, true);
  assert.deepEqual(fixture.writes.map(({key,target,uri}) => [key,target,uri]), [
    ['disk',true,undefined], ['display',true,undefined], ['timeouts',true,undefined],
  ]);
  const count = fixture.writes.length;
  await store.upgrade(); assert.equal(fixture.writes.length, count);
  fixture.global.display.hiddenGroups.cpu = true;
  assert.equal(store.refresh().display.hiddenGroups.cpu, true);
  store.dispose();
});

test('new installations and canonical saved settings require no configuration writes', async () => {
  const { upgradeConfiguration } = require('../src/config/upgrade-config');
  for (const global of [{}, { disk:{ hideVirtualFs:false }, display:{ hiddenGroups:{ cpu:true, memory:false } }, timeouts:{ enabled:false, standard:20 } }]) {
    const fixture = scopedSettings(global);
    await upgradeConfiguration(fixture.vscode); assert.deepEqual(fixture.writes, []);
  }
  const fixture = scopedSettings({}, { disk:{ showVirtualFs:true }, timeouts:{ standard:20 } }, { a:{ display:{ hiddenGroups:{ system:true } } } });
  await upgradeConfiguration(fixture.vscode); assert.deepEqual(fixture.writes, []);
  const store = new ConfigStore({ vscode:fixture.vscode });
  assert.deepEqual(store.read(), normalizeConfig({}));
});

test('user reads, external updates and writes ignore workspace overrides', async () => {
  const { upgradeConfiguration } = require('../src/config/upgrade-config');
  const fixture = scopedSettings({ refreshInterval:5, timeouts:{ enabled:false, standard:20 } },
    { refreshInterval:60, timeouts:{ enabled:true, extended:60 }, display:{ charts:false } });
  await upgradeConfiguration(fixture.vscode);
  assert.deepEqual(fixture.writes, []);
  fixture.global.timeouts.enabled = true;
  const store = new ConfigStore({ vscode:fixture.vscode});
  assert.equal(store.read().timeouts.enabled, true);
  assert.equal(store.getCurrent().refreshInterval, 5);
  assert.equal(store.getCurrent().display.charts, true);
  fixture.global.refreshInterval = 10;
  assert.equal(store.refresh().refreshInterval, 10);
  updateSetting(store, 'refreshInterval', 2); await store.flush();
  assert.equal(fixture.global.refreshInterval, 2); assert.equal(fixture.workspace.refreshInterval, 60);
  assert.equal(fixture.writes.at(-1).target, true); store.dispose();
});

test('virtual filesystem renaming preserves filtering decisions in every disk mode', () => {
  const { upgradeSetting } = require('../src/config/upgrade-config');
  const { shouldExclude } = require('../src/domain/disk');
  for (const mountFilter of ['default','more','all','custom']) for (const showVirtualFs of [false,true]) {
    const disk = upgradeSetting('disk', { mountFilter, showVirtualFs });
    assert.equal(disk.hideVirtualFs, !showVirtualFs);
    assert.equal(Object.hasOwn(disk, 'showVirtualFs'), false);
    assert.equal(shouldExclude('tmpfs', '/data', disk), mountFilter !== 'all' && (mountFilter !== 'custom' || !showVirtualFs));
    assert.equal(shouldExclude('ext4', '/data', disk), false);
    assert.equal(upgradeSetting('disk', disk), null);
  }
});

test('failed user upgrades remain retryable and do not process workspace settings', async () => {
  const { upgradeConfiguration } = require('../src/config/upgrade-config');
  const fixture = scopedSettings({ timeouts:{ standard:20 } }, { timeouts:{ standard:10 } });
  const getConfiguration = fixture.vscode.workspace.getConfiguration;
  let fail = true;
  fixture.vscode.workspace.getConfiguration = (...args) => {
    const config = getConfiguration(...args), update = config.update;
    config.update = async (key, value, target) => {
      if (fail) throw new Error('settings unavailable');
      await update(key, value, target);
    };
    return config;
  };
  await assert.rejects(upgradeConfiguration(fixture.vscode), /settings unavailable/);
  assert.deepEqual(fixture.global.timeouts, { standard:20 });
  fail = false; await upgradeConfiguration(fixture.vscode);
  assert.deepEqual(fixture.workspace.timeouts, { standard:10 }); assert.equal(fixture.global.timeouts.enabled, true);
});

test('remote window behavior defaults to menu and accepts exactly the three supported modes', () => {
  assert.equal(normalizeConfig({}).servers.remoteWindowMode, 'menu');
  for (const mode of ['new', 'recent', 'menu']) assert.equal(normalizeConfig({ servers: { remoteWindowMode: mode } }).servers.remoteWindowMode, mode);
  for (const mode of [undefined, null, true, 'unknown']) assert.equal(normalizeConfig({ servers: { remoteWindowMode: mode } }).servers.remoteWindowMode, 'menu');
});

test('action button settings default on and drive all four native toolbar contexts', () => {
  const calls = [];
  const vscode = { commands: { executeCommand: (...args) => calls.push(args) } };
  const defaults = setActionVisibilityContexts(vscode, normalizeConfig({}).servers);
  assert.deepEqual(calls, [
    ['setContext', 'sysmonitor.actionEditorVisible', true],
    ['setContext', 'sysmonitor.actionWindowVisible', true],
    ['setContext', 'sysmonitor.actionTerminalVisible', true],
    ['setContext', 'sysmonitor.actionRemoteWindowVisible', true],
  ]);
  calls.length = 0;
  setActionVisibilityContexts(vscode, normalizeConfig({}).servers, defaults);
  assert.deepEqual(calls, []);
  setActionVisibilityContexts(vscode, normalizeConfig({ servers: { actions: { editor: false, remoteWindow: false } } }).servers, defaults);
  assert.deepEqual(calls, [
    ['setContext', 'sysmonitor.actionEditorVisible', false],
    ['setContext', 'sysmonitor.actionRemoteWindowVisible', false],
  ]);
});

test('partial objects are deeply completed without changing explicit values', () => {
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
  assert.equal(normalized.display.hiddenGroups.cpu, false);
  assert.equal(normalized.display.hiddenGroups.memory, false);
});

test('legacy CPU and memory visibility migrates to independent settings', () => {
  const { upgradeSetting } = require('../src/config/upgrade-config');
  const legacy = normalizeConfig({ display: upgradeSetting('display', { hiddenGroups: { system:true } }) });
  assert.equal(legacy.display.hiddenGroups.cpu, true);
  assert.equal(legacy.display.hiddenGroups.memory, true);
  const mixed = normalizeConfig({ display: upgradeSetting('display', { hiddenGroups: { system:true, cpu:false } }) });
  assert.equal(mixed.display.hiddenGroups.cpu, false);
  assert.equal(mixed.display.hiddenGroups.memory, true);
  assert.equal(Object.hasOwn(mixed.display.hiddenGroups, 'system'), false);
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

  assert.equal(normalized.refreshInterval, 60);
  assert.equal(normalized.statusBar.alignment, DEFAULT_CONFIG.statusBar.alignment);
  assert.equal(normalized.statusBar.diskIO, 'off');
  assert.equal(normalized.statusBar.net, 'off');
  assert.deepEqual(normalized.statusBar.gpu.cards, [1, 7]);
  assert.equal(normalized.statusBar.gpu.firstN, 1);
  assert.equal(normalized.statusBar.gpu.mode, 'off');
  assert.equal(normalized.display.sparkMinutes, 1);
});

test('disk settings accept only the declared object and mount filter modes', () => {
  for (const raw of ['vfat,/proc', 'custom', null, 42]) assert.deepEqual(normalizeConfig({ disk: raw }).disk, { mountFilter:'default', hideVirtualFs:true, hideParentMounts:true });
  assert.equal(normalizeConfig({ disk: { mountFilter:'vfat,/proc' } }).disk.mountFilter, 'default');
  for (const mountFilter of ['default', 'more', 'all', 'custom']) assert.equal(normalizeConfig({ disk:{ mountFilter } }).disk.mountFilter, mountFilter);
});

test('custom filesystem and path fields retain comma and multiline rules', () => {
  const { shouldExclude } = require('../src/domain/disk');
  const disk = normalizeConfig({ disk:{ mountFilter:'custom', customFsExclude:'vfat\nntfs', customPathExclude:'/proc,/cache\n/nfs' } }).disk;
  for (const [fs, mount] of [['vfat','/boot'],['ntfs','/windows'],['ext4','/cache/child'],['ext4','/proc'],['nfs4','/nfs/data']]) assert.equal(shouldExclude(fs, mount, disk), true);
  assert.equal(shouldExclude('ext4','/data',disk),false);
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
          inspect: (key) => ({ globalValue:stored[key] }),
          update: async (key, value, target) => {
            updates.push({ key, value, target });
            stored[key] = value;
          },
        };
      },
    },
  };

  const configStore = new ConfigStore({ vscode});
  const config = configStore.read();
  assert.equal(config.statusBar.cpu, false);
  assert.equal(config.statusBar.ram, true);
  assert.deepEqual(updates, []);

  updateSetting(configStore, 'refreshInterval', 7);
  updateSetting(configStore, 'statusBar', { ...config.statusBar, ram: false });
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
  const written = [];
  const vscode = {
    workspace: {
      getConfiguration() {
        return {
          inspect: () => undefined,
          update: async (key) => {
            written.push(key);
            if (shouldFail) throw new Error('write failed');
          },
        };
      },
    },
  };

  const configStore = new ConfigStore({ vscode, onError: (error) => errors.push(error)});
  updateSetting(configStore, 'refreshInterval', 5);
  await assert.rejects(configStore.flush(), /write failed/);
  assert.equal(configStore.getSaveState().status, 'error');

  shouldFail = false;
  await configStore.flush();
  assert.equal(configStore.getSaveState().status, 'saved');
  await configStore.flush();
  assert.deepEqual(written, ['refreshInterval', 'refreshInterval']);
  assert.deepEqual(errors.map(error => error.message), ['write failed']);
  configStore.dispose();
});

test('ConfigStore serializes updates made while a write is pending', async () => {
  const writes = [];
  const stored = {};
  const store = new ConfigStore({
    vscode: { workspace: { getConfiguration: () => ({
      inspect: (key) => ({ globalValue:stored[key] }),
      update: (key, value) => new Promise((resolve) => {
        writes.push({ value, finish() { stored[key] = value; resolve(); } });
      }),
    }) } },
  });
  updateSetting(store, 'refreshInterval', 3);
  const firstFlush = store.flush();
  await new Promise(setImmediate);
  updateSetting(store, 'refreshInterval', 7);
  const secondFlush = store.flush();
  assert.equal(secondFlush, firstFlush);
  assert.deepEqual(writes.map((write) => write.value), [3]);
  writes[0].finish();
  await new Promise(setImmediate);
  assert.equal(store.getSaveState().status, 'saving');
  assert.deepEqual(writes.map((write) => write.value), [3, 7]);
  writes[1].finish();
  await secondFlush;
  assert.equal(stored.refreshInterval, 7);
  assert.equal(store.getSaveState().status, 'saved');
  await store.flush();
  assert.deepEqual(writes.map((write) => write.value), [3, 7]);
  store.dispose();
});

test('ConfigStore refresh preserves pending edits and reads other external changes', async () => {
  const stored = { refreshInterval: 2, display: { charts: true } };
  const store = new ConfigStore({
    vscode: { workspace: { getConfiguration: () => ({
      inspect: (key) => ({ globalValue:stored[key] }), update: async (key, value) => { stored[key] = value; },
    }) } },
  });
  updateSetting(store, 'refreshInterval', 7);
  stored.display = { charts: false };
  const refreshed = store.refresh();
  assert.equal(refreshed.refreshInterval, 7);
  assert.equal(refreshed.display.charts, false);
  await store.flush();
  assert.equal(stored.refreshInterval, 7);
  store.dispose();
});

test('ConfigStore waits for all writes to settle and retries only failed keys', async () => {
  let finishDisplay;
  let shouldFail = true;
  const written = [];
  const store = new ConfigStore({
    vscode: { workspace: { getConfiguration: () => ({
      inspect: () => undefined,
      update: (key) => {
        written.push(key);
        if (key === 'refreshInterval' && shouldFail) throw new Error('write failed');
        if (key === 'display') return new Promise((resolve) => { finishDisplay = resolve; });
        return Promise.resolve();
      },
    }) } },
  });
  updateSetting(store, 'refreshInterval', 7);
  updateSetting(store, 'display', { charts: false });
  const flush = store.flush();
  const rejected = assert.rejects(flush, /write failed/);
  await new Promise(setImmediate);
  assert.equal(store.getSaveState().status, 'saving');
  assert.equal(store.flush(), flush);
  finishDisplay();
  await rejected;
  shouldFail = false;
  await store.flush();
  assert.deepEqual(written, ['refreshInterval', 'display', 'refreshInterval']);
  store.dispose();
});

test('external changes remain visible during writes and the final read reconciles saved settings', async () => {
  const stored = { refreshInterval:2, display:{charts:true} }, changes = []; let finish;
  const store = new ConfigStore({ vscode:{ workspace:{ getConfiguration:() => ({
    inspect:key => ({globalValue:stored[key]}), update:(key,value) => new Promise(resolve => { finish=()=>{stored[key]=value;resolve();}; }),
  }) } } });
  store.read(); store.onDidChange(config=>changes.push(config.display.charts));
  updateSetting(store, 'refreshInterval',5); const writing=store.flush(); await new Promise(setImmediate);
  stored.display={charts:false}; store.refresh();
  assert.equal(store.getCurrent().refreshInterval,5); assert.equal(store.getCurrent().display.charts,false);
  finish(); await writing; assert.deepEqual(changes,[true,false]); store.dispose();
});

test('a failed settings migration still exposes canonical values and reports the save failure', async () => {
  const fixture=scopedSettings({disk:{showVirtualFs:true},display:{hiddenGroups:{system:true}},timeouts:{standard:20}});
  const get=fixture.vscode.workspace.getConfiguration; const errors=[];
  fixture.vscode.workspace.getConfiguration=(...args)=>({...get(...args),update:async()=>{throw new Error('read only');}});
  const store=new ConfigStore({vscode:fixture.vscode,onUpgradeError:error=>errors.push(error.message)});
  await store.upgrade();
  assert.equal(store.getCurrent().disk.hideVirtualFs,false); assert.equal(store.getCurrent().display.hiddenGroups.memory,true);
  assert.equal(store.getCurrent().timeouts.enabled,true); assert.deepEqual(errors,['read only']); store.dispose();
});

test('manifest field schemas match the shared normalization definitions', () => {
  const { manifestConfiguration } = require('../src/config/config-schema');
  assert.deepEqual(require('../package.json').contributes.configuration.properties, manifestConfiguration());
  const disk = normalizeConfig({ disk: { customFsExclude: 123, customPathExclude: ['/work'] } }).disk;
  assert.equal(disk.customFsExclude, ''); assert.equal(disk.customPathExclude, '');
});

test('field changes preserve independent edits from another view and settings.json', async () => {
  const fixture = scopedSettings({ display: { charts:true, tabularNums:true } });
  const store = new ConfigStore({ vscode:fixture.vscode });
  store.read();
  store.update('display', [{path:['charts'],value:false}]);
  fixture.global.display = {...fixture.global.display,tabularNums:false};
  store.refresh();
  store.update('display', [{path:['showGpuUsers'],value:false}]);
  await store.flush();
  assert.deepEqual(fixture.global.display,{charts:false,tabularNums:false,showGpuUsers:false});
  assert.throws(()=>store.update('display',{charts:true}),/Invalid configuration/);
  assert.throws(()=>store.update('display',[{path:['__proto__','polluted'],value:true}]),/Invalid configuration/);
  store.dispose();
});

test('external sibling edits observed during an in-flight write are preserved on disk', async () => {
  const saved = { display:{charts:true,tabularNums:true} }, writes = [];
  const configuration = { inspect:key=>({globalValue:saved[key]}), update:(key,value)=>new Promise(resolve=>writes.push({value,finish(){saved[key]=value;resolve();}})) };
  const store = new ConfigStore({vscode:{workspace:{getConfiguration:()=>configuration}}});
  store.update('display',[{path:['charts'],value:false}]);
  const pending=store.flush(); await new Promise(setImmediate);
  saved.display={charts:true,tabularNums:false}; store.refresh();
  assert.equal(store.getCurrent().display.tabularNums,false);
  writes[0].finish(); await new Promise(setImmediate);
  assert.equal(writes.length,2); assert.equal(writes[1].value.tabularNums,false);
  writes[1].finish(); await pending;
  assert.deepEqual(saved.display,{charts:false,tabularNums:false});
  assert.deepEqual(store.getSaveState(),{status:'saved',error:null}); store.dispose();
});

test('failed saves keep their field edits, report failure, and support an explicit retry', async () => {
  const fixture=scopedSettings({display:{charts:true,tabularNums:true}}); let fail=true;
  const get=fixture.vscode.workspace.getConfiguration;
  fixture.vscode.workspace.getConfiguration=(...args)=>{const config=get(...args);return {...config,update:async(...values)=>{if(fail)throw new Error('read only');await config.update(...values);}};};
  const store=new ConfigStore({vscode:fixture.vscode}); const states=[];
  store.onDidChangeSaveState(value=>states.push(value.status));
  store.update('display',[{path:['charts'],value:false}]);
  await assert.rejects(store.flush(),/read only/);
  assert.equal(store.getCurrent().display.charts,false);
  assert.deepEqual(store.getSaveState(),{status:'error',error:'read only'});
  fixture.global.display.tabularNums=false; store.refresh();
  fail=false; await store.flush();
  assert.deepEqual(fixture.global.display,{charts:false,tabularNums:false});
  assert.deepEqual(states,['saving','error','saving','saved']); store.dispose();
});

test('settings save begins in the current turn without a debounce timer', async () => {
  const fixture=scopedSettings();const store=new ConfigStore({vscode:fixture.vscode});
  store.update('refreshInterval',[{path:[],value:7}]);
  await new Promise(setImmediate);
  assert.equal(fixture.global.refreshInterval,7);
  assert.equal(store.getSaveState().status,'saved');store.dispose();
});

test('external extension fields never follow inherited object paths', async () => {
  const saved={display:{charts:true}},writes=[];
  const configuration={inspect:key=>({globalValue:saved[key]}),update:(key,value)=>new Promise(resolve=>writes.push({value,finish(){saved[key]=value;resolve();}}))};
  const store=new ConfigStore({vscode:{workspace:{getConfiguration:()=>configuration}}});
  store.update('display',[{path:['charts'],value:false}]);const pending=store.flush();await new Promise(setImmediate);
  saved.display=JSON.parse('{"charts":true,"__proto__":{"testConfigPollution":true}}');store.refresh();
  writes[0].finish();await new Promise(setImmediate);writes[1].finish();await pending;
  assert.equal({}.testConfigPollution,undefined);assert.equal(Object.hasOwn(saved.display,'__proto__'),true);store.dispose();
});

test('SSH config discovery distinguishes missing files from permission and I/O failures', async () => {
  const {listSshHosts,expandInclude}=require('../src/ssh/ssh-config');
  for(const code of ['ENOENT','ENOTDIR']){
    const error=Object.assign(new Error(code),{code});
    assert.deepEqual(await listSshHosts('/config',{fileSystem:{realpath:async()=>{throw error;}}}),[]);
    assert.deepEqual(await expandInclude('conf/*.cfg','/home/user',{readdir:async()=>{throw error;}}),[]);
  }
  for(const code of ['EACCES','EIO']){
    const error=Object.assign(new Error(code),{code});
    await assert.rejects(listSshHosts('/config',{fileSystem:{realpath:async()=>{throw error;}}}),{code});
    await assert.rejects(expandInclude('conf/*.cfg','/home/user',{readdir:async()=>{throw error;}}),{code});
  }
});
