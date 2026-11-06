'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const protocol = require('../src/view/protocol');
const { MonitorViewProvider } = require('../src/view/monitor-view-provider');
const { MultiMonitorViewProvider } = require('../src/view/multi-monitor-view-provider');
const { normalizeConfig } = require('../src/config/normalize-config');

const VIEW_DIRECTORY = path.join(__dirname, '..', 'src', 'view');
const ASSET_DIRECTORY = path.join(VIEW_DIRECTORY, 'assets');
const GENERATED_MODULES = ['i18n.mjs', 'protocol.mjs', 'device-id.mjs', 'metric-playback.mjs'];
const HOST_FILES = ['monitor-view-host.js', 'monitor-view-provider.js', 'multi-monitor-view-provider.js'];

function frontendSource() {
  return fs.readdirSync(ASSET_DIRECTORY)
    .filter((file) => file.endsWith('.mjs') && !GENERATED_MODULES.includes(file))
    .map((file) => fs.readFileSync(path.join(ASSET_DIRECTORY, file), 'utf8'))
    .join('\n');
}

test('the generated browser protocol matches the extension protocol', async () => {
  const browser = await import('../src/view/assets/protocol.mjs');
  assert.deepEqual({ PROTOCOL_VERSION: browser.PROTOCOL_VERSION, TO_EXTENSION: browser.TO_EXTENSION, TO_WEBVIEW: browser.TO_WEBVIEW }, protocol);
  for (const direction of [protocol.TO_EXTENSION, protocol.TO_WEBVIEW]) {
    for (const [key, value] of Object.entries(direction)) assert.equal(key, value);
  }
});

test('the frontend names commands only through the protocol and handles every webview command', () => {
  const source = frontendSource();
  assert.doesNotMatch(source, /\bcmd\s*:\s*['"`]/);
  assert.doesNotMatch(source, /\.cmd\s*[!=]==\s*['"`]/);
  assert.doesNotMatch(source, /\bversion\s*:\s*\d/);
  const sent = new Set([...source.matchAll(/\bTO_EXTENSION\.(\w+)/g)].map((match) => match[1]));
  const handled = new Set([...source.matchAll(/\[TO_WEBVIEW\.(\w+)\]\s*:/g)].map((match) => match[1]));
  assert.deepEqual([...sent].sort(), Object.keys(protocol.TO_EXTENSION).sort());
  assert.deepEqual([...handled].sort(), Object.keys(protocol.TO_WEBVIEW).sort());
});

test('the frontend recognizes device ids only through the shared helpers', async () => {
  const domain = require('../src/domain/device-id');
  const browser = await import('../src/view/assets/device-id.mjs');
  assert.deepEqual(Object.keys(browser).sort(), Object.keys(domain).sort());
  assert.equal(browser.LOCAL_DEVICE_ID, domain.LOCAL_DEVICE_ID);
  assert.equal(browser.deviceHost(domain.sshDeviceId('user@campus')), 'user@campus');
  const source = frontendSource();
  assert.doesNotMatch(source, /['"`]ssh:|startsWith\(\s*['"`]ssh/);
  assert.doesNotMatch(source, /[!=]==\s*['"`]local['"`]|\|\|\s*['"`]local['"`]/);
  assert.doesNotMatch(source, /\.slice\(4\)/);
});

test('every webview command has a handler and view hosts name commands only through the protocol', () => {
  const configStore = { getCurrent: () => normalizeConfig({}), getSaveState: () => ({ status: 'saved', error: null }) };
  const single = new MonitorViewProvider({ vscode: {}, session: {}, configStore });
  const multi = new MultiMonitorViewProvider({
    vscode: { workspace: { getConfiguration: () => ({ get: () => null }) } },
    manager: { get() { return null; }, sync() {}, setConfigFile() {} }, configStore,
    workspaceState: { get: () => ({}) }, localLinux: false, loadHosts: async () => [],
  });
  const handled = new Set([...Object.keys(single.messageHandlers), ...Object.keys(multi.messageHandlers)]);
  assert.deepEqual([...handled].sort(), Object.values(protocol.TO_EXTENSION).sort());
  multi.dispose();
  for (const file of HOST_FILES) {
    const source = fs.readFileSync(path.join(VIEW_DIRECTORY, file), 'utf8');
    assert.doesNotMatch(source, /\bcmd\s*:\s*['"`]/, file);
    assert.doesNotMatch(source, /(?<!typeof )\bmessage\.cmd\s*[!=]==\s*['"`]/, file);
  }
});
