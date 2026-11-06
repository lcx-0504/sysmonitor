'use strict';
// Shared setup for tests that drive the monitor view providers through their public flows.
const { normalizeConfig } = require('../src/config/normalize-config');
const { MultiMonitorViewProvider } = require('../src/view/multi-monitor-view-provider');
const { createFakeVscode, createMemento } = require('./fake-vscode');
const { createSessionFixture } = require('./session-fixture');

const SIDEBAR_STATE_KEY = 'sysmonitor.sidebarDevices';
const READY = Object.freeze({ version: 1, cmd: 'ready' });

const settle = () => new Promise((resolve) => setImmediate(resolve));

function readInitialConfig(html) {
  return JSON.parse(Buffer.from(html.match(/data-config="([A-Za-z0-9+/=]+)"/)[1], 'base64').toString('utf8'));
}

function savedConfigStore(raw = {}) {
  const config = normalizeConfig(raw);
  return { getCurrent: () => config, getSaveState: () => ({ status: 'saved', error: null }) };
}

// Ready checks scheduled by a provider; tests fire or inspect them instead of waiting ten seconds.
function fakeTimers() {
  const timers = [];
  return {
    timers,
    scheduleReadyCheck: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancelReadyCheck: (timer) => {
      timer.cancelled = true;
    },
  };
}

// A device manager double that records what the provider asks of it.
function createDeviceManager({ devices = new Map(), paused = false, ...overrides } = {}) {
  return {
    paused,
    devices,
    syncs: [],
    pauseRequests: [],
    preparing: [],
    configFiles: [],
    isPaused() {
      return this.paused;
    },
    setPaused(value) {
      this.pauseRequests.push(value);
      this.paused = value;
    },
    get(id) {
      return this.devices.get(id) || null;
    },
    sync(open, visible) {
      this.syncs.push({ open: [...open].sort(), visible: [...visible].sort() });
    },
    setPreparing(id, value) {
      this.preparing.push([id, value]);
    },
    setConfigFile(file) {
      this.configFiles.push(file);
    },
    updateConfig() {},
    ...overrides,
  };
}

// A remote session that is connected and has completed its first sample.
async function createReadyDevice(id, options = {}) {
  const fixture = createSessionFixture({ id, remote: true, ...options });
  await fixture.transport.connect();
  fixture.commit();
  return fixture.session;
}

function createMultiProvider({ vscode = createFakeVscode(), manager = createDeviceManager(), configStore = savedConfigStore(),
  sidebarState = undefined, workspaceState = createMemento(sidebarState ? { [SIDEBAR_STATE_KEY]: sidebarState } : {}),
  hosts = [], localLinux = false, ...options } = {}) {
  const provider = new MultiMonitorViewProvider({
    vscode, manager, configStore, workspaceState, localLinux, loadHosts: async () => hosts, ...options,
  });
  return { provider, vscode, manager, workspaceState };
}

async function openSidebar(provider, vscode, { ready = true, ...viewOptions } = {}) {
  const view = vscode.fake.createView(viewOptions);
  await provider.resolveWebviewView(view);
  if (ready) await view.receive(READY);
  return view;
}

async function openEditor(provider, vscode, state, { ready = true, ...panelOptions } = {}) {
  const panel = vscode.fake.createPanel(panelOptions);
  await provider.attachEditor(panel, state);
  if (ready) await panel.receive(READY);
  return panel;
}

const commandsOf = (messages, cmd) => messages.filter((message) => message.cmd === cmd);

module.exports = {
  READY, SIDEBAR_STATE_KEY, settle, readInitialConfig, savedConfigStore, fakeTimers, createDeviceManager, createReadyDevice,
  createMultiProvider, openSidebar, openEditor, commandsOf,
};
