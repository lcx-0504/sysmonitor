'use strict';
const { MonitorViewHost } = require('./monitor-view-host');
const { createMonitorEditorPanel, getMonitorEditorTitle } = require('./editor-panel');
const { TO_EXTENSION, TO_WEBVIEW } = require('./protocol');
const { LOCAL_DEVICE_ID } = require('../domain/device-id');

const PAGES = Object.freeze(['perf', 'proc']);

const SESSION_MESSAGE_HANDLERS = Object.freeze({
  [TO_EXTENSION.retrySampling]: {
    run: (provider, message, record) => provider.retryDevice(record, LOCAL_DEVICE_ID, provider.session),
  },
  [TO_EXTENSION.openSessionTerminal]: {
    run: (provider, message) => provider.openSessionTerminal(LOCAL_DEVICE_ID, provider.session, message.pid),
  },
});

class MonitorViewProvider extends MonitorViewHost {
  constructor({ session, ...options }) {
    super({ ...options, messageHandlers: SESSION_MESSAGE_HANDLERS });
    this.session = session;
    this.sidebarPage = 'perf';
    this.pendingSidebarPage = null;
    this.processDemand = false;
    this.editorTitlePromise = null;
  }

  isPaused() {
    return this.session.isPaused();
  }

  setPaused(paused) {
    this.session.setPaused(paused);
    this.pauseChanged(paused);
  }

  initialViewConfig(record) {
    return { monitorStatus: this.session.viewState(), page: this.pageOf(record) };
  }

  editorTitle() {
    if (!this.editorTitlePromise) this.editorTitlePromise = getMonitorEditorTitle(this.vscode);
    return this.editorTitlePromise;
  }

  async openEditorPanel(page = this.sidebarPage) {
    const panel = createMonitorEditorPanel(this.vscode, await this.editorTitle());
    await this.attachEditor(panel, { page });
    return panel;
  }

  attachEditor(panel, state = {}) {
    const page = state && state.page === 'proc' ? 'proc' : 'perf';
    return this.mountEditor(panel, { page });
  }

  async returnActiveEditorToSidebar() {
    const record = this.activeEditor();
    if (!record) return;
    const page = record.page;
    this.sidebarPage = page;
    if (this.sidebar && this.sidebar.ready) this.readiness.post(this.sidebar, { cmd: TO_WEBVIEW.navigatePage, page });
    else this.pendingSidebarPage = page;
    this.updateProcessDemand();
    await this.revealSidebar();
    record.target.dispose();
  }

  pageOf(record) {
    return record.sidebar ? this.sidebarPage : record.page;
  }

  assignPage(record, page) {
    if (record.sidebar) this.sidebarPage = page;
    else record.page = page;
  }

  pagesFor() {
    return PAGES;
  }

  showPage(record, page) {
    this.assignPage(record, page);
    this.updateProcessDemand();
  }

  handleReady(record, message) {
    this.readiness.markReady(record);
    if (record.sidebar && this.pendingSidebarPage) {
      this.sidebarPage = this.pendingSidebarPage;
      this.pendingSidebarPage = null;
    } else if (PAGES.includes(message.page)) {
      this.assignPage(record, message.page);
    }
    this.postConfig(record);
    this.readiness.post(record, this.session.snapshotMessage(true));
    this.postUiState(record);
    if (record.sidebar) this.readiness.post(record, { cmd: TO_WEBVIEW.navigatePage, page: this.sidebarPage });
    this.updateProcessDemand();
  }

  viewsChanged() {
    this.updateProcessDemand();
  }

  updateProcessDemand() {
    const demanded = this.records().some((record) => record.target.visible && this.pageOf(record) === 'proc');
    if (demanded === this.processDemand) return;
    this.processDemand = demanded;
    this.session.setProcessDemand(demanded);
  }

  renderSession() {
    const records = this.records().filter((record) => record.ready);
    if (!records.length) return;
    const message = this.session.snapshotMessage();
    for (const record of records) this.readiness.post(record, message);
  }
}

module.exports = { MonitorViewProvider };
