'use strict';
const { createTranslator } = require('../i18n');
const { isSshDefaultExtension, addSshDefaultExtension } = require('../config/ssh-default-extensions');

const crypto = require('node:crypto');
const { getWebviewHtml } = require('./webview-html');
const { monitorWebviewOptions, setMonitorPanelIcon, createMonitorEditorPanel, moveMonitorPanelToNewWindow } = require('./editor-panel');
const { setActionVisibilityContexts } = require('./action-visibility');
const { ServerDirectory } = require('./server-directory');
const { WebviewReadiness } = require('./webview-readiness');
const { ProcessDisplayPreference } = require('./process-display');
const { CONFIGURATION_KEYS } = require('../config/config-store');
const { webviewConfig } = require('../config/webview-config');
const { openSshTerminal, openSessionTerminal: launchSessionTerminal, processSession } = require('./ssh-terminal');

const STATE_KEY = 'sysmonitor.sidebarDevices';
const CONFIG_KEYS = new Set(CONFIGURATION_KEYS);

function normalizeNavigation(raw, localLinux) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const tabs = [...new Set((Array.isArray(source.tabs) ? source.tabs : []).filter((id) => typeof id === 'string' && (id === 'local' ? localLinux : /^ssh:[^\s\0-][^\s\0]*$/.test(id))))];
  if (localLinux && !tabs.includes('local')) tabs.unshift('local');
  const selected = tabs.includes(source.selected) ? source.selected : (localLinux ? 'local' : tabs[0] || null);
  const page = ['perf', 'proc', 'servers'].includes(source.page) ? source.page : (selected ? 'perf' : 'servers');
  return { tabs, selected, page: selected ? page : 'servers' };
}

function normalizeEditorNavigation(raw, localLinux) {
  const state = normalizeNavigation(raw, localLinux);
  if (!state.selected) return null;
  return { ...state, tabs: [state.selected], page: state.page === 'proc' ? 'proc' : 'perf' };
}

class MultiMonitorViewProvider {
  constructor({ vscode, manager, configStore, workspaceState, uiStateStore = null, localLinux, loadHosts, scheduleErrorClear, cancelErrorClear, scheduleReadyCheck, cancelReadyCheck, onLocalUpdate = () => {}, logger = () => {} }) {
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
    this.lastFocusedEditor = null;
    this.editorSshContext = null;
    this.actionVisibility = null;
    this.processDemandKey = '';
    this.processDisplay = new ProcessDisplayPreference({ store: uiStateStore, logger });
    this.readiness = new WebviewReadiness({ logger, scheduleReadyCheck, cancelReadyCheck,
      rebuildHtml: (source) => this.buildHtml(source.state, { sidebar: source.sidebar, webview: source.target.webview }) });
    this.serverDirectory = new ServerDirectory({ vscode, manager, loadHosts, scheduleErrorClear, cancelErrorClear, logger,
      onChange: (hosts, error) => this.postServers({ hosts, error }),
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
    return isSshDefaultExtension(this.vscode);
  }

  updateActionVisibility() {
    this.actionVisibility = setActionVisibilityContexts(this.vscode, this.configStore.getCurrent().servers, this.actionVisibility);
  }

  updateTitleActions() {
    if (!this.vscode.commands || !this.vscode.commands.executeCommand) return;
    const active = !!this.sidebarState.selected && this.sidebarState.page !== 'servers';
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
    return id === 'local' ? createTranslator(this.vscode.env.language)('local') : id.slice(4);
  }

  async buildHtml(state, { sidebar = false, webview = null } = {}) {
    const device = this.manager.get(state.selected);
    return getWebviewHtml({
      webview, vscode: this.vscode,
      initConfig: {
        ...webviewConfig(this.configStore, this.vscode),
        localMode: true, localLinux: this.localLinux,
        monitorStatus: device ? device.viewState() : null,
        surface: sidebar ? 'sidebar' : 'editor',
        showLocalIntro: sidebar && !this.localIntroDismissed(),
        language: this.vscode.env.language,
        navigation: state,
        processDisplay: this.processDisplay.get(),
        paused: this.manager.paused,
      },
      nonce: crypto.randomBytes(16).toString('base64'),
    });
  }

  localIntroDismissed() {
    return !!(this.uiStateStore && this.uiStateStore.get('sysmonitor.localIntroDismissed', false));
  }

  async resolveWebviewView(view) {
    if (this.sidebar) this.readiness.release(this.sidebar);
    const source = { target: view, state: this.sidebarState, ready: false, sidebar: true, label: 'sidebar', visible: !!view.visible };
    this.sidebar = source;
    view.webview.options = monitorWebviewOptions(this.vscode);
    view.webview.onDidReceiveMessage((message) => this.handleMessage(message, source));
    view.onDidDispose(() => {
      this.readiness.release(source);
      if (this.sidebar === source) this.sidebar = null;
      this.refreshReferences();
    });
    if (view.onDidChangeVisibility) view.onDidChangeVisibility(() => {
      this.readiness.visibilityChanged(source);
      this.refreshReferences();
    });
    const html = await this.buildHtml(source.state, { sidebar: true, webview: view.webview });
    if (this.sidebar !== source) return;
    view.webview.html = html;
    this.readiness.armReadyCheck(source);
    this.refreshReferences();
  }

  async attachEditor(panel, rawState) {
    const state = normalizeEditorNavigation(rawState, this.localLinux);
    if (!state) { panel.dispose(); return; }
    const source = { target: panel, state, ready: false, sidebar: false, label: 'editor', visible: !!panel.visible };
    this.editors.set(panel, source);
    if (panel.active) this.lastFocusedEditor = source;
    panel.title = this.deviceTitle(state.selected);
    setMonitorPanelIcon(this.vscode, panel);
    panel.webview.options = monitorWebviewOptions(this.vscode);
    panel.webview.onDidReceiveMessage((message) => this.handleMessage(message, source));
    panel.onDidDispose(() => {
      this.readiness.release(source);
      this.editors.delete(panel);
      if (this.lastFocusedEditor === source) this.lastFocusedEditor = null;
      this.updateEditorTitleActions();
      this.refreshReferences();
    });
    if (panel.onDidChangeViewState) panel.onDidChangeViewState(() => {
      if (panel.active) this.lastFocusedEditor = source;
      this.readiness.visibilityChanged(source);
      this.updateEditorTitleActions();
      this.refreshReferences();
    });
    const html = await this.buildHtml(state, { webview: panel.webview });
    if (this.editors.get(panel) !== source) return;
    panel.webview.html = html;
    this.readiness.armReadyCheck(source);
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
    const viewState = { tabs: [id], selected: id, page: current.page };
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
  broadcast(message) { for (const source of this.sources()) if (source.ready) this.readiness.post(source, message); }

  postServers(payload = this.serverDirectory.current()) {
    const sidebar = this.sidebar;
    if (!sidebar || !sidebar.ready || !sidebar.target.visible || sidebar.state.page !== 'servers') return;
    this.readiness.post(sidebar, { cmd: 'servers', hosts: payload.hosts, ...(payload.error ? { error: payload.error } : {}) });
  }

  refreshReferences() {
    const open = new Set(this.sidebarState.tabs);
    const visible = new Set();
    const processViews = new Set();
    for (const source of this.sources()) {
      for (const id of source.state.tabs) open.add(id);
      if (!source.target.visible || !source.state.selected) continue;
      if (source.state.page !== 'servers') visible.add(source.state.selected);
      if (source.state.page === 'proc') processViews.add(source.state.selected);
    }
    const previous = this.serverDirectory.hosts.map((host) => !!this.manager.get('ssh:' + host));
    this.manager.sync(open, visible);
    this.updateProcessDemand(processViews);
    if (this.serverDirectory.hosts.some((host, index) => previous[index] !== !!this.manager.get('ssh:' + host))) this.serverDirectory.notify();
  }

  updateProcessDemand(ids) {
    const key = [...ids].sort().join('\n');
    if (key === this.processDemandKey) return;
    this.processDemandKey = key;
    if (typeof this.manager.setProcessDemand === 'function') this.manager.setProcessDemand(ids);
  }

  persist(source, { hydrate = false } = {}) {
    if (source.sidebar) {
      this.sidebarState = source.state;
      this.workspaceState.update(STATE_KEY, source.state).catch((error) => this.logger(error.message));
      this.updateTitleActions();
    }
    if (!hydrate) {
      this.readiness.post(source, { cmd: 'navigation', state: source.state });
      this.refreshReferences();
    } else {
      source.switching = true;
      this.refreshReferences();
      const device = this.manager.get(source.state.selected);
      this.readiness.post(source, {
        ...(device ? device.snapshotMessage(true) : { viewModel: null, samples: [], connection: null, status: { ready: false, hasSnapshot: false } }),
        cmd: 'deviceState', state: source.state, deviceId: source.state.selected,
      });
      source.switching = false;
    }
    if (source.sidebar) this.postServers();
  }

  sendCurrent(source) {
    if (!source.state.selected) return;
    const device = this.manager.get(source.state.selected);
    if (device) this.readiness.post(source, device.snapshotMessage(true));
  }

  onDeviceUpdate(id, device) {
    if (id === 'local' && device.model) this.onLocalUpdate(device.model);
    let message = null;
    for (const source of this.sources()) {
      if (source.ready && !source.switching && source.state.selected === id) {
        message = message || device.snapshotMessage();
        this.readiness.post(source, message);
      }
    }
    this.serverDirectory.onDeviceUpdate(id, device);
  }

  pushConfig() {
    this.broadcast({ cmd: 'config', ...webviewConfig(this.configStore, this.vscode) });
  }

  async openRemoteWindow(host, folderIndex) {
    if (!this.serverDirectory.hasHost(host)) return;
    const folder = this.serverDirectory.remoteFolder(host, folderIndex);
    if (folderIndex !== undefined && !folder) return;
    await this.serverDirectory.runShortcutAction(host, 'remoteWindow', async () => {
      if (!folder) { await this.serverDirectory.openEmptyRemoteWindow(host); return; }
      const uri = this.vscode.Uri.from({ scheme: 'vscode-remote', authority: `ssh-remote+${folder.remote}`, path: folder.folder });
      const opened = await this.vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
      if (opened === false) throw new Error('Could not open remote folder');
    });
  }

  async openRemoteWindowPicker(host) {
    const folders = await this.serverDirectory.refreshRemoteFolders(host);
    const choices = [
      { label: createTranslator(this.vscode.env.language)('connectToHost') },
      ...folders.map((folder) => ({ label: folder.folder, folderIndex: folder.index })),
    ];
    const picked = await this.vscode.window.showQuickPick(choices, { placeHolder: `SSH: ${host}` });
    if (picked) await this.openRemoteWindow(host, picked.folderIndex);
  }

  async activateRemoteWindow(host, source = null) {
    if (!this.serverDirectory.hasHost(host)) return;
    const mode = this.configStore.getCurrent().servers.remoteWindowMode || 'menu';
    if (mode === 'menu') {
      if (!source) { await this.openRemoteWindowPicker(host); return; }
      const folders = await this.serverDirectory.refreshRemoteFolders(host);
      this.readiness.post(source, { cmd: 'remoteFolders', host, folders });
      return;
    }
    try {
      const folders = mode === 'recent' ? await this.serverDirectory.refreshRemoteFolders(host) : [];
      await this.openRemoteWindow(host, folders.length ? folders[0].index : undefined);
    } finally {
      if (source) this.readiness.post(source, { cmd: 'remoteWindowActionDone', host });
    }
  }

  async openRemoteWindowForSidebar() {
    const state = this.sidebarState;
    if (state.page !== 'servers' && state.selected && state.selected.startsWith('ssh:')) await this.activateRemoteWindow(state.selected.slice(4));
  }

  async openRemoteWindowForEditor() {
    const source = this.activeEditorSource();
    if (source && source.state.selected.startsWith('ssh:')) await this.activateRemoteWindow(source.state.selected.slice(4));
  }

  sshConfigFile() {
    return this.vscode.workspace.getConfiguration('remote.SSH').get('configFile');
  }

  async openTerminal(host) {
    if (!this.serverDirectory.hasHost(host)) return;
    await this.serverDirectory.runShortcutAction(host, 'terminal', () => {
      openSshTerminal(this.vscode, host, this.sshConfigFile());
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

  openSessionTerminal(source, deviceId, pid) {
    if (!source.state.tabs.includes(deviceId)) return;
    const t = createTranslator(this.vscode.env.language);
    const device = this.manager.get(deviceId);
    const session = processSession(device && device.model, pid);
    if (!session) {
      this.vscode.window.showWarningMessage(t('sessionNotFound'));
      return;
    }
    const host = deviceId === 'local' ? null : deviceId.slice(4);
    try {
      launchSessionTerminal(this.vscode, session, {
        host, configFile: host ? this.sshConfigFile() : null,
        failureMessage: t('sessionAttachFailed', { name: session.name }),
      });
    } catch (error) {
      this.logger(`Session terminal ${deviceId}: ${error.message}`);
      this.vscode.window.showErrorMessage(error.message);
    }
  }

  async retryConnection(source, id) {
    if (!source || !source.ready || source.state.page === 'servers' || source.state.selected !== id) return;
    const device = this.manager.get(id);
    let errorMessage = null;
    if (device) {
      try { await device.retry(); }
      catch (error) { errorMessage = error.message; this.logger('Monitor retry ' + id + ': ' + error.message); }
    }
    if (source.ready && this.sources().includes(source)) {
      this.readiness.post(source, { cmd: 'retryConnectionResult', deviceId: id, ...(errorMessage ? { error: errorMessage } : {}) });
    }
  }

  async handleMessage(message, source) {
    if (!message || message.version !== 1 || typeof message.cmd !== 'string') return;
    const state = source.state;
    if (message.cmd === 'ready') {
      this.readiness.markReady(source);
      this.readiness.post(source, { cmd: 'config', ...webviewConfig(this.configStore, this.vscode) });
      this.readiness.post(source, { cmd: 'navigation', state });
      if (source.sidebar) this.postServers();
      this.readiness.post(source, { cmd: 'uiState', processDisplay: this.processDisplay.get(), paused: this.manager.paused });
      if (source.sidebar && this.localIntroDismissed()) this.readiness.post(source, { cmd: 'localIntroDismissed' });
      this.sendCurrent(source);
    } else if ((message.cmd === 'retryConnection' || message.cmd === 'retrySampling') && typeof message.deviceId === 'string') await this.retryConnection(source, message.deviceId);
    else if (message.cmd === 'refreshServers' && source.sidebar) this.refreshHosts();
    else if (message.cmd === 'activateRemoteWindow' && source.sidebar && typeof message.host === 'string') await this.activateRemoteWindow(message.host, source);
    else if (message.cmd === 'openRemoteWindow' && source.sidebar && typeof message.host === 'string') await this.openRemoteWindow(message.host, message.folderIndex);
    else if (message.cmd === 'addSshDefaultExtension') {
      try {
        await addSshDefaultExtension(this.vscode);
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
      await this.serverDirectory.runMonitorAction(message.host, async () => {
        if (message.inWindow) {
          await this.openFloatingPanel({ tabs: [id], selected: id, page: 'perf' });
        } else if (message.inEditor) {
          await this.openEditorPanel({ tabs: [id], selected: id, page: 'perf' });
        } else {
          const current = source.state;
          source.state = normalizeNavigation({ ...current, tabs: [...current.tabs, id], selected: id, page: 'perf' }, this.localLinux);
          this.persist(source, { hydrate: current.selected !== id });
        }
      });
    } else if (message.cmd === 'openTerminal' && source.sidebar && typeof message.host === 'string') await this.openTerminal(message.host);
    else if (message.cmd === 'openSessionTerminal' && typeof message.deviceId === 'string') this.openSessionTerminal(source, message.deviceId, message.pid);
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
    } else if (message.cmd === 'setProcessDisplay') {
      const processDisplay = this.processDisplay.set(message.key, message.value);
      if (processDisplay) this.broadcast({ cmd: 'uiState', processDisplay });
    } else if (message.cmd === 'setConfig' && CONFIG_KEYS.has(message.key)) {
      try { this.configStore.update(message.key, message.changes); } catch (error) { this.logger(error.message); }
    } else if (message.cmd === 'retryConfigSave') {
      this.configStore.flush().catch(() => {});
    } else if (message.cmd === 'openSettings') this.vscode.commands.executeCommand('workbench.action.openSettings', 'sysmonitor');
    else if (message.cmd === 'openLink' && typeof message.url === 'string' && /^https:\/\//.test(message.url)) this.vscode.env.openExternal(this.vscode.Uri.parse(message.url));
    else if (message.cmd === 'pause' && typeof message.value === 'boolean') {
      this.manager.setPaused(message.value);
    }
  }

  async notifyResidualProcesses(host, pids, acknowledge) {
    const t = createTranslator(this.vscode.env.language);
    const copy = t("copyPIDs");
    const understood = t("gotIt");
    const message = t("remotePerformanceCollectionHasTimedOutRepeatedlyServer", { host, pids });
    for (;;) {
      const choice = await this.vscode.window.showWarningMessage(message, copy, understood);
      if (choice === understood) { acknowledge(); return; }
      if (choice !== copy) return;
      try { await this.vscode.env.clipboard.writeText(pids.join(', ')); }
      catch (error) { this.logger(error.message); }
    }
  }

  dispose() {
    for (const source of this.sources()) this.readiness.release(source);
    this.serverDirectory.dispose();
  }
}

module.exports = { MultiMonitorViewProvider, normalizeNavigation, normalizeEditorNavigation };
