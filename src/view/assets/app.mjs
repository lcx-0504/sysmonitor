import { state } from "./state.mjs";
import { updateTopbarLayout } from "./layout.mjs";
import { normalizeProcessDisplay, refreshProcTable } from "./processes.mjs";
import { switchTab, showMonitorStatus, refreshConnectionRetryButton, showConnection, showNavigation, showRetryConnectionResult, dismissLocalIntro, currentPage } from "./navigation.mjs";
import { setChartActivity, updateSparkAnimation } from "./charts.mjs";
import { applySamples } from './chart-state.mjs';
import { renderSettings, updateSshDefaultUi, refreshGpuAvailability, showConfigSaveState, showSshDefaultExtensions } from "./settings.mjs";
import { sendToExtension, tr } from './ui.mjs';
import { renderServers, showServers, showRemoteFolders, finishRemoteWindowAction } from "./servers.mjs";
import { applyCharts, applyGroupVisibility, applyTabularNums, renderMonitorSnapshot, restoreGpuSelection } from "./performance.mjs";
import { resolveLanguage } from "./i18n.mjs";
import { TO_EXTENSION, TO_WEBVIEW } from "./protocol.mjs";

function setPaused(paused) {
    setChartActivity(paused, state.ui.canAnimate);
    refreshConnectionRetryButton();
    var pauseButton = document.getElementById('pause-btn');
    pauseButton.textContent = paused ? tr('stopped') : tr('running');
    pauseButton.classList.toggle('on', !paused);
    updateTopbarLayout();
  }

function presentSnapshot(data, restoring = false) {
  applySamples(data.samples, { replace: data.replaceSamples === true, timeline: data.timeline });
  if (data.status) showMonitorStatus(data.status);
  if (data.viewModel) {
    const previousInventory = state.data.gpus.map(gpu => [gpu.idx, gpu.deviceKey]);
    state.data.viewModel = data.viewModel;
    renderMonitorSnapshot(data.viewModel, restoring || data.instant === true, data.sampleTime);
    if (JSON.stringify(previousInventory) !== JSON.stringify(state.data.gpus.map(gpu => [gpu.idx,gpu.deviceKey]))) refreshGpuAvailability();
  }
  if (data.connection) showConnection(data.connection);
}

function navigatePage(data) {
  if (data.page !== 'perf' && data.page !== 'proc') return;
  if (!state.environment.localMode) state.bridge.setState(Object.assign({}, state.bridge.getState() || {}, { page: data.page }));
  switchTab(data.page, false);
}

function applyUiState(data) {
  if (data.processDisplay) {
    state.ui.processDisplay = normalizeProcessDisplay(data.processDisplay);
    refreshProcTable();
  }
  if (typeof data.paused === 'boolean') setPaused(data.paused);
}

function applyConfig(data) {
  if (data.barCfg) state.config.statusBar = data.barCfg;
  if (data.diskCfg) state.config.disk = data.diskCfg;
  if (data.collection) state.config.collection = data.collection;
  state.config.display = data.displayCfg || state.config.display;
  if (data.serversCfg) state.config.servers = data.serversCfg;
  if (state.environment.localMode && data.serversCfg) renderServers();
  state.charts.windowMilliseconds = (state.config.display.sparkMinutes || 5) * 60 * 1000;
  applyTabularNums();
  applyCharts();
  applyGroupVisibility();
  state.config.refreshInterval = data.interval || state.config.refreshInterval;
  if (typeof data.sshDefaultInstalled === 'boolean') {
    state.config.sshDefaultInstalled = data.sshDefaultInstalled;
    state.ui.installPending = false;
    updateSshDefaultUi();
  }
  if (state.ui.settingsOpen) renderSettings();
  if (data.saveState) showConfigSaveState(data.saveState);
}

function receiveSnapshot(data) {
  if (state.environment.localMode && data.deviceId && data.deviceId !== state.ui.deviceId) return;
  presentSnapshot(data);
}

function showDeviceState(data) {
  showNavigation(data.state);
  presentSnapshot(data, true);
}

const localModeOnly = (handler) => (data) => {
  if (state.environment.localMode) handler(data);
};

const messageHandlers = {
  [TO_WEBVIEW.config]: applyConfig,
  [TO_WEBVIEW.configSaveState]: showConfigSaveState,
  [TO_WEBVIEW.uiState]: applyUiState,
  [TO_WEBVIEW.snapshot]: receiveSnapshot,
  [TO_WEBVIEW.navigatePage]: navigatePage,
  [TO_WEBVIEW.retryConnectionResult]: showRetryConnectionResult,
  [TO_WEBVIEW.sshDefaultExtensions]: showSshDefaultExtensions,
  [TO_WEBVIEW.deviceState]: localModeOnly(showDeviceState),
  [TO_WEBVIEW.navigation]: localModeOnly((data) => showNavigation(data.state)),
  [TO_WEBVIEW.servers]: localModeOnly(showServers),
  [TO_WEBVIEW.localIntroDismissed]: localModeOnly(dismissLocalIntro),
  [TO_WEBVIEW.remoteFolders]: localModeOnly(showRemoteFolders),
  [TO_WEBVIEW.remoteWindowActionDone]: localModeOnly(finishRemoteWindowAction),
};

export function initializeApp() {
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data && Object.hasOwn(messageHandlers, data.cmd)) messageHandlers[data.cmd](data);
  });
  document.getElementById('tab-perf-btn').addEventListener('click',function(){switchTab('perf');});
  document.getElementById('tab-proc-btn').addEventListener('click',function(){switchTab('proc');});
  document.getElementById('tab-servers-btn').addEventListener('click',function(){switchTab('servers');});
  document.getElementById('pause-btn').addEventListener('click',function(){
      setPaused(!state.ui.paused);
      sendToExtension(TO_EXTENSION.pause, { value: state.ui.paused });
    });
  document.addEventListener('visibilitychange', updateSparkAnimation);
  state.charts.windowMilliseconds = (state.config.display.sparkMinutes || 5) * 60 * 1000;
  restoreGpuSelection();
  if (state.environment.localMode) showNavigation(state.ui.navigation);
  else {
      var persistedPage = state.bridge.getState();
      switchTab((persistedPage && persistedPage.page) || state.initial.page || 'perf', false);
      state.bridge.setState(Object.assign({}, persistedPage || {}, {page: (persistedPage && persistedPage.page) || state.initial.page || 'perf'}));
    }
    applyGroupVisibility();
    updateTopbarLayout();
    sendToExtension(TO_EXTENSION.ready, { page: currentPage() });
    updateSparkAnimation();
}

export function initializeState() {
  state.environment = {}; state.locale = {}; state.config = {}; state.ui = {};
  state.data = {viewModel:null}; state.charts = {}; state.elements = {};
  state.bridge = acquireVsCodeApi();
  state.initial = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(document.body.dataset.config), function(character) { return character.charCodeAt(0); })));
  state.locale.language = resolveLanguage(state.initial.language);
  state.ui.paused = state.initial.paused === true;
  state.ui.canAnimate = true;
  state.config.statusBar = state.initial.barCfg || {};
  state.config.collection = Object.assign({ custom: false, ...Object.fromEntries(state.initial.collectionFields.map(field => [field.key, field.default])) }, state.initial.collection);
  state.config.disk = state.initial.diskCfg || {};
  state.config.display = state.initial.displayCfg || {};
  state.config.servers = state.initial.serversCfg || { visibleOnly: false, restoreTabs: true };
  state.config.sshDefaultInstalled = state.initial.sshDefaultInstalled === true;
  state.data.gpus = [];
  state.data.status = state.initial.monitorStatus || null;
  state.ui.processDisplay = normalizeProcessDisplay(state.initial.processDisplay);
  state.config.refreshInterval = state.initial.interval || state.initial.refreshSetting.default;
  state.ui.settingsOpen = false;
}
