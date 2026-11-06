import { state } from "./state.mjs";
import { updateTopbarLayout } from "./layout.mjs";
import { normalizeProcessDisplay, refreshProcTable } from "./processes.mjs";
import { switchTab, showMonitorStatus, handleNavigationMessage, refreshConnectionRetryButton, showConnection, showNavigation } from "./navigation.mjs";
import { setChartActivity, updateSparkAnimation } from "./charts.mjs";
import { applySamples } from './chart-state.mjs';
import { renderSettings, updateSshDefaultUi, refreshGpuAvailability, showConfigSaveState } from "./settings.mjs";
import { sendToExtension, tr } from './ui.mjs';
import { renderServers } from "./servers.mjs";
import { applyCharts, applyGroupVisibility, applyTabularNums, renderMonitorSnapshot, restoreGpuSelection } from "./performance.mjs";
import { catalogs, resolveLanguage } from "./i18n.mjs";

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

export function initializeApp() {
  window.addEventListener('message', function(evt) {
      var data = evt.data;
      if (!data) return;
      if (handleNavigationMessage(data, presentSnapshot)) return;
      if (data.cmd === 'navigatePage' && (data.page === 'perf' || data.page === 'proc')) {
        if (!state.environment.localMode) state.bridge.setState(Object.assign({}, state.bridge.getState() || {}, { page: data.page }));
        switchTab(data.page, false);
        return;
      }
      if (data.cmd === 'uiState') {
        if (data.processDisplay) {
          state.ui.processDisplay = normalizeProcessDisplay(data.processDisplay);
          refreshProcTable();
        }
        if (typeof data.paused === 'boolean') setPaused(data.paused);
        return;
      }
      if (data.cmd === 'config') {
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
        return;
      }
      if (data.cmd === 'configSaveState') {
        showConfigSaveState(data);
        return;
      }
      if (data.cmd !== 'snapshot') return;
      if (state.environment.localMode && data.deviceId && data.deviceId !== state.ui.deviceId) return;
      presentSnapshot(data);
    });
  document.getElementById('tab-perf-btn').addEventListener('click',function(){switchTab('perf');});
  document.getElementById('tab-proc-btn').addEventListener('click',function(){switchTab('proc');});
  document.getElementById('tab-servers-btn').addEventListener('click',function(){switchTab('servers');});
  document.getElementById('pause-btn').addEventListener('click',function(){
      setPaused(!state.ui.paused);
      sendToExtension({cmd:'pause',value:state.ui.paused});
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
    sendToExtension({cmd:'ready',page:document.querySelector('.tab-content.active').id.slice(4)});
    updateSparkAnimation();
}

export function initializeState() {
  state.environment = {}; state.locale = {}; state.config = {}; state.ui = {};
  state.data = {viewModel:null}; state.charts = {}; state.elements = {};
  state.bridge = acquireVsCodeApi();
  state.initial = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(document.body.dataset.config), function(character) { return character.charCodeAt(0); })));
  state.locale.language = resolveLanguage(state.initial.language);
  state.locale.messages = catalogs[state.locale.language];
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
