'use strict';

const crypto = require('node:crypto');
const { getWebviewHtml } = require('./webview-html');
const { setMonitorPanelIcon, createMonitorEditorPanel, moveMonitorPanelToNewWindow } = require('./editor-panel');
const { setActionVisibilityContexts } = require('./action-visibility');
const { ServerDirectory } = require('./server-directory');
const { expandHome } = require('../ssh/ssh-config');
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

function normalizeEditorNavigation(raw, localLinux) {
  const state = normalizeNavigation(raw, localLinux);
  if (!state.selected) return null;
  return { ...state, tabs: [state.selected], page: state.page === 'proc' ? 'proc' : 'perf' };
}

function connectionPayload(device) {
  if (!device) return null;
  const retryAfter = device.transport && device.transport.retryAfter;
  return { state: device.state, error: device.error, retryAfter: Number.isFinite(retryAfter) ? retryAfter : null };
}

function displaySampleTime(device, paused) {
  if (!device) return null;
  if (paused && typeof device.modelAt === 'number') return device.modelAt;
  const latestPoint = device.history[device.history.length - 1];
  return latestPoint ? latestPoint.t : null;
}

class MultiMonitorViewProvider {
  constructor({ vscode, manager, configStore, workspaceState, uiStateStore = null, localLinux, loadHosts, scheduleErrorClear, cancelErrorClear, onLocalUpdate = () => {}, logger = () => {} }) {
    this.vscode = vscode;
    this.manager = manager;
    this.configStore = configStore;
    this.workspaceState = workspaceState;
    this.uiStateStore = uiStateStore;
    this.localLinux = localLinux;
    this.onLocalUpdate = onLocalUpdate;
    this.logger = logger;
    this.sidebar = null;
    this.editors = new Map();
    this.retryingDevices = new Map();
    this.lastFocusedEditor = null;
    this.editorSshContext = null;
    this.actionVisibility = null;
    this.serverDirectory = new ServerDirectory({ vscode, manager, loadHosts, scheduleErrorClear, cancelErrorClear, logger,
      onChange: (hosts, error) => {
        if (this.sidebar && this.sidebar.ready) this.sidebar.target.webview.postMessage({ cmd: 'servers', hosts, ...(error ? { error } : {}) });
      },
      onActionError: () => this.refreshReferences(),
    });
    const saved = configStore.getCurrent().servers.restoreTabs ? workspaceState.get(STATE_KEY, {}) : {};
    this.sidebarState = normalizeNavigation(saved, localLinux);
    this.updateActionVisibility();
    this.updateTitleActions();
    this.updateEditorTitleActions();
    this.refreshReferences();
    this.refreshHosts();
  }

  refreshHosts() { return this.serverDirectory.refresh(); }

  isSshDefaultExtension() {
    const values = this.vscode.workspace.getConfiguration('remote.SSH').get('defaultExtensions');
    return Array.isArray(values) && values.some((value) => typeof value === 'string' && value.toLowerCase() === EXTENSION_ID.toLowerCase());
  }

  serverRows() { return this.serverDirectory.rows(); }

  updateActionVisibility() {
    this.actionVisibility = setActionVisibilityContexts(this.vscode, this.configStore.getCurrent().servers, this.actionVisibility);
  }

  updateTitleActions() {
    if (!this.vscode.commands || !this.vscode.commands.executeCommand) return;
    const active = !!this.sidebarState.selected && this.sidebarState.page !== 'servers';
    this.vscode.commands.executeCommand('setContext', 'sysmonitor.sidebarDeviceActive', active);
    this.vscode.commands.executeCommand('setContext', 'sysmonitor.sidebarSshActive', active && this.sidebarState.selected.startsWith('ssh:'));
    this.vscode.commands.executeCommand('setContext', 'sysmonitor.sidebarFixedActive', active && this.sidebarState.selected === 'local');
  }

  updateEditorTitleActions() {
    if (!this.vscode.commands || !this.vscode.commands.executeCommand) return;
    const source = this.activeEditorSource();
    if (!source && this.editors.size) return;
    const sshActive = !!(source && source.state.selected.startsWith('ssh:'));
    if (sshActive === this.editorSshContext) return;
    this.editorSshContext = sshActive;
    this.vscode.commands.executeCommand('setContext', 'sysmonitor.editorSshActive', sshActive);
  }

  deviceTitle(id) {
    return id === 'local' ? (String(this.vscode.env.language || '').startsWith('zh') ? '本机' : 'Local') : id.slice(4);
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
    const state = normalizeEditorNavigation(rawState, this.localLinux);
    if (!state) { panel.dispose(); return; }
    const source = { target: panel, state, ready: false, sidebar: false };
    this.editors.set(panel, source);
    if (panel.active) this.lastFocusedEditor = source;
    panel.title = this.deviceTitle(state.selected);
    setMonitorPanelIcon(this.vscode, panel);
    panel.webview.options = { enableScripts: true };
    panel.webview.onDidReceiveMessage((message) => this.handleMessage(message, source));
    panel.onDidDispose(() => {
      this.editors.delete(panel);
      if (this.lastFocusedEditor === source) this.lastFocusedEditor = null;
      this.updateEditorTitleActions();
      this.refreshReferences();
    });
    if (panel.onDidChangeViewState) panel.onDidChangeViewState(() => {
      if (panel.active) this.lastFocusedEditor = source;
      this.updateEditorTitleActions();
      this.refreshReferences();
    });
    panel.webview.html = await this.buildHtml(state);
    this.updateEditorTitleActions();
    this.refreshReferences();
  }

  async openEditorPanel(initialState = this.sidebarState) {
    const state = normalizeEditorNavigation(initialState, this.localLinux);
    if (!state) return null;
    const panel = createMonitorEditorPanel(this.vscode, this.deviceTitle(state.selected));
    await this.attachEditor(panel, state);
    return panel;
  }

  async openFloatingPanel(initialState = this.sidebarState) {
    const panel = await this.openEditorPanel(initialState);
    if (!panel) return null;
    await moveMonitorPanelToNewWindow(this.vscode, panel);
    return panel;
  }

  activeEditorSource() {
    const active = [...this.editors.values()].find((source) => source.target.active);
    if (active) {
      this.lastFocusedEditor = active;
      return active;
    }
    if (this.lastFocusedEditor && this.editors.get(this.lastFocusedEditor.target) === this.lastFocusedEditor
      && this.lastFocusedEditor.target.visible !== false) return this.lastFocusedEditor;
    const visible = [...this.editors.values()].filter((source) => source.target.visible !== false);
    return visible.length === 1 ? visible[0] : null;
  }

  async returnActiveEditorToSidebar() {
    const source = this.activeEditorSource();
    if (!source) return;
    const id = source.state.selected;
    const state = normalizeNavigation({
      ...this.sidebarState,
      tabs: [...this.sidebarState.tabs, id],
      selected: id,
      page: source.state.page,
      processDisplay: source.state.processDisplay,
    }, this.localLinux);
    const previous = this.sidebarState;
    this.sidebarState = state;
    if (this.sidebar) {
      this.sidebar.state = state;
      this.persist(this.sidebar, { hydrate: previous.selected !== id });
      if (typeof this.sidebar.target.show === 'function') this.sidebar.target.show();
      else await this.vscode.commands.executeCommand('workbench.view.extension.sysmonitor-container');
    } else {
      await this.workspaceState.update(STATE_KEY, state);
      this.updateTitleActions();
      await this.vscode.commands.executeCommand('workbench.view.extension.sysmonitor-container');
    }
    source.target.dispose();
  }

  async moveActiveEditorToNewWindow() {
    const source = this.activeEditorSource();
    if (source) await moveMonitorPanelToNewWindow(this.vscode, source.target, { disposeOnError: false });
  }

  async moveSidebarDeviceToEditor(floating = false) {
    const current = this.sidebarState;
    if (!current.selected || current.page === 'servers') return;
    const id = current.selected;
    const viewState = { tabs: [id], selected: id, page: current.page, processDisplay: current.processDisplay };
    const panel = floating ? await this.openFloatingPanel(viewState) : await this.openEditorPanel(viewState);
    if (!panel || id === 'local') return;
    const latest = this.sidebarState;
    if (!latest.tabs.includes(id)) return;
    const tabs = latest.tabs.filter((tab) => tab !== id);
    const selected = latest.selected === id ? (this.localLinux && tabs.includes('local') ? 'local' : tabs[0] || null) : latest.selected;
    const state = { ...latest, tabs, selected, page: selected ? latest.page : 'servers' };
    this.sidebarState = state;
    if (this.sidebar) {
      this.sidebar.state = state;
      this.persist(this.sidebar, { hydrate: selected !== latest.selected });
    } else {
      this.workspaceState.update(STATE_KEY, state).catch((error) => this.logger(error.message));
      this.updateTitleActions();
      this.refreshReferences();
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
    const previous = this.serverDirectory.hosts.map((host) => !!this.manager.get('ssh:' + host));
    this.manager.sync(open, visible);
    if (this.serverDirectory.hosts.some((host, index) => previous[index] !== !!this.manager.get('ssh:' + host))) this.serverDirectory.notify();
  }

  persist(source, { hydrate = false } = {}) {
    if (source.sidebar) {
      this.sidebarState = source.state;
      this.workspaceState.update(STATE_KEY, source.state).catch((error) => this.logger(error.message));
      this.updateTitleActions();
    }
    if (!hydrate) {
      source.target.webview.postMessage({ cmd: 'navigation', state: source.state });
      this.refreshReferences();
      return;
    }
    source.switching = true;
    this.refreshReferences();
    const device = this.manager.get(source.state.selected);
    const sampleTime = displaySampleTime(device, this.manager.paused);
    source.target.webview.postMessage({
      cmd: 'deviceState', state: source.state, deviceId: source.state.selected,
      samples: device ? device.history : [],
      viewModel: device ? device.model : null,
      sampleTime,
      connection: connectionPayload(device),
    });
    source.lastSnapshotAt = sampleTime;
    source.switching = false;
  }

  sendCurrent(source) {
    if (!source.ready || !source.state.selected) return;
    const device = this.manager.get(source.state.selected);
    if (!device) return;
    const sampleTime = displaySampleTime(device, this.manager.paused);
    source.target.webview.postMessage({ cmd: 'history', samples: device.history });
    if (device.model) source.target.webview.postMessage({ cmd: 'snapshot', deviceId: device.id, viewModel: device.model, sampleTime, instant: true, skipHistory: true });
    source.lastSnapshotAt = sampleTime;
    source.target.webview.postMessage({ cmd: 'connection', deviceId: device.id, ...connectionPayload(device) });
  }

  onDeviceUpdate(id, device) {
    if (id === 'local' && device.model) this.onLocalUpdate(device.model);
    for (const source of this.sources()) {
      if (!source.ready) continue;
      if (!source.switching && source.state.selected === id) {
        const sampleTime = displaySampleTime(device, this.manager.paused);
        if (device.model && sampleTime !== source.lastSnapshotAt) {
          source.target.webview.postMessage({ cmd: 'snapshot', deviceId: id, viewModel: device.model, sampleTime, skipHistory: this.manager.paused });
          source.lastSnapshotAt = sampleTime;
        }
        source.target.webview.postMessage({ cmd: 'connection', deviceId: id, ...connectionPayload(device) });
      }
    }
    this.serverDirectory.onDeviceUpdate(id, device);
  }

  pushConfig() {
    const config = this.configStore.getCurrent();
    this.broadcast({ cmd: 'config', interval: config.refreshInterval, barCfg: config.statusBar, diskCfg: config.disk, displayCfg: config.display, serversCfg: config.servers, sshDefaultInstalled: this.isSshDefaultExtension() });
  }

  async openRemoteWindow(host, folderIndex) {
    if (!this.serverDirectory.hasHost(host)) return;
    const folder = this.serverDirectory.remoteFolder(host, folderIndex);
    if (folderIndex !== undefined && !folder) return;
    await this.serverDirectory.runAction(host, 'remoteWindow', async () => {
      if (!folder) { await this.serverDirectory.openEmptyRemoteWindow(host); return; }
      const uri = this.vscode.Uri.from({ scheme: 'vscode-remote', authority: `ssh-remote+${folder.remote}`, path: folder.folder });
      const opened = await this.vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
      if (opened === false) throw new Error('Could not open remote folder');
    });
  }

  async openRemoteWindowPicker(host) {
    const folders = await this.serverDirectory.refreshRemoteFolders(host);
    const choices = [
      { label: this.vscode.env.language.startsWith('zh') ? '连接主机' : 'Connect to host' },
      ...folders.map((folder) => ({ label: folder.folder, folderIndex: folder.index })),
    ];
    const picked = await this.vscode.window.showQuickPick(choices, { placeHolder: `SSH: ${host}` });
    if (picked) await this.openRemoteWindow(host, picked.folderIndex);
  }

  async openRemoteWindowForSidebar() {
    const state = this.sidebarState;
    if (state.page !== 'servers' && state.selected && state.selected.startsWith('ssh:')) await this.openRemoteWindowPicker(state.selected.slice(4));
  }

  async openRemoteWindowForEditor() {
    const source = this.activeEditorSource();
    if (source && source.state.selected.startsWith('ssh:')) await this.openRemoteWindowPicker(source.state.selected.slice(4));
  }

  async openTerminal(host) {
    if (!this.serverDirectory.hasHost(host)) return;
    await this.serverDirectory.runAction(host, 'terminal', () => {
      const configured = this.vscode.workspace.getConfiguration('remote.SSH').get('configFile');
      const args = configured ? ['-F', expandHome(configured), host] : [host];
      const terminal = this.vscode.window.createTerminal({ name: `SSH: ${host}`, shellPath: 'ssh', shellArgs: args });
      terminal.show();
    });
  }

  async openTerminalForSidebar() {
    const state = this.sidebarState;
    if (state.page !== 'servers' && state.selected && state.selected.startsWith('ssh:')) await this.openTerminal(state.selected.slice(4));
  }

  async openTerminalForEditor() {
    const source = this.activeEditorSource();
    if (source && source.state.selected.startsWith('ssh:')) await this.openTerminal(source.state.selected.slice(4));
  }

  async retryConnection(source, id) {
    if (!source || !source.ready || source.state.page === 'servers' || source.state.selected !== id || !id.startsWith('ssh:')) return;
    const device = this.manager.get(id);
    if (!device || !device.transport) {
      if (source.ready && this.sources().includes(source)) source.target.webview.postMessage({ cmd: 'retryConnectionResult', deviceId: id });
      return;
    }
    let task = this.retryingDevices.get(id);
    if (!task) {
      if (device.state !== 'disconnected') {
        if (source.ready && this.sources().includes(source)) source.target.webview.postMessage({ cmd: 'retryConnectionResult', deviceId: id });
        return;
      }
      task = this.retryDevice(id, device);
      this.retryingDevices.set(id, task);
    }
    const errorMessage = await task;
    if (this.retryingDevices.get(id) === task) this.retryingDevices.delete(id);
    if (source.ready && this.sources().includes(source)) source.target.webview.postMessage({ cmd: 'retryConnectionResult', deviceId: id, ...(errorMessage ? { error: errorMessage } : {}) });
  }

  async retryDevice(id, device) {
    const pausedAtStart = this.manager.paused;
    const sampleAfter = Date.now();
    try {
      await device.transport.retryNow();
      if (pausedAtStart && this.manager.paused && this.manager.get(id) === device) {
        device.service.resume({ force: true });
        try {
          await this.serverDirectory.waitForInitialSample(id.slice(4), sampleAfter, { allowPaused: true });
        } finally {
          if (this.manager.paused && this.manager.get(id) === device) device.service.pause();
        }
      }
      return null;
    } catch (error) {
      const errorMessage = error && error.message ? error.message : String(error);
      this.logger(`SSH retry ${id}: ${errorMessage}`);
      return errorMessage;
    }
  }

  async handleMessage(message, source) {
    if (!message || message.version !== 1 || typeof message.cmd !== 'string') return;
    const state = source.state;
    if (message.cmd === 'ready') {
      source.ready = true;
      source.target.webview.postMessage({ cmd: 'navigation', state });
      if (source.sidebar) source.target.webview.postMessage({ cmd: 'servers', hosts: this.serverRows() });
      source.target.webview.postMessage({ cmd: 'uiState', processDisplay: state.processDisplay, paused: this.manager.paused });
      this.sendCurrent(source);
    } else if (message.cmd === 'retryConnection' && typeof message.deviceId === 'string') await this.retryConnection(source, message.deviceId);
    else if (message.cmd === 'refreshServers' && source.sidebar) this.refreshHosts();
    else if (message.cmd === 'listRemoteFolders' && source.sidebar && typeof message.host === 'string' && this.serverDirectory.hasHost(message.host)) {
      const folders = await this.serverDirectory.refreshRemoteFolders(message.host);
      source.target.webview.postMessage({ cmd: 'remoteFolders', host: message.host, folders });
    }
    else if (message.cmd === 'openRemoteWindow' && source.sidebar && typeof message.host === 'string') await this.openRemoteWindow(message.host, message.folderIndex);
    else if (message.cmd === 'addSshDefaultExtension') {
      try {
        const configuration = this.vscode.workspace.getConfiguration('remote.SSH');
        const current = configuration.get('defaultExtensions');
        const entries = Array.isArray(current) ? current.slice() : [];
        if (!entries.some((value) => typeof value === 'string' && value.toLowerCase() === EXTENSION_ID.toLowerCase())) {
          await configuration.update('defaultExtensions', [...entries, EXTENSION_ID], true);
        }
        if (message.dismissIntro === true && this.uiStateStore) {
          try {
            await this.uiStateStore.update('sysmonitor.localIntroDismissed', true);
            this.broadcast({ cmd: 'localIntroDismissed' });
          }
          catch (error) { this.logger(`Local intro dismissal: ${error.message}`); }
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
    else if (message.cmd === 'openServer' && source.sidebar && typeof message.host === 'string' && this.serverDirectory.hasHost(message.host)) {
      const id = 'ssh:' + message.host;
      await this.serverDirectory.runAction(message.host, 'monitor', async () => {
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
    } else if (message.cmd === 'openTerminal' && source.sidebar && typeof message.host === 'string') await this.openTerminal(message.host);
    else if (message.cmd === 'switchDevice' && source.sidebar && state.tabs.includes(message.id)) {
      source.state = { ...state, selected: message.id, page: state.page === 'servers' ? 'perf' : state.page };
      this.persist(source, { hydrate: state.selected !== message.id });
    } else if (message.cmd === 'reorderDevices' && source.sidebar && Array.isArray(message.tabs)) {
      const original = new Set(state.tabs);
      if (message.tabs.length !== state.tabs.length || new Set(message.tabs).size !== original.size || !message.tabs.every((id) => original.has(id))) return;
      source.state = { ...state, tabs: message.tabs.slice() };
      this.persist(source);
    } else if (message.cmd === 'closeDevice' && source.sidebar && message.id !== 'local' && state.tabs.includes(message.id)) {
      const tabs = state.tabs.filter((id) => id !== message.id);
      const selected = state.selected === message.id ? tabs[0] || null : state.selected;
      source.state = { ...state, tabs, selected, page: selected ? state.page : 'servers' };
      this.persist(source, { hydrate: selected !== state.selected });
    } else if (message.cmd === 'switchPage' && (source.sidebar ? ['perf', 'proc', 'servers'] : ['perf', 'proc']).includes(message.page)) {
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
      if (message.key === 'servers') this.updateActionVisibility();
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
    this.serverDirectory.dispose();
  }
}

module.exports = { MultiMonitorViewProvider, normalizeNavigation, normalizeEditorNavigation };
