'use strict';
const crypto = require('node:crypto');
const { getWebviewHtml } = require('./webview-html');
const { monitorWebviewOptions, setMonitorPanelIcon, moveMonitorPanelToNewWindow, revealMonitorContainer } = require('./editor-panel');
const { setActionVisibilityContexts } = require('./action-visibility');
const { WebviewReadiness } = require('./webview-readiness');
const { ProcessDisplayPreference } = require('./process-display');
const { openSessionTerminal: launchSessionTerminal, processSession } = require('./ssh-terminal');
const { PROTOCOL_VERSION, TO_EXTENSION, TO_WEBVIEW } = require('./protocol');
const { deviceHost } = require('../domain/device-id');
const { CONFIGURATION_KEYS } = require('../config/config-store');
const { webviewConfig } = require('../config/webview-config');
const { isSshDefaultExtension, addSshDefaultExtension } = require('../config/ssh-default-extensions');
const { createTranslator } = require('../i18n');

const CONFIG_KEYS = new Set(CONFIGURATION_KEYS);

const SHARED_MESSAGE_HANDLERS = Object.freeze({
  [TO_EXTENSION.ready]: {
    accepts: (provider, message, record) => provider.isRegistered(record),
    run: (provider, message, record) => provider.handleReady(record, message),
  },
  [TO_EXTENSION.setConfig]: {
    accepts: (provider, message) => CONFIG_KEYS.has(message.key),
    run: (provider, message) => provider.configStore.update(message.key, message.changes),
  },
  [TO_EXTENSION.retryConfigSave]: {
    run: (provider) => provider.configStore.flush().catch(() => {}),
  },
  [TO_EXTENSION.openSettings]: {
    run: (provider) => provider.vscode.commands.executeCommand('workbench.action.openSettings', 'sysmonitor'),
  },
  [TO_EXTENSION.openLink]: {
    accepts: (provider, message) => typeof message.url === 'string' && /^https:\/\//.test(message.url),
    run: (provider, message) => provider.vscode.env.openExternal(provider.vscode.Uri.parse(message.url)),
  },
  [TO_EXTENSION.addSshDefaultExtension]: {
    run: (provider, message) => provider.installSshDefaultExtension(message),
  },
  [TO_EXTENSION.setProcessDisplay]: {
    run: (provider, message) => provider.setProcessDisplay(message.key, message.value),
  },
  [TO_EXTENSION.pause]: {
    accepts: (provider, message) => typeof message.value === 'boolean',
    run: (provider, message) => provider.setPaused(message.value),
  },
  [TO_EXTENSION.switchPage]: {
    accepts: (provider, message, record) => provider.isRegistered(record) && provider.pagesFor(record).includes(message.page),
    run: (provider, message, record) => provider.showPage(record, message.page),
  },
});

function describeError(error) {
  return error && error.message ? error.message : String(error);
}

// Subclasses provide isPaused, setPaused, initialViewConfig, editorTitle, attachEditor,
// openEditorPanel, handleReady, pagesFor, showPage and viewsChanged.
class MonitorViewHost {
  constructor({ vscode, configStore, uiStateStore = null, logger = () => {}, scheduleReadyCheck, cancelReadyCheck, messageHandlers = {} }) {
    this.vscode = vscode;
    this.configStore = configStore;
    this.uiStateStore = uiStateStore;
    this.logger = logger;
    this.messageHandlers = { ...SHARED_MESSAGE_HANDLERS, ...messageHandlers };
    this.processDisplay = new ProcessDisplayPreference({ store: uiStateStore, logger });
    this.readiness = new WebviewReadiness({
      logger, scheduleReadyCheck, cancelReadyCheck,
      rebuildHtml: (record) => this.buildHtml(record),
    });
    this.sidebar = null;
    this.editors = new Map();
    this.lastFocusedEditor = null;
    this.actionVisibility = null;
    this.updateActionVisibility();
  }

  updateActionVisibility() {
    this.actionVisibility = setActionVisibilityContexts(this.vscode, this.configStore.getCurrent().servers, this.actionVisibility);
  }

  language() {
    return this.vscode.env && this.vscode.env.language;
  }

  translator() {
    return createTranslator(this.language());
  }

  async buildHtml(record) {
    return getWebviewHtml({
      webview: record.target.webview,
      vscode: this.vscode,
      initConfig: {
        ...webviewConfig(this.configStore, this.vscode),
        ...this.initialViewConfig(record),
        surface: record.sidebar ? 'sidebar' : 'editor',
        language: this.language(),
        processDisplay: this.processDisplay.get(),
        paused: this.isPaused(),
      },
      nonce: crypto.randomBytes(16).toString('base64'),
    });
  }

  createRecord(target, { sidebar, ...fields }) {
    return { ...fields, target, sidebar, label: sidebar ? 'sidebar' : 'editor', ready: false, visible: !!target.visible };
  }

  connectWebview(webview, record) {
    webview.options = monitorWebviewOptions(this.vscode);
    webview.onDidReceiveMessage((message) => this.handleMessage(message, record));
  }

  sidebarFields() {
    return {};
  }

  async resolveWebviewView(view) {
    if (this.sidebar) this.readiness.release(this.sidebar);
    const record = this.createRecord(view, { ...this.sidebarFields(), sidebar: true });
    this.sidebar = record;
    this.connectWebview(view.webview, record);
    view.onDidDispose(() => {
      this.readiness.release(record);
      if (this.sidebar === record) this.sidebar = null;
      this.viewsChanged();
    });
    if (view.onDidChangeVisibility) {
      view.onDidChangeVisibility(() => {
        this.readiness.visibilityChanged(record);
        this.viewsChanged();
      });
    }
    this.viewsChanged();
    const html = await this.buildHtml(record);
    if (this.sidebar !== record) return;
    view.webview.html = html;
    this.readiness.armReadyCheck(record);
  }

  async mountEditor(panel, fields) {
    const record = this.createRecord(panel, { ...fields, sidebar: false });
    this.editors.set(panel, record);
    if (panel.active) this.lastFocusedEditor = record;
    setMonitorPanelIcon(this.vscode, panel);
    this.connectWebview(panel.webview, record);
    panel.onDidDispose(() => {
      this.readiness.release(record);
      this.editors.delete(panel);
      if (this.lastFocusedEditor === record) this.lastFocusedEditor = null;
      this.viewsChanged();
    });
    if (panel.onDidChangeViewState) {
      panel.onDidChangeViewState(() => {
        if (panel.active) this.lastFocusedEditor = record;
        this.readiness.visibilityChanged(record);
        this.viewsChanged();
      });
    }
    this.viewsChanged();
    const [html, title] = await Promise.all([this.buildHtml(record), this.editorTitle(record)]);
    if (this.editors.get(panel) !== record) return;
    panel.title = title;
    panel.webview.html = html;
    this.readiness.armReadyCheck(record);
  }

  restoreEditor(panel, state) {
    return this.attachEditor(panel, state);
  }

  async openFloatingPanel(...args) {
    const panel = await this.openEditorPanel(...args);
    if (!panel) return null;
    await moveMonitorPanelToNewWindow(this.vscode, panel);
    return panel;
  }

  activeEditor() {
    const records = [...this.editors.values()];
    const active = records.find((record) => record.target.active);
    if (active) {
      this.lastFocusedEditor = active;
      return active;
    }
    const last = this.lastFocusedEditor;
    if (last && this.editors.get(last.target) === last && last.target.visible !== false) return last;
    const visible = records.filter((record) => record.target.visible !== false);
    return visible.length === 1 ? visible[0] : null;
  }

  async moveActiveEditorToNewWindow() {
    const record = this.activeEditor();
    if (record) await moveMonitorPanelToNewWindow(this.vscode, record.target, { disposeOnError: false });
  }

  async revealSidebar() {
    if (this.sidebar && typeof this.sidebar.target.show === 'function') this.sidebar.target.show();
    else await revealMonitorContainer(this.vscode);
  }

  isRegistered(record) {
    if (!record) return false;
    return record === this.sidebar || this.editors.get(record.target) === record;
  }

  records() {
    const editors = [...this.editors.values()];
    return this.sidebar ? [this.sidebar, ...editors] : editors;
  }

  async handleMessage(message, record) {
    if (!message || typeof message !== 'object' || message.version !== PROTOCOL_VERSION || typeof message.cmd !== 'string') return;
    const handler = Object.hasOwn(this.messageHandlers, message.cmd) ? this.messageHandlers[message.cmd] : null;
    if (!handler || (handler.accepts && !handler.accepts(this, message, record))) {
      this.logger(`ignored invalid webview message: ${message.cmd}`);
      return;
    }
    try {
      await handler.run(this, message, record);
    } catch (error) {
      this.logger(`Webview message ${message.cmd} failed: ${describeError(error)}`);
    }
  }

  configMessage() {
    return { cmd: TO_WEBVIEW.config, ...webviewConfig(this.configStore, this.vscode) };
  }

  postConfig(record) {
    this.readiness.post(record, this.configMessage());
  }

  postUiState(record) {
    this.readiness.post(record, { cmd: TO_WEBVIEW.uiState, processDisplay: this.processDisplay.get(), paused: this.isPaused() });
  }

  broadcast(message) {
    for (const record of this.records()) {
      if (record.ready) this.readiness.post(record, message);
    }
  }

  pushConfig() {
    this.broadcast(this.configMessage());
  }

  saveStateChanged(state) {
    this.broadcast({ cmd: TO_WEBVIEW.configSaveState, ...state });
  }

  pauseChanged(paused) {
    this.broadcast({ cmd: TO_WEBVIEW.uiState, paused });
  }

  setProcessDisplay(key, value) {
    const processDisplay = this.processDisplay.set(key, value);
    if (processDisplay) this.broadcast({ cmd: TO_WEBVIEW.uiState, processDisplay });
  }

  isSshDefaultExtension() {
    return isSshDefaultExtension(this.vscode);
  }

  async installSshDefaultExtension(message) {
    try {
      await addSshDefaultExtension(this.vscode);
    } catch (error) {
      this.logger(`SSH default extensions: ${error.message}`);
      this.broadcast({ cmd: TO_WEBVIEW.sshDefaultExtensions, installed: this.isSshDefaultExtension(), error: error.message });
      return;
    }
    await this.onSshDefaultExtensionInstalled(message);
    this.broadcast({ cmd: TO_WEBVIEW.sshDefaultExtensions, installed: true });
  }

  async onSshDefaultExtensionInstalled() {}

  async retryDevice(record, deviceId, device) {
    let error = null;
    if (device) {
      try {
        await device.retry();
      } catch (failure) {
        error = describeError(failure);
        this.logger(`Monitor retry ${deviceId}: ${error}`);
      }
    }
    if (!record.ready || !this.isRegistered(record)) return;
    const result = { cmd: TO_WEBVIEW.retryConnectionResult, deviceId };
    if (error) result.error = error;
    this.readiness.post(record, result);
  }

  sshConfigFile() {
    return this.vscode.workspace.getConfiguration('remote.SSH').get('configFile');
  }

  openSessionTerminal(deviceId, device, pid) {
    const t = this.translator();
    const session = processSession(device && device.model, pid);
    if (!session) {
      this.vscode.window.showWarningMessage(t('sessionNotFound'));
      return;
    }
    const host = deviceHost(deviceId);
    try {
      launchSessionTerminal(this.vscode, session, {
        host,
        configFile: host ? this.sshConfigFile() : null,
        failureMessage: t('sessionAttachFailed', { name: session.name }),
      });
    } catch (error) {
      this.logger(`Session terminal ${deviceId}: ${error.message}`);
      this.vscode.window.showErrorMessage(error.message);
    }
  }

  dispose() {
    for (const record of this.records()) this.readiness.release(record);
  }
}

module.exports = { MonitorViewHost };
