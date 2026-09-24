'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { getWebviewHtml } = require('./webview-html');
const { listSshHosts, expandHome } = require('../ssh/ssh-config');
const { SshTransport } = require('../ssh/ssh-transport');
const pkg = require('../../package.json');

const STATE_KEY = 'sysmonitor.sidebarDevices';
const CONFIG_KEYS = new Set(['refreshInterval', 'statusBar', 'disk', 'display', 'servers']);
const EXTENSION_ID = `${pkg.publisher}.${pkg.name}`;

function normalizeNavigation(raw, localLinux) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const tabs = [...new Set((Array.isArray(source.tabs) ? source.tabs : []).filter((id) => typeof id === 'string' && (id === 'local' ? localLinux : /^ssh:[^\s\0-][^\s\0]*$/.test(id))))];
  if (localLinux && !tabs.includes('local')) tabs.unshift('local');
  const selected = tabs.includes(source.selected) ? source.selected : (localLinux ? 'local' : tabs[0] || null);
  const page = ['perf', 'proc', 'servers'].includes(source.page) ? source.page : (selected ? 'perf' : 'servers');
  const processDisplay = source.processDisplay && typeof source.processDisplay === 'object' ? source.processDisplay : { cpu: 'core', ram: 'size' };
  return { tabs, selected, page: selected ? page : 'servers', processDisplay };
}

class MultiMonitorViewProvider {
  constructor({ vscode, manager, configStore, workspaceState, uiStateStore = null, localLinux, loadHosts = listSshHosts, createProbe = (options) => new SshTransport(options), scheduleErrorClear = (callback, milliseconds) => setTimeout(callback, milliseconds), cancelErrorClear = clearTimeout, onLocalUpdate = () => {}, logger = () => {} }) {
    this.vscode = vscode;
    this.manager = manager;
    this.configStore = configStore;
    this.workspaceState = workspaceState;
    this.uiStateStore = uiStateStore;
    this.localLinux = localLinux;
    this.onLocalUpdate = onLocalUpdate;
    this.logger = logger;
    this.loadHosts = loadHosts;
    this.createProbe = createProbe;
    this.scheduleErrorClear = scheduleErrorClear;
    this.cancelErrorClear = cancelErrorClear;
    this.sidebar = null;
    this.editors = new Map();
    this.hosts = [];
    this.lastServerStatuses = new Map();
    this.pendingHosts = new Set();
    this.hostErrors = new Map();
    this.hostErrorTimers = new Map();
    this.remoteFolders = new Map();
    const saved = configStore.getCurrent().servers.restoreTabs ? workspaceState.get(STATE_KEY, {}) : {};
    this.sidebarState = normalizeNavigation(saved, localLinux);
    this.refreshReferences();
    this.refreshHosts();
  }

  async refreshHosts() {
    try {
      const configured = this.vscode.workspace.getConfiguration('remote.SSH').get('configFile');
      this.manager.setConfigFile(configured || null);
      this.hosts = await this.loadHosts(configured || undefined);
      this.remoteFolders.clear();
      for (const host of this.hostErrors.keys()) this.clearHostError(host);
      this.broadcast({ cmd: 'servers', hosts: this.serverRows() });
    } catch (error) {
      this.logger(`SSH config: ${error.message}`);
      this.broadcast({ cmd: 'servers', hosts: [], error: error.message });
    }
  }

  isSshDefaultExtension() {
    const values = this.vscode.workspace.getConfiguration('remote.SSH').get('defaultExtensions');
    return Array.isArray(values) && values.some((value) => typeof value === 'string' && value.toLowerCase() === EXTENSION_ID.toLowerCase());
  }

  serverRows() {
    return this.hosts.map((host) => {
      const device = this.manager.get('ssh:' + host);
      const pending = this.pendingHosts.has(host);
      const error = (this.hostErrors.get(host) || {}).message || (device && device.error) || null;
      const state = pending ? 'connecting' : error ? 'disconnected' : device ? device.state : 'idle';
      const snapshot = device && device.service.readSnapshot();
      const metrics = [];
      if (state === 'connected' && snapshot && device.model) {
        const performance = device.model.performance;
        if (snapshot.cpu.status === 'fresh') metrics.push(`CPU ${performance.cpu.usagePercent}%`);
        if (snapshot.memory.status === 'fresh') metrics.push(`RAM ${performance.memory.usagePercent}%`);
        if (snapshot.accelerators.status === 'fresh' && performance.gpus.length) {
          metrics.push(`GPU ${performance.gpus.filter((gpu) => gpu.isIdle).length}/${performance.gpus.length}`);
        }
      }
      return { host, state, error, busy: pending, metrics };
    });
  }

  clearHostError(host) {
    const timer = this.hostErrorTimers.get(host);
    if (this.hostErrorTimers.has(host)) this.cancelErrorClear(timer);
    this.hostErrorTimers.delete(host);
    this.hostErrors.delete(host);
  }

  setHostError(host, message) {
    this.clearHostError(host);
    const record = { message };
    this.hostErrors.set(host, record);
    const timer = this.scheduleErrorClear(() => {
      if (this.hostErrors.get(host) !== record) return;
      this.clearHostError(host);
      this.broadcast({ cmd: 'servers', hosts: this.serverRows() });
    }, 10000);
    this.hostErrorTimers.set(host, timer);
  }

  async connectHost(host, { retain = false } = {}) {
    const id = 'ssh:' + host;
    const existing = this.manager.get(id);
    if (retain) {
      const device = existing || this.manager.open(id);
      await device.transport.connect();
      return;
    }
    if (existing) { await existing.transport.connect(); return; }
    const transport = this.createProbe({ host, configFile: this.manager.configFile });
    try { await transport.connect(); }
    finally { transport.dispose(); }
  }

  async runHostAction(host, kind, action) {
    if (this.pendingHosts.has(host)) return;
    this.pendingHosts.add(host);
    this.clearHostError(host);
    this.broadcast({ cmd: 'servers', hosts: this.serverRows() });
    try {
      if (kind !== 'remoteWindow') await this.connectHost(host, { retain: kind !== 'terminal' });
      await action();
      this.clearHostError(host);
    } catch (error) {
      this.setHostError(host, error && error.message ? error.message : String(error));
      this.logger(`SSH ${host}: ${error && error.message ? error.message : error}`);
      this.refreshReferences();
    } finally {
      this.pendingHosts.delete(host);
      this.broadcast({ cmd: 'servers', hosts: this.serverRows() });
    }
  }

  async readRemoteFolders(host) {
    try {
      const records = await this.vscode.commands.executeCommand('remote-internal.getSshFoldersHistory', host);
      if (!Array.isArray(records)) return [];
      const seen = new Set();
      return records.filter((record) => {
        if (!record || typeof record.remote !== 'string' || !record.remote || /[\0\r\n]/.test(record.remote)
          || typeof record.folder !== 'string' || !path.posix.isAbsolute(record.folder) || /[\0\r\n]/.test(record.folder)) return false;
        const key = record.remote + '\0' + record.folder;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).map(({ remote, folder }) => ({ remote, folder }));
    } catch (error) {
      this.logger(`Remote-SSH folder history: ${error.message}`);
      return [];
    }
  }

  async openEmptyRemoteWindow(host) {
    try {
      await this.vscode.commands.executeCommand('opensshremotes.openEmptyWindow', { host });
    } catch (error) {
      if (!/command .*not found/i.test(error && error.message || '')) throw error;
      await this.vscode.commands.executeCommand('vscode.newWindow', { remoteAuthority: `ssh-remote+${host}`, reuseWindow: false });
    }
  }

  async buildHtml(state, { sidebar = false } = {}) {
    const config = this.configStore.getCurrent();
    const device = this.manager.get(state.selected);
    const acceleratorValue = device ? device.service.readSnapshot().accelerators.value : null;
    return getWebviewHtml({
      initConfig: {
        localMode: true, localLinux: this.localLinux,
        surface: sidebar ? 'sidebar' : 'editor',
        showLocalIntro: sidebar && !(this.uiStateStore && this.uiStateStore.get('sysmonitor.localIntroDismissed', false)),
        sshDefaultInstalled: this.isSshDefaultExtension(),
        language: this.vscode.env.language,
        navigation: state,
        interval: config.refreshInterval,
        barCfg: config.statusBar, diskCfg: config.disk, displayCfg: config.display, serversCfg: config.servers,
        gpuCount: acceleratorValue ? acceleratorValue.devices.length : null,
        processDisplay: state.processDisplay,
        paused: this.manager.paused,
      },
      nonce: crypto.randomBytes(16).toString('base64'),
    });
  }

  async resolveWebviewView(view) {
    const source = { target: view, state: this.sidebarState, ready: false, sidebar: true };
    this.sidebar = source;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((message) => this.handleMessage(message, source));
    view.onDidDispose(() => { if (this.sidebar === source) this.sidebar = null; this.refreshReferences(); });
    if (view.onDidChangeVisibility) view.onDidChangeVisibility(() => this.refreshReferences());
    view.webview.html = await this.buildHtml(source.state, { sidebar: true });
    this.refreshReferences();
  }

  async attachEditor(panel, rawState) {
    const state = normalizeNavigation(this.configStore.getCurrent().servers.restoreTabs ? rawState : {}, this.localLinux);
    const source = { target: panel, state, ready: false, sidebar: false };
    this.editors.set(panel, source);
    panel.title = 'System Monitor';
    panel.iconPath = {
      light: this.vscode.Uri.file(path.join(__dirname, '..', '..', 'icon-tab-light.svg')),
      dark: this.vscode.Uri.file(path.join(__dirname, '..', '..', 'icon-tab-dark.svg')),
    };
    panel.webview.options = { enableScripts: true };
    panel.webview.onDidReceiveMessage((message) => this.handleMessage(message, source));
    panel.onDidDispose(() => { this.editors.delete(panel); this.refreshReferences(); });
    if (panel.onDidChangeViewState) panel.onDidChangeViewState(() => this.refreshReferences());
    panel.webview.html = await this.buildHtml(state);
    this.refreshReferences();
  }

  async openEditorPanel(initialState = this.sidebarState) {
    const state = normalizeNavigation(initialState, this.localLinux);
    const panel = this.vscode.window.createWebviewPanel('sysmonitor.editor', 'System Monitor', this.vscode.ViewColumn.Active, { enableScripts: true });
    await this.attachEditor(panel, state);
    return panel;
  }

  async openFloatingPanel(initialState = this.sidebarState) {
    const panel = await this.openEditorPanel(initialState);
    try {
      panel.reveal(this.vscode.ViewColumn.Active);
      await this.vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
    } catch (error) {
      panel.dispose();
      throw error;
    }
  }

  sources() { return [...(this.sidebar ? [this.sidebar] : []), ...this.editors.values()]; }
  broadcast(message) { for (const source of this.sources()) if (source.ready) source.target.webview.postMessage(message); }

  refreshReferences() {
    const open = new Set(this.sidebarState.tabs);
    const visible = new Set();
    for (const source of this.sources()) {
      for (const id of source.state.tabs) open.add(id);
      if (source.target.visible && source.state.page !== 'servers' && source.state.selected) visible.add(source.state.selected);
    }
    const previous = this.hosts.map((host) => !!this.manager.get('ssh:' + host));
    this.manager.sync(open, visible);
    if (this.hosts.some((host, index) => previous[index] !== !!this.manager.get('ssh:' + host))) {
      this.broadcast({ cmd: 'servers', hosts: this.serverRows() });
    }
  }

  persist(source, { hydrate = false } = {}) {
    if (source.sidebar) {
      this.sidebarState = source.state;
      this.workspaceState.update(STATE_KEY, source.state).catch((error) => this.logger(error.message));
    }
    if (!hydrate) {
      source.target.webview.postMessage({ cmd: 'navigation', state: source.state });
      this.refreshReferences();
      return;
    }
    source.switching = true;
    this.refreshReferences();
    const device = this.manager.get(source.state.selected);
    const latestPoint = device && device.history[device.history.length - 1];
    source.target.webview.postMessage({
      cmd: 'deviceState', state: source.state, deviceId: source.state.selected,
      samples: device ? device.history : [],
      viewModel: device ? device.model : null,
      sampleTime: latestPoint ? latestPoint.t : null,
      connection: device ? { state: device.state, error: device.error } : null,
    });
    source.lastSnapshotAt = latestPoint ? latestPoint.t : null;
    source.switching = false;
  }

  sendCurrent(source) {
    if (!source.ready || !source.state.selected) return;
    const device = this.manager.get(source.state.selected);
    if (!device) return;
    const latestPoint = device.history[device.history.length - 1];
    source.target.webview.postMessage({ cmd: 'history', samples: device.history });
    if (device.model) source.target.webview.postMessage({ cmd: 'snapshot', deviceId: device.id, viewModel: device.model, sampleTime: latestPoint ? latestPoint.t : null, instant: true, skipHistory: true });
    source.lastSnapshotAt = latestPoint ? latestPoint.t : null;
    source.target.webview.postMessage({ cmd: 'connection', deviceId: device.id, state: device.state, error: device.error });
  }

  onDeviceUpdate(id, device) {
    if (device.state === 'connected' && device.host && this.lastServerStatuses.get(id) !== 'connected:') this.clearHostError(device.host);
    if (id === 'local' && device.model) this.onLocalUpdate(device.model);
    for (const source of this.sources()) {
      if (!source.ready) continue;
      if (!source.switching && source.state.selected === id) {
        const latestPoint = device.history[device.history.length - 1];
        const sampleTime = latestPoint ? latestPoint.t : null;
        if (device.model && sampleTime !== source.lastSnapshotAt) {
          source.target.webview.postMessage({ cmd: 'snapshot', deviceId: id, viewModel: device.model, sampleTime });
          source.lastSnapshotAt = sampleTime;
        }
        source.target.webview.postMessage({ cmd: 'connection', deviceId: id, state: device.state, error: device.error });
      }
    }
    const signature = `${device.state}:${device.error || ''}`;
    if (this.lastServerStatuses.get(id) !== signature || (device.host && device.state === 'connected')) {
      this.lastServerStatuses.set(id, signature);
      this.broadcast({ cmd: 'servers', hosts: this.serverRows() });
    }
  }

  pushConfig() {
    const config = this.configStore.getCurrent();
    this.broadcast({ cmd: 'config', interval: config.refreshInterval, barCfg: config.statusBar, diskCfg: config.disk, displayCfg: config.display, serversCfg: config.servers, sshDefaultInstalled: this.isSshDefaultExtension() });
  }

  async handleMessage(message, source) {
    if (!message || message.version !== 1 || typeof message.cmd !== 'string') return;
    const state = source.state;
    if (message.cmd === 'ready') {
      source.ready = true;
      source.target.webview.postMessage({ cmd: 'navigation', state });
      source.target.webview.postMessage({ cmd: 'servers', hosts: this.serverRows() });
      source.target.webview.postMessage({ cmd: 'uiState', processDisplay: state.processDisplay, paused: this.manager.paused });
      this.sendCurrent(source);
    } else if (message.cmd === 'refreshServers') this.refreshHosts();
    else if (message.cmd === 'listRemoteFolders' && typeof message.host === 'string' && this.hosts.includes(message.host)) {
      const folders = await this.readRemoteFolders(message.host);
      this.remoteFolders.set(message.host, folders);
      source.target.webview.postMessage({ cmd: 'remoteFolders', host: message.host, folders: folders.map(({ folder }, index) => ({ index, folder })) });
    }
    else if (message.cmd === 'openRemoteWindow' && typeof message.host === 'string' && this.hosts.includes(message.host)) {
      const folder = Number.isInteger(message.folderIndex) ? (this.remoteFolders.get(message.host) || [])[message.folderIndex] : null;
      if (message.folderIndex !== undefined && !folder) return;
      await this.runHostAction(message.host, 'remoteWindow', async () => {
        if (!folder) { await this.openEmptyRemoteWindow(message.host); return; }
        const uri = this.vscode.Uri.from({ scheme: 'vscode-remote', authority: `ssh-remote+${folder.remote}`, path: folder.folder });
        const opened = await this.vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
        if (opened === false) throw new Error('Could not open remote folder');
      });
    }
    else if (message.cmd === 'addSshDefaultExtension') {
      try {
        const configuration = this.vscode.workspace.getConfiguration('remote.SSH');
        const current = configuration.get('defaultExtensions');
        const entries = Array.isArray(current) ? current.slice() : [];
        if (!entries.some((value) => typeof value === 'string' && value.toLowerCase() === EXTENSION_ID.toLowerCase())) {
          await configuration.update('defaultExtensions', [...entries, EXTENSION_ID], true);
        }
        this.broadcast({ cmd: 'sshDefaultExtensions', installed: true });
      } catch (error) {
        this.logger(`SSH default extensions: ${error.message}`);
        this.broadcast({ cmd: 'sshDefaultExtensions', installed: this.isSshDefaultExtension(), error: error.message });
      }
    }
    else if (message.cmd === 'dismissLocalIntro' && this.uiStateStore) {
      this.uiStateStore.update('sysmonitor.localIntroDismissed', true).catch((error) => this.logger(error.message));
      this.broadcast({ cmd: 'localIntroDismissed' });
    }
    else if (message.cmd === 'openServer' && typeof message.host === 'string' && this.hosts.includes(message.host)) {
      const id = 'ssh:' + message.host;
      await this.runHostAction(message.host, 'monitor', async () => {
        if (message.inWindow) {
          await this.openFloatingPanel({ tabs: [id], selected: id, page: 'perf', processDisplay: { cpu: 'core', ram: 'size' } });
        } else if (message.inEditor) {
          await this.openEditorPanel({ tabs: [id], selected: id, page: 'perf', processDisplay: { cpu: 'core', ram: 'size' } });
        } else {
          const current = source.state;
          source.state = normalizeNavigation({ ...current, tabs: [...current.tabs, id], selected: id, page: 'perf' }, this.localLinux);
          this.persist(source, { hydrate: current.selected !== id });
        }
      });
    } else if (message.cmd === 'openTerminal' && typeof message.host === 'string' && this.hosts.includes(message.host)) {
      await this.runHostAction(message.host, 'terminal', () => {
        const configured = this.vscode.workspace.getConfiguration('remote.SSH').get('configFile');
        const args = configured ? ['-F', expandHome(configured), message.host] : [message.host];
        const terminal = this.vscode.window.createTerminal({ name: `SSH: ${message.host}`, shellPath: 'ssh', shellArgs: args });
        terminal.show();
      });
    } else if (message.cmd === 'switchDevice' && state.tabs.includes(message.id)) {
      source.state = { ...state, selected: message.id, page: state.page === 'servers' ? 'perf' : state.page };
      this.persist(source, { hydrate: state.selected !== message.id });
    } else if (message.cmd === 'reorderDevices' && Array.isArray(message.tabs)) {
      const original = new Set(state.tabs);
      if (message.tabs.length !== state.tabs.length || new Set(message.tabs).size !== original.size || !message.tabs.every((id) => original.has(id))) return;
      source.state = { ...state, tabs: message.tabs.slice() };
      this.persist(source);
    } else if (message.cmd === 'closeDevice' && message.id !== 'local' && state.tabs.includes(message.id)) {
      const tabs = state.tabs.filter((id) => id !== message.id);
      const selected = state.selected === message.id ? tabs[0] || null : state.selected;
      source.state = { ...state, tabs, selected, page: selected ? state.page : 'servers' };
      this.persist(source, { hydrate: selected !== state.selected });
    } else if (message.cmd === 'switchPage' && ['perf', 'proc', 'servers'].includes(message.page)) {
      source.state = { ...state, page: message.page };
      this.persist(source);
    } else if (message.cmd === 'setProcessDisplay' && ['cpu', 'ram'].includes(message.key)) {
      const allowed = message.key === 'cpu' ? ['core', 'whole', 'both'] : ['size', 'percent', 'both'];
      if (!allowed.includes(message.value)) return;
      source.state = { ...state, processDisplay: { ...state.processDisplay, [message.key]: message.value } };
      this.persist(source);
    } else if (message.cmd === 'setConfig' && CONFIG_KEYS.has(message.key)) {
      this.configStore.update(message.key, message.value);
      this.manager.updateConfig();
      this.pushConfig();
    } else if (message.cmd === 'getConfig') this.pushConfig();
    else if (message.cmd === 'openSettings') this.vscode.commands.executeCommand('workbench.action.openSettings', 'sysmonitor');
    else if (message.cmd === 'openLink' && typeof message.url === 'string' && /^https:\/\//.test(message.url)) this.vscode.env.openExternal(this.vscode.Uri.parse(message.url));
    else if (message.cmd === 'pause' && typeof message.value === 'boolean') {
      this.manager.setPaused(message.value);
      this.broadcast({ cmd: 'uiState', paused: message.value });
    }
  }

  dispose() {
    for (const timer of this.hostErrorTimers.values()) this.cancelErrorClear(timer);
    this.hostErrorTimers.clear();
    this.hostErrors.clear();
  }
}

module.exports = { MultiMonitorViewProvider, normalizeNavigation };
