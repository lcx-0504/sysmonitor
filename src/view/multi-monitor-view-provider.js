'use strict';
const { MonitorViewHost } = require('./monitor-view-host');
const { createMonitorEditorPanel } = require('./editor-panel');
const { TITLE_CONTEXTS } = require('./action-visibility');
const { ServerDirectory } = require('./server-directory');
const { openSshTerminal } = require('./ssh-terminal');
const { TO_EXTENSION, TO_WEBVIEW } = require('./protocol');
const { LOCAL_DEVICE_ID, sshDeviceId, isLocalDeviceId, isSshDeviceId, deviceHost } = require('../domain/device-id');

const STATE_KEY = 'sysmonitor.sidebarDevices';
const LOCAL_INTRO_DISMISSED_KEY = 'sysmonitor.localIntroDismissed';
const SIDEBAR_PAGES = Object.freeze(['perf', 'proc', 'servers']);
const EDITOR_PAGES = Object.freeze(['perf', 'proc']);
const RESTORABLE_HOST = /^[^\s\0-][^\s\0]*$/;

function isRestorableDevice(id, localLinux) {
  if (isLocalDeviceId(id)) return !!localLinux;
  return isSshDeviceId(id) && RESTORABLE_HOST.test(deviceHost(id));
}

function normalizeNavigation(raw, localLinux) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const savedTabs = Array.isArray(source.tabs) ? source.tabs : [];
  const tabs = [...new Set(savedTabs.filter((id) => isRestorableDevice(id, localLinux)))];
  if (localLinux && !tabs.includes(LOCAL_DEVICE_ID)) tabs.unshift(LOCAL_DEVICE_ID);
  const fallback = localLinux ? LOCAL_DEVICE_ID : tabs[0] || null;
  const selected = tabs.includes(source.selected) ? source.selected : fallback;
  const page = SIDEBAR_PAGES.includes(source.page) ? source.page : 'perf';
  return { tabs, selected, page: selected ? page : 'servers' };
}

function normalizeEditorNavigation(raw, localLinux) {
  const state = normalizeNavigation(raw, localLinux);
  if (!state.selected) return null;
  return { ...state, tabs: [state.selected], page: state.page === 'proc' ? 'proc' : 'perf' };
}

function selectionAfterMove(tabs, localLinux) {
  if (localLinux && tabs.includes(LOCAL_DEVICE_ID)) return LOCAL_DEVICE_ID;
  return tabs[0] || null;
}

function isReordering(tabs, current) {
  if (!Array.isArray(tabs) || tabs.length !== current.length) return false;
  const original = new Set(current);
  return new Set(tabs).size === original.size && tabs.every((id) => original.has(id));
}

function emptyDeviceSnapshot() {
  return { viewModel: null, samples: [], connection: null, status: { ready: false, hasSnapshot: false } };
}

const hasDeviceId = (provider, message) => typeof message.deviceId === 'string';
const fromSidebar = (provider, message, record) => !!record.sidebar;
const hostFromSidebar = (provider, message, record) => !!record.sidebar && typeof message.host === 'string';

const DEVICE_MESSAGE_HANDLERS = Object.freeze({
  [TO_EXTENSION.retryConnection]: {
    accepts: hasDeviceId,
    run: (provider, message, record) => provider.retryConnection(record, message.deviceId),
  },
  [TO_EXTENSION.retrySampling]: {
    accepts: hasDeviceId,
    run: (provider, message, record) => provider.retryConnection(record, message.deviceId),
  },
  [TO_EXTENSION.openSessionTerminal]: {
    accepts: hasDeviceId,
    run: (provider, message, record) => provider.openDeviceSessionTerminal(record, message.deviceId, message.pid),
  },
  [TO_EXTENSION.dismissLocalIntro]: {
    accepts: (provider) => !!provider.uiStateStore,
    run: (provider) => provider.dismissLocalIntro(),
  },
  [TO_EXTENSION.refreshServers]: {
    accepts: fromSidebar,
    run: (provider) => provider.refreshHosts(),
  },
  [TO_EXTENSION.openServer]: {
    accepts: (provider, message, record) => hostFromSidebar(provider, message, record) && provider.serverDirectory.hasHost(message.host),
    run: (provider, message, record) => provider.openServer(record, message),
  },
  [TO_EXTENSION.openTerminal]: {
    accepts: hostFromSidebar,
    run: (provider, message) => provider.openTerminal(message.host),
  },
  [TO_EXTENSION.activateRemoteWindow]: {
    accepts: hostFromSidebar,
    run: (provider, message, record) => provider.activateRemoteWindow(message.host, record),
  },
  [TO_EXTENSION.openRemoteWindow]: {
    accepts: hostFromSidebar,
    run: (provider, message) => provider.openRemoteWindow(message.host, message.folderIndex),
  },
  [TO_EXTENSION.switchDevice]: {
    accepts: (provider, message, record) => !!record.sidebar && record.state.tabs.includes(message.id),
    run: (provider, message, record) => provider.switchDevice(record, message.id),
  },
  [TO_EXTENSION.reorderDevices]: {
    accepts: (provider, message, record) => !!record.sidebar && isReordering(message.tabs, record.state.tabs),
    run: (provider, message, record) => provider.reorderDevices(record, message.tabs),
  },
  [TO_EXTENSION.closeDevice]: {
    accepts: (provider, message, record) => !!record.sidebar && !isLocalDeviceId(message.id) && record.state.tabs.includes(message.id),
    run: (provider, message, record) => provider.closeDevice(record, message.id),
  },
});

class MultiMonitorViewProvider extends MonitorViewHost {
  constructor({ manager, workspaceState, localLinux, loadHosts, scheduleErrorClear, cancelErrorClear, onLocalUpdate = () => {}, ...options }) {
    super({ ...options, messageHandlers: DEVICE_MESSAGE_HANDLERS });
    this.manager = manager;
    this.workspaceState = workspaceState;
    this.localLinux = localLinux;
    this.onLocalUpdate = onLocalUpdate;
    this.editorSshContext = null;
    this.serverDirectory = new ServerDirectory({
      vscode: this.vscode, manager, loadHosts, scheduleErrorClear, cancelErrorClear, logger: this.logger,
      onChange: (hosts, error) => this.postServers({ hosts, error }),
      onActionError: () => this.refreshReferences(),
    });
    const saved = this.configStore.getCurrent().servers.restoreTabs ? workspaceState.get(STATE_KEY, {}) : {};
    this.sidebarState = normalizeNavigation(saved, localLinux);
    this.updateTitleActions();
    this.updateEditorTitleActions();
    this.refreshReferences();
    this.refreshHosts();
  }

  refreshHosts() {
    return this.serverDirectory.refresh();
  }

  isPaused() {
    return this.manager.isPaused();
  }

  setPaused(paused) {
    this.manager.setPaused(paused);
  }

  updateTitleActions() {
    if (!this.vscode.commands || !this.vscode.commands.executeCommand) return;
    const { selected, page } = this.sidebarState;
    const active = !!selected && page !== 'servers';
    this.vscode.commands.executeCommand('setContext', TITLE_CONTEXTS.sidebarSsh, active && isSshDeviceId(selected));
    this.vscode.commands.executeCommand('setContext', TITLE_CONTEXTS.sidebarFixed, active && isLocalDeviceId(selected));
  }

  updateEditorTitleActions() {
    if (!this.vscode.commands || !this.vscode.commands.executeCommand) return;
    const record = this.activeEditor();
    if (!record && this.editors.size) return;
    const sshActive = !!record && isSshDeviceId(record.state.selected);
    if (sshActive === this.editorSshContext) return;
    this.editorSshContext = sshActive;
    this.vscode.commands.executeCommand('setContext', TITLE_CONTEXTS.editorSsh, sshActive);
  }

  deviceTitle(id) {
    return isLocalDeviceId(id) ? this.translator()('localDevice') : deviceHost(id);
  }

  initialViewConfig(record) {
    const device = this.manager.get(record.state.selected);
    return {
      localMode: true,
      localLinux: this.localLinux,
      monitorStatus: device ? device.viewState() : null,
      showLocalIntro: record.sidebar && !this.localIntroDismissed(),
      navigation: record.state,
    };
  }

  localIntroDismissed() {
    return !!(this.uiStateStore && this.uiStateStore.get(LOCAL_INTRO_DISMISSED_KEY, false));
  }

  sidebarFields() {
    return { state: this.sidebarState };
  }

  editorTitle(record) {
    return this.deviceTitle(record.state.selected);
  }

  async attachEditor(panel, rawState) {
    const state = normalizeEditorNavigation(rawState, this.localLinux);
    if (!state) {
      panel.dispose();
      return;
    }
    await this.mountEditor(panel, { state });
  }

  restoreEditor(panel, state) {
    return this.attachEditor(panel, state && state.navigation ? state.navigation : state);
  }

  async openEditorPanel(initialState = this.sidebarState) {
    const state = normalizeEditorNavigation(initialState, this.localLinux);
    if (!state) return null;
    const panel = createMonitorEditorPanel(this.vscode, this.deviceTitle(state.selected));
    await this.attachEditor(panel, state);
    return panel;
  }

  async returnActiveEditorToSidebar() {
    const record = this.activeEditor();
    if (!record) return;
    const id = record.state.selected;
    const previous = this.sidebarState;
    const state = normalizeNavigation({ ...previous, tabs: [...previous.tabs, id], selected: id, page: record.state.page }, this.localLinux);
    this.sidebarState = state;
    if (this.sidebar) {
      this.sidebar.state = state;
      this.persist(this.sidebar, { hydrate: previous.selected !== id });
    } else {
      await this.workspaceState.update(STATE_KEY, state);
      this.updateTitleActions();
    }
    await this.revealSidebar();
    record.target.dispose();
  }

  async moveSidebarDeviceToEditor(floating = false) {
    const current = this.sidebarState;
    if (!current.selected || current.page === 'servers') return;
    const id = current.selected;
    const viewState = { tabs: [id], selected: id, page: current.page };
    const panel = floating ? await this.openFloatingPanel(viewState) : await this.openEditorPanel(viewState);
    if (!panel || isLocalDeviceId(id)) return;
    const latest = this.sidebarState;
    if (!latest.tabs.includes(id)) return;
    const tabs = latest.tabs.filter((tab) => tab !== id);
    const selected = latest.selected === id ? selectionAfterMove(tabs, this.localLinux) : latest.selected;
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

  postServers(payload = this.serverDirectory.current()) {
    const sidebar = this.sidebar;
    if (!sidebar || !sidebar.ready || !sidebar.target.visible || sidebar.state.page !== 'servers') return;
    const message = { cmd: TO_WEBVIEW.servers, hosts: payload.hosts };
    if (payload.error) message.error = payload.error;
    this.readiness.post(sidebar, message);
  }

  viewsChanged() {
    this.updateEditorTitleActions();
    this.refreshReferences();
  }

  refreshReferences() {
    const open = new Set(this.sidebarState.tabs);
    const visible = new Set();
    for (const record of this.records()) {
      for (const id of record.state.tabs) open.add(id);
      if (record.target.visible && record.state.selected && record.state.page !== 'servers') visible.add(record.state.selected);
    }
    const hosts = this.serverDirectory.hosts;
    const isOpen = (host) => !!this.manager.get(sshDeviceId(host));
    const previous = hosts.map(isOpen);
    this.manager.sync(open, visible);
    if (hosts.some((host, index) => previous[index] !== isOpen(host))) this.serverDirectory.notify();
  }

  persist(record, { hydrate = false } = {}) {
    if (record.sidebar) {
      this.sidebarState = record.state;
      this.workspaceState.update(STATE_KEY, record.state).catch((error) => this.logger(error.message));
      this.updateTitleActions();
    }
    if (hydrate) this.hydrate(record);
    else {
      this.readiness.post(record, { cmd: TO_WEBVIEW.navigation, state: record.state });
      this.refreshReferences();
    }
    if (record.sidebar) this.postServers();
  }

  hydrate(record) {
    record.switching = true;
    this.refreshReferences();
    const device = this.manager.get(record.state.selected);
    const snapshot = device ? device.snapshotState(true) : emptyDeviceSnapshot();
    this.readiness.post(record, { ...snapshot, cmd: TO_WEBVIEW.deviceState, state: record.state, deviceId: record.state.selected });
    record.switching = false;
  }

  sendCurrent(record) {
    if (!record.state.selected) return;
    const device = this.manager.get(record.state.selected);
    if (device) this.readiness.post(record, this.snapshotMessage(device, true));
  }

  onDeviceUpdate(id, device) {
    if (isLocalDeviceId(id) && device.model) this.onLocalUpdate(device.model);
    let message = null;
    for (const record of this.records()) {
      if (!record.ready || record.switching || record.state.selected !== id) continue;
      message = message || this.snapshotMessage(device);
      this.readiness.post(record, message);
    }
    this.serverDirectory.onDeviceUpdate(id, device);
  }

  pagesFor(record) {
    return record.sidebar ? SIDEBAR_PAGES : EDITOR_PAGES;
  }

  showPage(record, page) {
    record.state = { ...record.state, page };
    this.persist(record);
  }

  handleReady(record) {
    this.readiness.markReady(record);
    this.postConfig(record);
    this.readiness.post(record, { cmd: TO_WEBVIEW.navigation, state: record.state });
    if (record.sidebar) this.postServers();
    this.postUiState(record);
    if (record.sidebar && this.localIntroDismissed()) this.readiness.post(record, { cmd: TO_WEBVIEW.localIntroDismissed });
    this.sendCurrent(record);
  }

  async openServer(record, { host, inWindow, inEditor }) {
    const id = sshDeviceId(host);
    const viewState = { tabs: [id], selected: id, page: 'perf' };
    await this.serverDirectory.runMonitorAction(host, async () => {
      if (inWindow) await this.openFloatingPanel(viewState);
      else if (inEditor) await this.openEditorPanel(viewState);
      else this.showDeviceInSidebar(record, id);
    });
  }

  showDeviceInSidebar(record, id) {
    const current = record.state;
    record.state = normalizeNavigation({ ...current, tabs: [...current.tabs, id], selected: id, page: 'perf' }, this.localLinux);
    this.persist(record, { hydrate: current.selected !== id });
  }

  switchDevice(record, id) {
    const state = record.state;
    record.state = { ...state, selected: id, page: state.page === 'servers' ? 'perf' : state.page };
    this.persist(record, { hydrate: state.selected !== id });
  }

  reorderDevices(record, tabs) {
    record.state = { ...record.state, tabs: tabs.slice() };
    this.persist(record);
  }

  closeDevice(record, id) {
    const state = record.state;
    const tabs = state.tabs.filter((tab) => tab !== id);
    const selected = state.selected === id ? tabs[0] || null : state.selected;
    record.state = { ...state, tabs, selected, page: selected ? state.page : 'servers' };
    this.persist(record, { hydrate: selected !== state.selected });
  }

  dismissLocalIntro() {
    this.uiStateStore.update(LOCAL_INTRO_DISMISSED_KEY, true).catch((error) => this.logger(error.message));
    this.broadcast({ cmd: TO_WEBVIEW.localIntroDismissed });
  }

  async onSshDefaultExtensionInstalled(message) {
    if (message.dismissIntro !== true || !this.uiStateStore) return;
    try {
      await this.uiStateStore.update(LOCAL_INTRO_DISMISSED_KEY, true);
      this.broadcast({ cmd: TO_WEBVIEW.localIntroDismissed });
    } catch (error) {
      this.logger(`Local intro dismissal: ${error.message}`);
    }
  }

  async retryConnection(record, id) {
    const state = record.state;
    if (!record.ready) return;
    if (state.page === 'servers' || state.selected !== id) {
      this.readiness.post(record, { cmd: TO_WEBVIEW.retryConnectionResult, deviceId: id });
      return;
    }
    await this.retryDevice(record, id, this.manager.get(id));
  }

  openDeviceSessionTerminal(record, deviceId, pid) {
    if (!record.state.tabs.includes(deviceId)) return;
    this.openSessionTerminal(deviceId, this.manager.get(deviceId), pid);
  }

  async openRemoteWindow(host, folderIndex) {
    if (!this.serverDirectory.hasHost(host)) return;
    const folder = this.serverDirectory.remoteFolder(host, folderIndex);
    if (folderIndex !== undefined && !folder) return;
    await this.serverDirectory.runShortcutAction(host, 'remoteWindow', async () => {
      if (!folder) {
        await this.serverDirectory.openEmptyRemoteWindow(host);
        return;
      }
      const uri = this.vscode.Uri.from({ scheme: 'vscode-remote', authority: `ssh-remote+${folder.remote}`, path: folder.folder });
      const opened = await this.vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
      if (opened === false) throw new Error('Could not open remote folder');
    });
  }

  async openRemoteWindowPicker(host) {
    const folders = await this.serverDirectory.refreshRemoteFolders(host);
    const choices = [
      { label: this.translator()('connectToHost') },
      ...folders.map((folder) => ({ label: folder.folder, folderIndex: folder.index })),
    ];
    const picked = await this.vscode.window.showQuickPick(choices, { placeHolder: `SSH: ${host}` });
    if (picked) await this.openRemoteWindow(host, picked.folderIndex);
  }

  async activateRemoteWindow(host, record = null) {
    if (!this.serverDirectory.hasHost(host)) return;
    const mode = this.configStore.getCurrent().servers.remoteWindowMode || 'menu';
    if (mode === 'menu') {
      if (!record) {
        await this.openRemoteWindowPicker(host);
        return;
      }
      const folders = await this.serverDirectory.refreshRemoteFolders(host);
      this.readiness.post(record, { cmd: TO_WEBVIEW.remoteFolders, host, folders });
      return;
    }
    try {
      const folders = mode === 'recent' ? await this.serverDirectory.refreshRemoteFolders(host) : [];
      await this.openRemoteWindow(host, folders.length ? folders[0].index : undefined);
    } finally {
      if (record) this.readiness.post(record, { cmd: TO_WEBVIEW.remoteWindowActionDone, host });
    }
  }

  sidebarSshHost() {
    const state = this.sidebarState;
    return state.page === 'servers' ? null : deviceHost(state.selected);
  }

  editorSshHost() {
    const record = this.activeEditor();
    return record ? deviceHost(record.state.selected) : null;
  }

  async openRemoteWindowForSidebar() {
    const host = this.sidebarSshHost();
    if (host) await this.activateRemoteWindow(host);
  }

  async openRemoteWindowForEditor() {
    const host = this.editorSshHost();
    if (host) await this.activateRemoteWindow(host);
  }

  async openTerminal(host) {
    if (!this.serverDirectory.hasHost(host)) return;
    await this.serverDirectory.runShortcutAction(host, 'terminal', () => {
      openSshTerminal(this.vscode, host, this.sshConfigFile());
    });
  }

  async openTerminalForSidebar() {
    const host = this.sidebarSshHost();
    if (host) await this.openTerminal(host);
  }

  async openTerminalForEditor() {
    const host = this.editorSshHost();
    if (host) await this.openTerminal(host);
  }

  async notifyResidualProcesses(host, pids, acknowledge) {
    const t = this.translator();
    const copy = t('copyPIDs');
    const understood = t('gotIt');
    const message = t('residualProcesses', { host, pids });
    for (;;) {
      const choice = await this.vscode.window.showWarningMessage(message, copy, understood);
      if (choice === understood) {
        acknowledge();
        return;
      }
      if (choice !== copy) return;
      try {
        await this.vscode.env.clipboard.writeText(pids.join(', '));
      } catch (error) {
        this.logger(error.message);
      }
    }
  }

  dispose() {
    super.dispose();
    this.serverDirectory.dispose();
  }
}

module.exports = { MultiMonitorViewProvider, normalizeNavigation, normalizeEditorNavigation };
