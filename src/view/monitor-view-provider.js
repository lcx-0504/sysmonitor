'use strict';
const crypto = require('node:crypto');
const os = require('node:os');
const { buildMonitorViewModel } = require('../services/monitor-view-model');
const { getWebviewHtml } = require('./webview-html');
const { setMonitorPanelIcon, createMonitorEditorPanel, moveMonitorPanelToNewWindow } = require('./editor-panel');
const { setActionVisibilityContexts } = require('./action-visibility');

const CONFIG_KEYS = new Set(['refreshInterval', 'statusBar', 'disk', 'display', 'servers']);

class MonitorViewProvider {
  constructor({ vscode, monitorService, configStore, uiStateStore = null, onConfigUpdated = () => {}, logger = () => {} }) {
    this.vscode = vscode; this.monitorService = monitorService; this.configStore = configStore; this.onConfigUpdated = onConfigUpdated; this.logger = logger;
    this.uiStateStore = uiStateStore;
    this.processDisplayState = null;
    this.view = null;
    this.isReady = false;
    this.editorPanels = new Map();
    this.editorPages = new Map();
    this.lastFocusedEditor = null;
    this.lastViewModel = null;
    this.sidebarPage = 'perf';
    this.pendingSidebarPage = null;
    this.actionVisibility = null;
    this.updateActionVisibility();
  }

  updateActionVisibility() {
    if (!this.configStore.getCurrent) return;
    this.actionVisibility = setActionVisibilityContexts(this.vscode, this.configStore.getCurrent().servers, this.actionVisibility);
  }

  getUiState() {
    if (!this.processDisplayState) {
      const stored = (this.uiStateStore ? this.uiStateStore.get('sysmonitor.processDisplay', {}) : {}) || {};
      this.processDisplayState = { cpu: ['core', 'whole', 'both'].includes(stored.cpu) ? stored.cpu : 'core', ram: ['size', 'percent', 'both'].includes(stored.ram) ? stored.ram : 'size' };
    }
    return this.processDisplayState;
  }

  async buildHtml(initialPage = 'perf', surface = 'sidebar') {
    const config = this.configStore.getCurrent();
    const acceleratorValue = this.monitorService.readSnapshot().accelerators.value;
    return getWebviewHtml({
      initConfig: { surface, interval: config.refreshInterval, barCfg: config.statusBar, diskCfg: config.disk, displayCfg: config.display, serversCfg: config.servers, gpuCount: acceleratorValue ? acceleratorValue.devices.length : null, processDisplay: this.getUiState(), paused: this.monitorService.scheduler.isPaused, page: initialPage },
      nonce: crypto.randomBytes(16).toString('base64'),
    });
  }

  async resolveWebviewView(view) {
    this.view = view;
    this.isReady = false;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((message) => this.handleMessage(message, view));
    view.onDidDispose(() => { this.view = null; this.isReady = false; });
    const html = await this.buildHtml(this.sidebarPage);
    if (this.view === view) view.webview.html = html;
  }

  async openEditorPanel(page = this.sidebarPage) {
    const panel = createMonitorEditorPanel(this.vscode, os.hostname());
    await this.attachEditorPanel(panel, { page });
    return panel;
  }

  activeEditorPanel() {
    const active = [...this.editorPanels.keys()].find((panel) => panel.active);
    if (active) {
      this.lastFocusedEditor = active;
      return active;
    }
    if (this.lastFocusedEditor && this.editorPanels.has(this.lastFocusedEditor) && this.lastFocusedEditor.visible !== false) return this.lastFocusedEditor;
    const visible = [...this.editorPanels.keys()].filter((panel) => panel.visible !== false);
    return visible.length === 1 ? visible[0] : null;
  }

  async returnActiveEditorToSidebar() {
    const panel = this.activeEditorPanel();
    if (!panel) return;
    const page = this.editorPages.get(panel) || 'perf';
    this.sidebarPage = page;
    if (!this.isReady) this.pendingSidebarPage = page;
    if (this.view) {
      if (this.isReady) this.view.webview.postMessage({ cmd: 'navigatePage', page });
      if (typeof this.view.show === 'function') this.view.show();
      else await this.vscode.commands.executeCommand('workbench.view.extension.sysmonitor-container');
    } else await this.vscode.commands.executeCommand('workbench.view.extension.sysmonitor-container');
    panel.dispose();
  }

  async moveActiveEditorToNewWindow() {
    const panel = this.activeEditorPanel();
    if (panel) await moveMonitorPanelToNewWindow(this.vscode, panel, { disposeOnError: false });
  }

  async openFloatingPanel() {
    const panel = await this.openEditorPanel();
    await moveMonitorPanelToNewWindow(this.vscode, panel);
  }

  async attachEditorPanel(panel, state = {}) {
    panel.title = os.hostname();
    setMonitorPanelIcon(this.vscode, panel);
    panel.webview.options = { enableScripts: true };
    this.editorPanels.set(panel, false);
    if (panel.active) this.lastFocusedEditor = panel;
    this.editorPages.set(panel, state && state.page === 'proc' ? 'proc' : 'perf');
    panel.webview.onDidReceiveMessage((message) => this.handleMessage(message, panel));
    panel.onDidDispose(() => {
      this.editorPanels.delete(panel);
      this.editorPages.delete(panel);
      if (this.lastFocusedEditor === panel) this.lastFocusedEditor = null;
    });
    if (panel.onDidChangeViewState) panel.onDidChangeViewState(() => { if (panel.active) this.lastFocusedEditor = panel; });
    const html = await this.buildHtml(state && state.page === 'proc' ? 'proc' : 'perf', 'editor');
    if (this.editorPanels.has(panel)) panel.webview.html = html;
  }

  handleMessage(message, source = this.view) {
    if (!message || typeof message !== 'object' || (message.version !== undefined && message.version !== 1) || typeof message.cmd !== 'string') return;
    if (message.cmd === 'ready') {
      if (source === this.view) this.isReady = true;
      else if (this.editorPanels.has(source)) {
        this.editorPanels.set(source, true);
        if (['perf', 'proc'].includes(message.page)) this.editorPages.set(source, message.page);
      }
      else return;
      if (this.lastViewModel && source) this.sendViewModel(source, this.lastViewModel);
      if (source) source.webview.postMessage({ cmd: 'uiState', processDisplay: this.getUiState(), paused: this.monitorService.scheduler ? this.monitorService.scheduler.isPaused : false });
      if (source === this.view) {
        if (this.pendingSidebarPage) {
          this.sidebarPage = this.pendingSidebarPage;
          this.pendingSidebarPage = null;
        } else if (['perf', 'proc'].includes(message.page)) this.sidebarPage = message.page;
        source.webview.postMessage({ cmd: 'navigatePage', page: this.sidebarPage });
      }
    } else if (message.cmd === 'getConfig') this.pushConfig();
    else if (message.cmd === 'switchPage' && ['perf', 'proc'].includes(message.page)) {
      if (source === this.view) this.sidebarPage = message.page;
      else if (this.editorPanels.has(source)) this.editorPages.set(source, message.page);
    }
    else if (message.cmd === 'setConfig' && CONFIG_KEYS.has(message.key)) {
      this.configStore.update(message.key, message.value);
      this.monitorService.updateConfig(this.configStore.getCurrent());
      if (message.key === 'servers') this.updateActionVisibility();
      this.onConfigUpdated(message.key);
      this.pushConfig(source);
    } else if (message.cmd === 'openSettings') this.vscode.commands.executeCommand('workbench.action.openSettings', 'sysmonitor');
    else if (message.cmd === 'setProcessDisplay' && this.uiStateStore && ['cpu', 'ram'].includes(message.key)) {
      const allowed = message.key === 'cpu' ? ['core', 'whole', 'both'] : ['size', 'percent', 'both'];
      if (!allowed.includes(message.value)) return;
      const state = { ...this.getUiState(), [message.key]: message.value };
      this.processDisplayState = state;
      this.uiStateStore.update('sysmonitor.processDisplay', state).catch((error) => this.logger(error.message));
      this.broadcast({ cmd: 'uiState', processDisplay: state });
    }
    else if (message.cmd === 'openLink' && typeof message.url === 'string' && /^https:\/\//.test(message.url)) this.vscode.env.openExternal(this.vscode.Uri.parse(message.url));
    else if (message.cmd === 'pause' && typeof message.value === 'boolean') { message.value ? this.monitorService.pause() : this.monitorService.resume(); this.broadcast({ cmd: 'uiState', paused: message.value }); }
    else this.logger(`ignored invalid webview message: ${message.cmd}`);
  }

  renderSnapshot(snapshot) {
    const viewModel = buildMonitorViewModel(snapshot, this.vscode.env.language, this.configStore.getCurrent().disk);
    this.lastViewModel = viewModel;
    this.renderViewModel(viewModel);
    return viewModel;
  }

  renderViewModel(viewModel) {
    this.forEachReadyView((target) => this.sendViewModel(target, viewModel));
  }

  sendViewModel(target, viewModel) {
    target.webview.postMessage({ cmd: 'snapshot', viewModel });
  }

  broadcast(message) {
    this.forEachReadyView((target) => target.webview.postMessage(message));
  }

  forEachReadyView(callback, exceptSource = null) {
    if (this.view && this.isReady && this.view !== exceptSource) callback(this.view);
    for (const [panel, ready] of this.editorPanels) {
      if (ready && panel !== exceptSource) callback(panel);
    }
  }

  pushConfig(exceptSource = null) {
    const config = this.configStore.getCurrent(); const value = this.monitorService.readSnapshot().accelerators.value;
    const message = { cmd: 'config', interval: config.refreshInterval, barCfg: config.statusBar, diskCfg: config.disk, displayCfg: config.display, serversCfg: config.servers, gpuCount: value ? value.devices.length : null };
    this.forEachReadyView((target) => target.webview.postMessage(message), exceptSource);
  }
}
module.exports = { MonitorViewProvider };
