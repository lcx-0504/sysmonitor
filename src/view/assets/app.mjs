import { state } from "./state.mjs";
import { updateResponsiveLayout, updateTopbarLayout } from "./layout.mjs";
import { renderProcTable, renderProcToolbar } from "./processes.mjs";
import { switchTab, showMonitorStatus, handleNavigationMessage, refreshConnectionRetryButton, showConnection, showNavigation } from "./navigation.mjs";
import { animateSparks } from "./charts.mjs";
import { applySamples, setSparkActivity } from './chart-state.mjs';
import { renderSettings, updateSshDefaultUi, refreshGpuAvailability, showConfigSaveState } from "./settings.mjs";
import { sendToExtension, tr } from './ui.mjs';
import { renderServers } from "./servers.mjs";
import { applyCharts, applyGroupVisibility, applyTabularNums, renderMonitorSnapshot } from "./performance.mjs";
import { catalogs, resolveLanguage } from "./i18n.mjs";

function setLang(lang) {
    state.locale.language = resolveLanguage(lang);
    document.documentElement.lang = state.locale.language;
    state.locale.messages = catalogs[state.locale.language];
    document.getElementById('l-1m').textContent = '1' + state.locale.messages.min;
    document.getElementById('l-5m').textContent = '5' + state.locale.messages.min;
    document.getElementById('l-15m').textContent = '15' + state.locale.messages.min;
    document.getElementById('l-used').textContent = state.locale.messages.used;
    document.getElementById('l-avail').textContent = state.locale.messages.avail;
    document.getElementById('l-total').textContent = state.locale.messages.total;
    document.getElementById('net-title').textContent = state.locale.messages.srvNet;
    document.getElementById('ssh-label').textContent = state.locale.messages.localSSH;
    ['net-up-label', 'ssh-up-label'].forEach(function(id) { document.getElementById(id).textContent = state.locale.messages.up; });
    ['net-down-label', 'ssh-down-label'].forEach(function(id) { document.getElementById(id).textContent = state.locale.messages.down; });
    document.getElementById('disk-label').textContent = state.locale.messages.diskLabel;
    document.getElementById('select-all-btn').textContent = state.locale.messages.selAll;
    document.getElementById('clear-btn').textContent = state.locale.messages.clear;
    document.getElementById('copy-btn').textContent = state.locale.messages.copyEnv;
    document.getElementById('tab-perf-btn').textContent = state.locale.messages.perfTab;
    document.getElementById('tab-proc-btn').textContent = state.locale.messages.procTab;
    document.getElementById('tab-servers-btn').textContent = state.locale.messages.serversTab;
    document.getElementById('topbar-server-refresh').textContent = tr("refreshList");
    document.getElementById('settings-btn').textContent = state.locale.messages.settBtn;
    document.getElementById('pause-btn').textContent = state.ui.paused ? state.locale.messages.stopped : state.locale.messages.running;
    document.getElementById('proc-filter').placeholder = state.locale.messages.filterHint || '';
    updateTopbarLayout();
    document.getElementById('server-intro-close').textContent = tr('gotIt');
    updateSshDefaultUi();
    renderProcToolbar();
  }

export function presentSnapshot(data, restoring = false) {
  applySamples(data.samples, { replace: data.replaceSamples === true, timeline: data.timeline });
  if (data.status) showMonitorStatus(data.status);
  if (data.viewModel) {
    const language = data.viewModel.performance.language;
    if (language && resolveLanguage(language) !== state.locale.language) setLang(language);
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
        if (data.processDisplay) { state.ui.processDisplay = data.processDisplay; renderProcTable(); }
        if (typeof data.paused === 'boolean') {
          setSparkActivity(data.paused, state.ui.canAnimate);
          refreshConnectionRetryButton();
          var pauseButton = document.getElementById('pause-btn');
          pauseButton.textContent = state.ui.paused ? state.locale.messages.stopped : state.locale.messages.running;
          pauseButton.classList.toggle('on', !state.ui.paused);
          updateTopbarLayout();
        }
        return;
      }
      if (data.cmd === 'config') {
        if (data.barCfg) state.config.statusBar = data.barCfg;
        if (data.diskCfg) state.config.disk = data.diskCfg;
        if (data.timeouts) state.config.timeouts = data.timeouts;
        state.config.display = data.displayCfg || state.config.display;
        if (data.serversCfg) state.config.servers = data.serversCfg;
        if (state.environment.localMode && data.serversCfg) renderServers();
        state.charts.windowMilliseconds = (state.config.display.sparkMinutes || 5) * 60 * 1000;
        applyTabularNums();
        applyCharts();
        applyGroupVisibility();
        state.config.refreshInterval = data.interval || state.config.refreshInterval;
        if (typeof data.gpuCount === 'number') state.data.gpuCount = data.gpuCount;
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
      setSparkActivity(!state.ui.paused, state.ui.canAnimate);
      refreshConnectionRetryButton();
      this.textContent = state.ui.paused ? state.locale.messages.stopped : state.locale.messages.running;
      this.classList.toggle('on', !state.ui.paused);
      sendToExtension({cmd:'pause',value:state.ui.paused});
    });
  state.charts.windowMilliseconds = (state.config.display.sparkMinutes || 5) * 60 * 1000;
  setLang(state.initial.language || 'en');
  if (state.environment.localMode) showNavigation(state.ui.navigation);
  else {
      var persistedPage = state.bridge.getState();
      switchTab((persistedPage && persistedPage.page) || state.initial.page || 'perf', false);
      state.bridge.setState(Object.assign({}, persistedPage || {}, {page: (persistedPage && persistedPage.page) || state.initial.page || 'perf'}));
    }
    applyGroupVisibility();
    document.getElementById('ssh-card').style.display = 'none';
    sendToExtension({cmd:'ready',page:document.querySelector('.tab-content.active').id.slice(4)});
    requestAnimationFrame(animateSparks);
  
}

export { setLang };

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
  state.config.timeouts = Object.assign({ enabled: false, ...Object.fromEntries(state.initial.collectionFields.map(field => [field.key, field.default])) }, state.initial.timeouts);
  state.config.disk = state.initial.diskCfg || {};
  state.config.display = state.initial.displayCfg || {};
  state.config.servers = state.initial.serversCfg || { visibleOnly: false, restoreTabs: true };
  state.config.sshDefaultInstalled = state.initial.sshDefaultInstalled === true;
  state.data.gpus = [];
  state.data.status = state.initial.monitorStatus || null;
  state.ui.processDisplay = state.initial.processDisplay || { cpu: 'core', ram: 'size' };
  state.ui.expandedColumns = { name: false, cmd: false };
  state.config.refreshInterval = state.initial.interval || state.initial.refreshSetting.default;
  state.data.gpuCount = typeof state.initial.gpuCount === 'number' ? state.initial.gpuCount : 0;
  state.ui.settingsOpen = false;
}
