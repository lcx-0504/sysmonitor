'use strict';
const crypto = require('node:crypto');
const { getWebviewHtml } = require('./webview-html');
const { monitorWebviewOptions, setMonitorPanelIcon, createMonitorEditorPanel, moveMonitorPanelToNewWindow, getMonitorEditorTitle } = require('./editor-panel');
const { setActionVisibilityContexts } = require('./action-visibility');
const { WebviewReadiness } = require('./webview-readiness');
const { ProcessDisplayPreference } = require('./process-display');
const { openSessionTerminal: launchSessionTerminal, processSession } = require('./ssh-terminal');
const { CONFIGURATION_KEYS } = require('../config/config-store');
const { webviewConfig } = require('../config/webview-config');
const { createTranslator } = require('../i18n');

const CONFIG_KEYS = new Set(CONFIGURATION_KEYS);
const { isSshDefaultExtension, addSshDefaultExtension } = require('../config/ssh-default-extensions');

class MonitorViewProvider {
  constructor({ vscode, session, configStore, uiStateStore = null, logger = () => {}, scheduleReadyCheck, cancelReadyCheck }) {
    this.vscode = vscode; this.session = session; this.configStore = configStore; this.logger = logger;
    this.processDisplay = new ProcessDisplayPreference({ store: uiStateStore, logger });
    this.readiness = new WebviewReadiness({ logger, scheduleReadyCheck, cancelReadyCheck, rebuildHtml: (record) => this.rebuildHtml(record) });
    this.sidebar = null;
    this.editorPanels = new Map();
    this.editorPages = new Map();
    this.lastFocusedEditor = null;
    this.sidebarPage = 'perf';
    this.pendingSidebarPage = null;
    this.processDemand = false;
    this.actionVisibility = null;
    this.updateActionVisibility();
  }

  updateActionVisibility() {
    this.actionVisibility = setActionVisibilityContexts(this.vscode, this.configStore.getCurrent().servers, this.actionVisibility);
  }

  async buildHtml(initialPage = 'perf', surface = 'sidebar', webview = null) {
    return getWebviewHtml({
      webview, vscode: this.vscode,
      initConfig: { ...webviewConfig(this.configStore, this.vscode), surface, language: this.vscode.env && this.vscode.env.language, monitorStatus: this.session.viewState(), processDisplay: this.processDisplay.get(), paused: this.session.isPaused(), page: initialPage },
      nonce: crypto.randomBytes(16).toString('base64'),
    });
  }

  rebuildHtml(record) {
    if (record === this.sidebar) return this.buildHtml(this.sidebarPage, 'sidebar', record.target.webview);
    return this.buildHtml(this.editorPages.get(record.target) || 'perf', 'editor', record.target.webview);
  }

  async resolveWebviewView(view) {
    if (this.sidebar) this.readiness.release(this.sidebar);
    const record = { target: view, ready: false, label: 'sidebar', visible: !!view.visible };
    this.sidebar = record;
    view.webview.options = monitorWebviewOptions(this.vscode);
    view.webview.onDidReceiveMessage((message) => this.handleMessage(message, view));
    view.onDidDispose(() => {
      this.readiness.release(record);
      if (this.sidebar !== record) return;
      this.sidebar = null;
      this.updateProcessDemand();
    });
    if (view.onDidChangeVisibility) view.onDidChangeVisibility(() => {
      this.readiness.visibilityChanged(record);
      this.updateProcessDemand();
    });
    this.updateProcessDemand();
    const html = await this.buildHtml(this.sidebarPage, 'sidebar', view.webview);
    if (this.sidebar !== record) return;
    view.webview.html = html;
    this.readiness.armReadyCheck(record);
  }

  async openEditorPanel(page = this.sidebarPage) {
    const panel = createMonitorEditorPanel(this.vscode, await this.getEditorTitle());
    await this.attachEditorPanel(panel, { page });
    return panel;
  }

  getEditorTitle() {
    if (!this.editorTitlePromise) this.editorTitlePromise = getMonitorEditorTitle(this.vscode);
    return this.editorTitlePromise;
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
    const sidebar = this.sidebar;
    this.sidebarPage = page;
    if (sidebar && sidebar.ready) this.readiness.post(sidebar, { cmd: 'navigatePage', page });
    else this.pendingSidebarPage = page;
    this.updateProcessDemand();
    if (sidebar && typeof sidebar.target.show === 'function') sidebar.target.show();
    else await this.vscode.commands.executeCommand('workbench.view.extension.sysmonitor-container');
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
    setMonitorPanelIcon(this.vscode, panel);
    panel.webview.options = monitorWebviewOptions(this.vscode);
    const record = { target: panel, ready: false, label: 'editor', visible: !!panel.visible };
    this.editorPanels.set(panel, record);
    if (panel.active) this.lastFocusedEditor = panel;
    this.editorPages.set(panel, state && state.page === 'proc' ? 'proc' : 'perf');
    panel.webview.onDidReceiveMessage((message) => this.handleMessage(message, panel));
    panel.onDidDispose(() => {
      this.readiness.release(record);
      this.editorPanels.delete(panel);
      this.editorPages.delete(panel);
      if (this.lastFocusedEditor === panel) this.lastFocusedEditor = null;
      this.updateProcessDemand();
    });
    if (panel.onDidChangeViewState) panel.onDidChangeViewState(() => {
      if (panel.active) this.lastFocusedEditor = panel;
      this.readiness.visibilityChanged(record);
      this.updateProcessDemand();
    });
    this.updateProcessDemand();
    const [html, title] = await Promise.all([
      this.buildHtml(this.editorPages.get(panel), 'editor', panel.webview), this.getEditorTitle(),
    ]);
    if (this.editorPanels.get(panel) !== record) return;
    panel.title = title;
    panel.webview.html = html;
    this.readiness.armReadyCheck(record);
  }

  recordFor(source) {
    if (this.sidebar && this.sidebar.target === source) return this.sidebar;
    return this.editorPanels.get(source) || null;
  }

  handleMessage(message, source) {
    if (!message || typeof message !== 'object' || message.version !== 1 || typeof message.cmd !== 'string') return;
    const record = this.recordFor(source);
    if (message.cmd === 'ready') {
      if (!record) return;
      this.readiness.markReady(record);
      if (record === this.sidebar) {
        if (this.pendingSidebarPage) {
          this.sidebarPage = this.pendingSidebarPage;
          this.pendingSidebarPage = null;
        } else if (['perf', 'proc'].includes(message.page)) this.sidebarPage = message.page;
      } else if (['perf', 'proc'].includes(message.page)) this.editorPages.set(source, message.page);
      this.readiness.post(record, { cmd: 'config', ...webviewConfig(this.configStore, this.vscode) });
      this.readiness.post(record, this.session.snapshotMessage(true));
      this.readiness.post(record, { cmd: 'uiState', processDisplay: this.processDisplay.get(), paused: this.session.isPaused() });
      if (record === this.sidebar) this.readiness.post(record, { cmd: 'navigatePage', page: this.sidebarPage });
      this.updateProcessDemand();
    } else if (message.cmd === 'addSshDefaultExtension') {
      addSshDefaultExtension(this.vscode).then(() => this.broadcast({ cmd: 'sshDefaultExtensions', installed: true })).catch((error) => this.broadcast({ cmd: 'sshDefaultExtensions', installed: isSshDefaultExtension(this.vscode), error: error.message }));
    }
    else if (message.cmd === 'switchPage' && record && ['perf', 'proc'].includes(message.page)) {
      if (record === this.sidebar) this.sidebarPage = message.page;
      else this.editorPages.set(source, message.page);
      this.updateProcessDemand();
    }
    else if (message.cmd === 'setConfig' && CONFIG_KEYS.has(message.key)) {
      try { this.configStore.update(message.key, message.changes); } catch (error) { this.logger(error.message); }
    } else if (message.cmd === 'retryConfigSave') {
      this.configStore.flush().catch(() => {});
    } else if (message.cmd === 'openSettings') this.vscode.commands.executeCommand('workbench.action.openSettings', 'sysmonitor');
    else if (message.cmd === 'setProcessDisplay') {
      const processDisplay = this.processDisplay.set(message.key, message.value);
      if (processDisplay) this.broadcast({ cmd: 'uiState', processDisplay });
    }
    else if (message.cmd === 'openSessionTerminal') this.openSessionTerminal(message.pid);
    else if (message.cmd === 'openLink' && typeof message.url === 'string' && /^https:\/\//.test(message.url)) this.vscode.env.openExternal(this.vscode.Uri.parse(message.url));
    else if (message.cmd === 'pause' && typeof message.value === 'boolean') { this.session.setPaused(message.value); this.broadcast({ cmd: 'uiState', paused: message.value }); }
    else if (message.cmd === 'retrySampling') this.session.retry().catch((error) => this.logger(error.message)).finally(() => {
      const current = this.recordFor(source);
      if (current) this.readiness.post(current, { cmd: 'retryConnectionResult', deviceId: 'local' });
    });
    else this.logger(`ignored invalid webview message: ${message.cmd}`);
  }

  openSessionTerminal(pid) {
    const t = createTranslator(this.vscode.env && this.vscode.env.language);
    const session = processSession(this.session.model, pid);
    if (!session) {
      this.vscode.window.showWarningMessage(t('sessionNotFound'));
      return;
    }
    try {
      launchSessionTerminal(this.vscode, session, { failureMessage: t('sessionAttachFailed', { name: session.name }) });
    } catch (error) {
      this.logger(`Session terminal: ${error.message}`);
      this.vscode.window.showErrorMessage(error.message);
    }
  }

  updateProcessDemand() {
    const demanded = this.records().some((record) => record.target.visible && this.pageOf(record) === 'proc');
    if (demanded === this.processDemand) return;
    this.processDemand = demanded;
    if (typeof this.session.setProcessDemand === 'function') this.session.setProcessDemand(demanded);
  }

  pageOf(record) {
    return record === this.sidebar ? this.sidebarPage : this.editorPages.get(record.target);
  }

  records() {
    return [...(this.sidebar ? [this.sidebar] : []), ...this.editorPanels.values()];
  }

  readyRecords() {
    return this.records().filter((record) => record.ready);
  }

  renderSession() {
    const records = this.readyRecords();
    if (!records.length) return;
    const message = this.session.snapshotMessage();
    for (const record of records) this.readiness.post(record, message);
  }

  broadcast(message) {
    for (const record of this.readyRecords()) this.readiness.post(record, message);
  }

  pushConfig() {
    this.broadcast({ cmd: 'config', ...webviewConfig(this.configStore, this.vscode) });
  }

  dispose() {
    for (const record of this.records()) this.readiness.release(record);
  }
}
module.exports = { MonitorViewProvider };
