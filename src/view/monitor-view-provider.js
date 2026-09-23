'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { buildLegacyViewModel } = require('../services/legacy-view-model');
const { getWebviewHtml } = require('./webview-html');

const CONFIG_KEYS = new Set(['refreshInterval', 'statusBar', 'disk', 'display']);

class MonitorViewProvider {
  constructor({ vscode, monitorService, configStore, uiStateStore = null, onConfigUpdated = () => {}, onUserIndicesChanged = () => {}, logger = () => {} }) {
    this.vscode = vscode; this.monitorService = monitorService; this.configStore = configStore; this.onConfigUpdated = onConfigUpdated; this.onUserIndicesChanged = onUserIndicesChanged; this.logger = logger;
    this.uiStateStore = uiStateStore;
    this.processDisplayState = null;
    this.view = null;
    this.isReady = false;
    this.editorPanels = new Map();
    this.lastViewModel = null;
  }

  getUiState() {
    if (!this.processDisplayState) {
      const stored = (this.uiStateStore ? this.uiStateStore.get('sysmonitor.processDisplay', {}) : {}) || {};
      this.processDisplayState = { cpu: ['core', 'whole', 'both'].includes(stored.cpu) ? stored.cpu : 'core', ram: ['size', 'percent', 'both'].includes(stored.ram) ? stored.ram : 'size' };
    }
    return this.processDisplayState;
  }

  async buildHtml() {
    const config = this.configStore.getCurrent();
    const acceleratorValue = this.monitorService.readSnapshot().accelerators.value;
    return getWebviewHtml({
      initConfig: { interval: config.refreshInterval, barCfg: config.statusBar, diskCfg: config.disk, displayCfg: config.display, gpuCount: acceleratorValue ? acceleratorValue.devices.length : null, processDisplay: this.getUiState(), paused: this.monitorService.scheduler.isPaused },
      nonce: crypto.randomBytes(16).toString('base64'),
    });
  }

  async resolveWebviewView(view) {
    this.view = view;
    this.isReady = false;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((message) => this.handleMessage(message, view));
    view.onDidDispose(() => { this.view = null; this.isReady = false; });
    const html = await this.buildHtml();
    if (this.view === view) view.webview.html = html;
  }

  async openEditorPanel() {
    const panel = this.vscode.window.createWebviewPanel('sysmonitor.editor', 'System Monitor', this.vscode.ViewColumn.Active, { enableScripts: true });
    panel.iconPath = this.vscode.Uri.file(path.join(__dirname, '..', '..', 'icon.svg'));
    this.editorPanels.set(panel, false);
    panel.webview.onDidReceiveMessage((message) => this.handleMessage(message, panel));
    panel.onDidDispose(() => { this.editorPanels.delete(panel); });
    const html = await this.buildHtml();
    if (this.editorPanels.has(panel)) panel.webview.html = html;
  }

  handleMessage(message, source = this.view) {
    if (!message || typeof message !== 'object' || (message.version !== undefined && message.version !== 1) || typeof message.cmd !== 'string') return;
    if (message.cmd === 'ready') {
      if (source === this.view) this.isReady = true;
      else if (this.editorPanels.has(source)) this.editorPanels.set(source, true);
      else return;
      if (this.lastViewModel && source) this.sendViewModel(source, this.lastViewModel);
      if (source) source.webview.postMessage({ cmd: 'uiState', processDisplay: this.getUiState(), paused: this.monitorService.scheduler ? this.monitorService.scheduler.isPaused : false });
    } else if (message.cmd === 'getConfig') this.pushConfig();
    else if (message.cmd === 'setConfig' && CONFIG_KEYS.has(message.key)) {
      this.configStore.update(message.key, message.value);
      this.monitorService.updateConfig(this.configStore.getCurrent());
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
    else if (message.cmd === 'needProcs') this.pushProcesses();
    else this.logger(`ignored invalid webview message: ${message.cmd}`);
  }

  renderSnapshot(snapshot) {
    const viewModel = buildLegacyViewModel(snapshot, this.vscode.env.language); const diskConfig = this.configStore.getCurrent().disk;
    if (diskConfig.hideParentMounts !== false) {
      const mounts = viewModel.payload.disks.map((disk) => disk.mount);
      viewModel.payload.disks = viewModel.payload.disks.filter((disk) => disk.mount === '/' || !mounts.some((mount) => mount !== disk.mount && mount.startsWith(`${disk.mount}/`)));
    }
    this.lastViewModel = viewModel; this.onUserIndicesChanged(viewModel.currentUserNativeIndices); this.renderViewModel(viewModel);
  }

  renderViewModel(viewModel) {
    this.forEachReadyView((target) => this.sendViewModel(target, viewModel));
  }

  sendViewModel(target, viewModel) {
    target.webview.postMessage({ cmd: 'update', payload: viewModel.payload });
    target.webview.postMessage({ cmd: 'procs', data: viewModel.processes });
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

  pushProcesses() {
    if (this.lastViewModel) this.broadcast({ cmd: 'procs', data: this.lastViewModel.processes });
  }
  pushConfig(exceptSource = null) {
    const config = this.configStore.getCurrent(); const value = this.monitorService.readSnapshot().accelerators.value;
    const message = { cmd: 'config', interval: config.refreshInterval, barCfg: config.statusBar, diskCfg: config.disk, displayCfg: config.display, gpuCount: value ? value.devices.length : null };
    this.forEachReadyView((target) => target.webview.postMessage(message), exceptSource);
  }
}
module.exports = { MonitorViewProvider };
