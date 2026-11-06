import { state } from "./state.mjs";
import { sendToExtension, tr } from './ui.mjs';
import { updateDeviceScrollbar, updateTopbarLayout, updateResponsiveLayout } from "./layout.mjs";
import { closeRemoteMenu, renderServers, showRemoteMenu } from "./servers.mjs";
import { setSparkActivity, initializeChartState } from "./chart-state.mjs";
import { updateSshDefaultUi } from "./settings.mjs";
import { localizeError } from "./i18n.mjs";
import { renderGpuUsers, hideGpuInfoPopover, resetMonitorView } from "./performance.mjs";

let localLinux, previousNavigationState, pointerDrag, suppressDeviceClick, serverTabButton, deviceStrip, topbar, connectionRetryButton, connectionState, connectionError, connectionRetryAfter, retryPending, retryCountdownTimer;

function hasSamplingFailure() {
    return connectionState === 'connected' && state.data.status && (state.data.status.error || (state.data.status.failures || []).length > 0);
  }

function retryButtonState(connection, pending, isPaused, retryAfter, now, isZh) {
    var language = typeof isZh === 'string' ? isZh : isZh ? 'zh-CN' : 'en';
    if (connection === 'connected' && pending) return { text: tr('collecting', {}, language), disabled: true, remaining: 0 };
    if (connection === 'connecting' || pending) return { text: tr('connecting', {}, language), disabled: true, remaining: 0 };
    var remaining = connection === 'disconnected' && !isPaused && typeof retryAfter === 'number'
      ? Math.max(0, Math.ceil((retryAfter - now) / 1000)) : 0;
    return { text: tr('retry', {}, language) + (remaining ? ' (' + remaining + ')' : ''), disabled: false, remaining: remaining };
  }

function refreshConnectionRetryButton() {
    if (retryCountdownTimer) { clearTimeout(retryCountdownTimer); retryCountdownTimer = null; }
    var sshDevice = !!state.ui.deviceId && state.ui.deviceId.startsWith('ssh:');
    var now = Date.now();
    var collecting = state.data.status?.collecting === true;
    var buttonState = retryButtonState(connectionState, retryPending || collecting, state.ui.paused, connectionRetryAfter, now, state.locale.language);
    connectionRetryButton.hidden = !(sshDevice && (connectionState === 'connecting' || connectionState === 'disconnected')) && !hasSamplingFailure() && !collecting;
    connectionRetryButton.disabled = buttonState.disabled;
    connectionRetryButton.textContent = buttonState.text;
    if (buttonState.remaining) {
      var left = connectionRetryAfter - now;
      var untilNextSecond = left - (buttonState.remaining - 1) * 1000;
      retryCountdownTimer = setTimeout(refreshConnectionRetryButton, Math.max(1, untilNextSecond));
    }
  }

function storeNavigation() {
    if (!state.environment.localMode) return;
    state.bridge.setState(Object.assign({}, state.bridge.getState() || {}, { navigation: state.ui.navigation }));
  }

function updateLocalIntro() {
    var hint = document.getElementById('server-intro-hint');
    if (state.environment.localMode) {
      var environment = localLinux
        ? (tr("thisLocalEnvironmentIsLinuxYouCanMonitor"))
        : (tr("thisLocalEnvironmentIsMacOSWindowsSelectA"));
      var remote = tr("youCanAlsoInstallTheExtensionInA");
      var install = state.config.sshDefaultInstalled
        ? (tr("addedToTheRemoteSSHDefaultListInstalls"))
        : (tr("addToTheRemoteSSHDefaultListTo"));
      document.getElementById('server-intro-text').textContent = [tr("systemMonitorSupportsLinuxEnvironments"), environment, remote, install].join(tr("sentenceSeparator"));
    }
    hint.classList.toggle('show', state.environment.localMode && state.initial.showLocalIntro === true && !state.ui.localIntroDismissed && state.ui.navigation.page === 'servers');
  }

function clearTabDrag() {
    var drag = pointerDrag;
    pointerDrag = null;
    if (!drag) return;
    drag.slots.forEach(function(slot) {
      slot.tab.classList.remove('dragging');
      slot.tab.style.transform = '';
    });
  }

function moveTabWithinStrip(event) {
    var drag = pointerDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
    drag.active = true;
    event.preventDefault();
    var bounds = deviceStrip.getBoundingClientRect();
    var minOffset = Math.min(0, bounds.left + 1 - drag.origin.left);
    var maxOffset = Math.max(0, bounds.right - 1 - drag.origin.right);
    var offset = Math.max(minOffset, Math.min(event.clientX - drag.startX, maxOffset));
    drag.tab.classList.add('dragging');
    drag.tab.style.transform = 'translateX(' + offset + 'px)';
    var center = drag.origin.left + drag.origin.width / 2 + offset;
    drag.targetIndex = drag.slots.filter(function(slot, index) {
      return slot.tab !== drag.tab && slot.center < center + (index > drag.originIndex ? 2 : -2);
    }).length;
    drag.slots.forEach(function(slot, index) {
      if (slot.tab === drag.tab) return;
      var shift = drag.targetIndex > drag.originIndex && index > drag.originIndex && index <= drag.targetIndex ? -drag.origin.width
        : drag.targetIndex < drag.originIndex && index >= drag.targetIndex && index < drag.originIndex ? drag.origin.width : 0;
      slot.tab.style.transform = shift ? 'translateX(' + shift + 'px)' : '';
    });
  }

function reorderDeviceTab(draggedId, targetIndex) {
    var reordered = state.ui.navigation.tabs.filter(function(value) { return value !== draggedId; });
    reordered.splice(targetIndex, 0, draggedId);
    state.ui.navigation = Object.assign({}, state.ui.navigation, { tabs: reordered });
    renderDeviceTabs();
    storeNavigation();
    sendToExtension({ cmd: 'reorderDevices', tabs: reordered });
  }

function clearDeviceContent() {
    resetMonitorView();
    initializeChartState();
    state.ui.canAnimate = false;
    state.data.status = null;
    state.data.viewModel = null;
    state.ui.renderedDiskKeys = []; state.ui.renderedAcceleratorKeys = []; state.data.disks = [];
    state.ui.selectedGpus = {}; state.data.idleIds = []; state.data.gpus = [];
    state.data.processes = []; state.ui.pendingProcesses = null;
    document.getElementById('cpu-val').textContent = '--';
    document.getElementById('mem-val').textContent = '--';
    ['mem-used', 'mem-avail', 'mem-total', 'net-tx', 'net-rx', 'disk-io-val', 'gpu-summary', 'proc-count'].forEach(function(id) {
      document.getElementById(id).textContent = '--';
    });
    ['load-1', 'load-5', 'load-15'].forEach(function(id) { document.getElementById(id).textContent = '--'; });
    document.getElementById('gpu-body').innerHTML = '';
    document.getElementById('disk-body').innerHTML = '';
    document.getElementById('disk-card').style.display = 'none';
    document.getElementById('ssh-card').style.display = 'none';
    document.getElementById('proc-tbody').innerHTML = '';
    document.getElementById('updated').textContent = '--';
    document.querySelectorAll('.spark-bg path').forEach(function(path) { path.removeAttribute('d'); });
    ['cpu-bar', 'mem-bar'].forEach(function(id) { var bar = document.getElementById(id); if (bar) bar.style.width = '0%'; });
  }

function updateDeviceTabsPresentation() {
    var hasTabs = state.ui.navigation.tabs.length > 0;
    deviceStrip.hidden = state.environment.editorMode || !hasTabs || state.ui.navigation.page === 'servers';
    document.getElementById('device-strip-wrap').hidden = deviceStrip.hidden;
    topbar.hidden = false;
    document.getElementById('tab-perf-btn').hidden = !hasTabs;
    document.getElementById('tab-proc-btn').hidden = !hasTabs;
    serverTabButton.hidden = state.environment.editorMode;
    deviceStrip.querySelectorAll('.device-tab').forEach(function(tab) {
      var active = state.ui.navigation.selected === tab.dataset.deviceId && state.ui.navigation.page !== 'servers';
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    updateTopbarLayout();
    updateDeviceScrollbar();
  }

function renderDeviceTabs() {
    if (!state.environment.localMode) return;
    deviceStrip.innerHTML = '';
    if (state.environment.editorMode) { updateDeviceTabsPresentation(); return; }
    state.ui.navigation.tabs.forEach(function(id) {
      var tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'device-tab' + (state.ui.navigation.selected === id && state.ui.navigation.page !== 'servers' ? ' active' : '');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', state.ui.navigation.selected === id && state.ui.navigation.page !== 'servers' ? 'true' : 'false');
      var name = document.createElement('span');
      name.textContent = id === 'local' ? (tr("local")) : id.slice(4);
      tab.appendChild(name);
      tab.title = name.textContent;
      tab.addEventListener('click', function(event) {
        if (suppressDeviceClick) { event.preventDefault(); suppressDeviceClick = false; return; }
        sendToExtension({ cmd: 'switchDevice', id: id });
      });
      tab.addEventListener('auxclick', function(event) {
        if (event.button !== 1 || id === 'local') return;
        event.preventDefault();
        sendToExtension({ cmd: 'closeDevice', id: id });
      });
      tab.addEventListener('pointerdown', function(event) {
        if (event.button !== 0 || event.target.closest('.device-tab-close')) return;
        var tabs = Array.from(deviceStrip.querySelectorAll('.device-tab'));
        if (tabs.length < 2) return;
        var origin = tab.getBoundingClientRect();
        pointerDrag = { id: id, tab: tab, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false,
          origin: origin, originIndex: tabs.indexOf(tab), targetIndex: tabs.indexOf(tab),
          slots: tabs.map(function(item) { var rect = item.getBoundingClientRect(); return { tab: item, center: rect.left + rect.width / 2 }; }) };
        tab.setPointerCapture(event.pointerId);
      });
      tab.addEventListener('pointermove', function(event) {
        if (!pointerDrag || pointerDrag.id !== id || pointerDrag.pointerId !== event.pointerId) return;
        moveTabWithinStrip(event);
      });
      tab.addEventListener('pointerup', function(event) {
        if (!pointerDrag || pointerDrag.id !== id || pointerDrag.pointerId !== event.pointerId) return;
        if (pointerDrag.active) moveTabWithinStrip(event);
        var drag = pointerDrag;
        var shouldReorder = drag.active && drag.targetIndex !== drag.originIndex;
        if (tab.hasPointerCapture(event.pointerId)) tab.releasePointerCapture(event.pointerId);
        clearTabDrag();
        if (drag.active) {
          suppressDeviceClick = true;
          setTimeout(function() { suppressDeviceClick = false; }, 0);
          if (shouldReorder) reorderDeviceTab(id, drag.targetIndex);
        }
      });
      tab.addEventListener('pointercancel', function(event) {
        if (pointerDrag && pointerDrag.pointerId === event.pointerId) clearTabDrag();
      });
      tab.dataset.deviceId = id;
      if (id !== 'local') {
        var close = document.createElement('span');
        close.className = 'device-tab-close';
        close.textContent = '×';
        close.title = tr("closeDevice");
        close.addEventListener('click', function(event) { event.stopPropagation(); sendToExtension({ cmd: 'closeDevice', id: id }); });
        tab.appendChild(close);
      }
      deviceStrip.appendChild(tab);
    });
    updateDeviceTabsPresentation();
  }

function showNavigation(nextNavigation) {
    if (!state.environment.localMode || !nextNavigation) return;
    if (state.environment.editorMode) nextNavigation = Object.assign({}, nextNavigation, { tabs: [state.initial.navigation.selected], selected: state.initial.navigation.selected, page: nextNavigation.page === 'proc' ? 'proc' : 'perf' });
    closeRemoteMenu();
    var tabsChanged = state.ui.navigation.tabs.length !== nextNavigation.tabs.length || state.ui.navigation.tabs.some(function(id, index) { return id !== nextNavigation.tabs[index]; });
    if (state.ui.requestedPage && !tabsChanged && state.ui.navigation.selected === nextNavigation.selected) {
      if (nextNavigation.page === state.ui.requestedPage) state.ui.requestedPage = null;
      else nextNavigation = Object.assign({}, nextNavigation, { page: state.ui.requestedPage });
    } else state.ui.requestedPage = null;
    var tabAvailabilityChanged = (state.ui.navigation.tabs.length === 0) !== (nextNavigation.tabs.length === 0);
    if (tabAvailabilityChanged) topbar.classList.add('instant-page');
    var nextDeviceId = nextNavigation.selected;
    var deviceChanged = nextDeviceId !== state.ui.deviceId;
    if (deviceChanged) {
      state.ui.deviceId = nextDeviceId;
      connectionState = null;
      connectionError = null;
      connectionRetryAfter = null;
      retryPending = false;
      setSparkActivity(state.ui.paused, nextDeviceId === 'local');
      refreshConnectionRetryButton();
      clearDeviceContent();
    }
    state.ui.navigation = nextNavigation;
    state.ui.processDisplay = nextNavigation.processDisplay || state.ui.processDisplay;
    if (tabsChanged || deviceStrip.childElementCount !== nextNavigation.tabs.length) renderDeviceTabs();
    else updateDeviceTabsPresentation();
    switchTab(nextNavigation.page || 'servers', false);
    updateLocalIntro();
    if (deviceChanged) state.elements.connectionBanner.classList.remove('show');
    else state.elements.connectionBanner.classList.toggle('show', !!state.elements.connectionBannerText.textContent && nextNavigation.page !== 'servers');
    storeNavigation();
    if (tabAvailabilityChanged) requestAnimationFrame(function() {
      requestAnimationFrame(function() { topbar.classList.remove('instant-page'); });
    });
  }

function showConnection(connection) {
    connectionState = connection && connection.state;
    connectionError = connection && connection.error;
    connectionRetryAfter = connection && typeof connection.retryAfter === 'number' ? connection.retryAfter : null;
    setSparkActivity(state.ui.paused, connection.canPresent ?? connection.ready !== false);
    refreshConnectionBanner();
  }

function refreshConnectionBanner() {
    var labels = tr("cPUMemoryNetworkDiskIODisksGPU");
    var samplingError = state.data.status && (localizeError(state.data.status.error, state.locale.language) || (state.data.status.failures || []).map(function(failure) {
      return (labels[failure.key] || failure.key) + ': ' + localizeError(failure, state.locale.language);
    }).join(' · '));
    var text = connectionState === 'connecting' ? (tr("connectingToServer"))
      : connectionState === 'disconnected' ? (connectionError || (tr("disconnectedRetrying")))
      : samplingError || '';
    state.elements.connectionBannerText.textContent = text;
    state.elements.connectionBannerText.title = state.data.status?.failures?.map(failure => (labels[failure.key] || failure.key) + ': ' + failure.message).join('\n') || text;
    refreshConnectionRetryButton();
    state.elements.connectionBanner.classList.toggle('show', !!text && !state.elements.serverPage.classList.contains('active'));
  }

function handleNavigationMessage(data, presentSnapshot) {
    if (data && data.cmd === 'retryConnectionResult' && (state.environment.localMode ? data.deviceId === state.ui.deviceId : data.deviceId === 'local')) {
      retryPending = false;
      if (data.error && connectionState === 'disconnected') connectionError = data.error;
      refreshConnectionBanner();
      return true;
    }
    if (data.cmd === 'sshDefaultExtensions') {
      state.config.sshDefaultInstalled = data.installed === true;
      state.ui.installPending = false;
      updateSshDefaultUi(data.error);
      return true;
    }
    if (!state.environment.localMode || !data) return false;
    if (data.cmd === 'navigation') showNavigation(data.state);
    else if (data.cmd === 'localIntroDismissed') { state.ui.localIntroDismissed = true; updateLocalIntro(); }
    else if (data.cmd === 'deviceState') {
      showNavigation(data.state);
      presentSnapshot(data, true);
    }
    else if (data.cmd === 'servers') { state.data.serverRows = data.hosts || []; state.data.serverError = data.error || ''; renderServers(); }
    else if (data.cmd === 'remoteFolders' && state.ui.remoteMenuHost === data.host) showRemoteMenu(data.folders || []);
    else if (data.cmd === 'remoteWindowActionDone' && state.ui.remoteMenuHost === data.host) closeRemoteMenu();
    else return false;
    return true;
  }

export function initializeNavigation() {
  state.environment.localMode = state.initial.localMode === true;
  localLinux = state.initial.localLinux === true;
  state.environment.editorMode = state.environment.localMode && state.initial.surface === 'editor';
  previousNavigationState = state.environment.localMode ? state.bridge.getState() : null;
  state.ui.navigation = (previousNavigationState && previousNavigationState.navigation) || state.initial.navigation || { tabs: [], selected: null, page: 'servers' };
  if (state.environment.editorMode) {
      var editorDeviceId = state.initial.navigation.selected;
      state.ui.navigation = Object.assign({}, state.ui.navigation, { tabs: [editorDeviceId], selected: editorDeviceId, page: state.ui.navigation.page === 'proc' ? 'proc' : 'perf' });
    }
  state.ui.localIntroDismissed = false;
  pointerDrag = null;
  suppressDeviceClick = false;
  state.ui.requestedPage = null;
  state.ui.deviceId = state.ui.navigation.selected;
  serverTabButton = document.getElementById('tab-servers-btn');
  state.elements.serverPage = document.getElementById('tab-servers');
  deviceStrip = document.getElementById('device-strip');
  topbar = document.querySelector('.topbar');
  state.elements.connectionBanner = document.getElementById('connection-banner');
  state.elements.connectionBannerText = document.getElementById('connection-banner-text');
  connectionRetryButton = document.getElementById('connection-retry');
  connectionState = null;
  connectionError = null;
  connectionRetryAfter = null;
  retryPending = false;
  retryCountdownTimer = null;
  connectionRetryButton.addEventListener('click', function() {
      if (retryPending) return;
      var reconnect = connectionState === 'disconnected' && state.ui.deviceId && state.ui.deviceId.startsWith('ssh:');
      if (!reconnect && !hasSamplingFailure()) return;
      retryPending = true;
      refreshConnectionRetryButton();
      if (reconnect) sendToExtension({ cmd: 'retryConnection', deviceId: state.ui.deviceId });
      else sendToExtension({ cmd: 'retrySampling', deviceId: state.ui.deviceId || 'local' });
    });

}

export { hasSamplingFailure, retryButtonState, refreshConnectionRetryButton, storeNavigation, updateLocalIntro, clearTabDrag, moveTabWithinStrip, reorderDeviceTab, clearDeviceContent, updateDeviceTabsPresentation, renderDeviceTabs, showNavigation, showConnection, refreshConnectionBanner, handleNavigationMessage };

function switchTab(name, notify) {
    if (typeof state.environment.editorMode !== 'undefined' && state.environment.editorMode && name === 'servers') return;
    if (notify !== false && state.environment.localMode) {
      state.ui.requestedPage = name;
      state.ui.navigation = Object.assign({}, state.ui.navigation, { page: name });
      updateDeviceTabsPresentation();
      updateLocalIntro();
      state.elements.connectionBanner.classList.toggle('show', !!state.elements.connectionBannerText.textContent && name !== 'servers');
      closeRemoteMenu();
      storeNavigation();
      sendToExtension({cmd:'switchPage',page:name});
    }
    if (notify !== false && !state.environment.localMode) {
      state.bridge.setState(Object.assign({}, state.bridge.getState() || {}, {page:name}));
      sendToExtension({cmd:'switchPage',page:name});
    }
    if (name !== 'perf') hideGpuInfoPopover();
    document.querySelectorAll('.tab-content').forEach(function(d){d.classList.remove('active');});
    document.getElementById('tab-'+name).classList.add('active');
    document.getElementById('tab-perf-btn').classList.toggle('on', name==='perf');
    document.getElementById('tab-proc-btn').classList.toggle('on', name==='proc');
    var serversButton = document.getElementById('tab-servers-btn');
    if (serversButton) serversButton.classList.toggle('on', name==='servers');
    if (name === 'perf') requestAnimationFrame(function() { state.data.gpus.forEach(renderGpuUsers); });
    updateResponsiveLayout();
    showMonitorStatus(state.data.status);
  }

function showMonitorStatus(status) {
    if (!status) return;
    state.data.status = status;
    if (!status.ready && !state.data.viewModel) document.getElementById('gpu-summary').textContent = '--';
    setSparkActivity(state.ui.paused, status.canPresent ?? status.ready);
    refreshConnectionBanner();
  }


export { switchTab, showMonitorStatus };
