import { state, currentGpus } from './state.mjs';
import { resolveLanguage } from './i18n.mjs';
import { TO_EXTENSION, TO_WEBVIEW } from './protocol.mjs';
import { sendToExtension, storedViewState, storeViewState, tr } from './ui.mjs';
import { applySamples, updateChartWindow } from './chart-state.mjs';
import { initializeCharts, resetCharts, updateSparkAnimation } from './charts.mjs';
import { hideTooltips } from './popover.mjs';
import { initializeLayout, updateResponsiveLayout, updateTopbarLayout } from './layout.mjs';
import { applyNavigation, initializeNavigation, requestPage } from './navigation.mjs';
import { initializeConnection, refreshConnectionRetryButton, resetConnection, showConnection, showMonitorStatus, showRetryConnectionResult, updateBannerVisibility } from './connection.mjs';
import { applyCharts, applyGroupVisibility, applyTabularNums, initializePerformance, refreshGpuUsers, renderMonitorSnapshot, resetPerformanceView } from './performance.mjs';
import { focusGpuProcesses, initializeProcesses, renderProcessSnapshot, resetProcessView, setProcessDisplay, showProcessPage } from './processes.mjs';
import { applySshDefaultStatus, closeRemoteMenu, dismissLocalIntro, finishRemoteWindowAction, initializeServers, renderServers, showRemoteFolders, showServers, updateLocalIntro } from './servers.mjs';
import { initializeSettings, refreshGpuAvailability, refreshSettings, showConfigSaveState } from './settings.mjs';

const PAGES = ['perf', 'proc', 'servers'];

function decodeInitialConfig() {
  const bytes = Uint8Array.from(atob(document.body.dataset.config), (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function initializeState() {
  const initial = decodeInitialConfig();
  const localMode = initial.localMode === true;
  state.bridge = acquireVsCodeApi();
  state.initial = initial;
  state.environment = { localMode, localLinux: initial.localLinux === true, editorMode: localMode && initial.surface === 'editor' };
  state.locale = { language: resolveLanguage(initial.language) };
  state.config = {
    statusBar: initial.barCfg || {},
    collection: { custom: false, ...Object.fromEntries(initial.collectionFields.map((field) => [field.key, field.default])), ...initial.collection },
    disk: initial.diskCfg || {},
    display: initial.displayCfg || {},
    servers: initial.serversCfg || { visibleOnly: false, restoreTabs: true },
    refreshInterval: initial.interval || initial.refreshSetting.default,
  };
  state.ui = { paused: initial.paused === true, page: 'perf' };
  state.data = { viewModel: null, status: null };
  state.charts = {};
}

function setPaused(paused) {
  state.ui.paused = paused;
  updateSparkAnimation();
  refreshConnectionRetryButton();
  const pauseButton = document.getElementById('pause-btn');
  pauseButton.textContent = paused ? tr('stopped') : tr('running');
  pauseButton.classList.toggle('on', !paused);
  updateTopbarLayout();
}

function showPage(name, notify = true) {
  if (state.environment.editorMode && name === 'servers') return;
  state.ui.page = name;
  if (notify && state.environment.localMode) {
    requestPage(name);
    updateLocalIntro();
    updateBannerVisibility();
    closeRemoteMenu();
    sendToExtension(TO_EXTENSION.switchPage, { page: name });
  }
  if (notify && !state.environment.localMode) {
    storeViewState({ page: name });
    sendToExtension(TO_EXTENSION.switchPage, { page: name });
  }
  hideTooltips();
  for (const page of PAGES) {
    document.getElementById('tab-' + page).classList.toggle('active', page === name);
    document.getElementById('tab-' + page + '-btn').classList.toggle('on', page === name);
  }
  if (name === 'perf') requestAnimationFrame(refreshGpuUsers);
  if (name === 'proc') showProcessPage();
  updateSparkAnimation();
  updateResponsiveLayout();
  showMonitorStatus(state.data.status);
}

function viewGpuProcesses(index) {
  focusGpuProcesses(index);
  showPage('proc');
}

// Clears everything shown for the previous device before the newly selected one reports.
function resetDeviceView() {
  state.data.viewModel = null;
  resetConnection();
  resetCharts();
  resetProcessView();
  resetPerformanceView();
}

function showNavigation(navigation) {
  if (!navigation) return;
  closeRemoteMenu();
  const { deviceChanged } = applyNavigation(navigation);
  if (deviceChanged) resetDeviceView();
  showPage(state.ui.navigation.page || 'servers', false);
  updateLocalIntro();
  updateBannerVisibility();
}

function gpuInventory() {
  return JSON.stringify(currentGpus().map((gpu) => [gpu.idx, gpu.deviceKey]));
}

function presentSnapshot(data, restoring = false) {
  applySamples(data.samples, { replace: data.replaceSamples === true, timeline: data.timeline });
  if (data.status) showMonitorStatus(data.status);
  if (data.viewModel) {
    const inventory = gpuInventory();
    state.data.viewModel = data.viewModel;
    renderProcessSnapshot(data.viewModel);
    renderMonitorSnapshot(data.viewModel, restoring || data.instant === true, data.sampleTime);
    if (gpuInventory() !== inventory) refreshGpuAvailability();
  }
  if (data.connection) showConnection(data.connection);
}

function navigatePage({ page }) {
  if (page !== 'perf' && page !== 'proc') return;
  if (!state.environment.localMode) storeViewState({ page });
  showPage(page, false);
}

function applyUiState(data) {
  if (data.processDisplay) setProcessDisplay(data.processDisplay);
  if (typeof data.paused === 'boolean') setPaused(data.paused);
}

function applyConfig(data) {
  if (data.barCfg) state.config.statusBar = data.barCfg;
  if (data.diskCfg) state.config.disk = data.diskCfg;
  if (data.collection) state.config.collection = data.collection;
  state.config.display = data.displayCfg || state.config.display;
  if (data.serversCfg) state.config.servers = data.serversCfg;
  if (state.environment.localMode && data.serversCfg) renderServers();
  updateChartWindow();
  applyTabularNums();
  applyCharts();
  applyGroupVisibility();
  state.config.refreshInterval = data.interval || state.config.refreshInterval;
  if (typeof data.sshDefaultInstalled === 'boolean') applySshDefaultStatus(data.sshDefaultInstalled);
  refreshSettings();
  if (data.saveState) showConfigSaveState(data.saveState);
}

function showSshDefaultExtensions({ installed, error }) {
  applySshDefaultStatus(installed, error);
  refreshSettings();
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

function showInitialPage() {
  if (state.environment.localMode) {
    showNavigation(state.ui.navigation);
    return;
  }
  const page = storedViewState().page || state.initial.page || 'perf';
  showPage(page, false);
  storeViewState({ page });
}

export function initializeApp() {
  initializeState();
  initializeCharts();
  initializeLayout();
  initializeNavigation();
  initializeConnection();
  initializePerformance({ viewGpuProcesses });
  initializeProcesses();
  initializeServers();
  initializeSettings();
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data && Object.hasOwn(messageHandlers, data.cmd)) messageHandlers[data.cmd](data);
  });
  for (const page of PAGES) document.getElementById('tab-' + page + '-btn').addEventListener('click', () => showPage(page));
  document.getElementById('pause-btn').addEventListener('click', () => {
    setPaused(!state.ui.paused);
    sendToExtension(TO_EXTENSION.pause, { value: state.ui.paused });
  });
  document.addEventListener('visibilitychange', updateSparkAnimation);
  showInitialPage();
  applyGroupVisibility();
  updateTopbarLayout();
  sendToExtension(TO_EXTENSION.ready, { page: state.ui.page });
  updateSparkAnimation();
}
