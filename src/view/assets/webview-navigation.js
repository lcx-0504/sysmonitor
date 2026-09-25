  // Local windows can monitor several Linux hosts. Each webview owns its navigation state.
  var localMode = __initCfg.localMode === true;
  var localLinux = __initCfg.localLinux === true;
  var editorMode = localMode && __initCfg.surface === 'editor';
  var previousNavigationState = localMode ? vscode.getState() : null;
  var navigation = (previousNavigationState && previousNavigationState.navigation) || __initCfg.navigation || { tabs: [], selected: null, page: 'servers' };
  if (editorMode) {
    var editorDeviceId = __initCfg.navigation.selected;
    navigation = Object.assign({}, navigation, { tabs: [editorDeviceId], selected: editorDeviceId, page: navigation.page === 'proc' ? 'proc' : 'perf' });
  }
  var localIntroDismissed = false;
  var pointerDrag = null;
  var suppressDeviceClick = false;
  var requestedPage = null;
  var currentDeviceId = navigation.selected;
  var serverTabButton = document.getElementById('tab-servers-btn');
  var serverPage = document.getElementById('tab-servers');
  var deviceStrip = document.getElementById('device-strip');
  var topbar = document.querySelector('.topbar');
  var connectionBanner = document.getElementById('connection-banner');
  var connectionBannerText = document.getElementById('connection-banner-text');
  var connectionRetryButton = document.getElementById('connection-retry');
  var connectionState = null;
  var connectionRetryAfter = null;
  var retryPending = false;
  var retryCountdownTimer = null;

  function retryButtonState(state, pending, isPaused, retryAfter, now, isZh) {
    if (state === 'connecting' || pending) return { text: isZh ? '连接中' : 'Connecting', disabled: true, remaining: 0 };
    var remaining = state === 'disconnected' && !isPaused && typeof retryAfter === 'number'
      ? Math.max(0, Math.ceil((retryAfter - now) / 1000)) : 0;
    return { text: (isZh ? '重试' : 'Retry') + (remaining ? ' (' + remaining + ')' : ''), disabled: false, remaining: remaining };
  }

  function refreshConnectionRetryButton() {
    if (retryCountdownTimer) { clearTimeout(retryCountdownTimer); retryCountdownTimer = null; }
    var sshDevice = !!currentDeviceId && currentDeviceId.startsWith('ssh:');
    var now = Date.now();
    var buttonState = retryButtonState(connectionState, retryPending, paused, connectionRetryAfter, now, zh);
    connectionRetryButton.hidden = !sshDevice || connectionState !== 'connecting' && connectionState !== 'disconnected';
    connectionRetryButton.disabled = buttonState.disabled;
    connectionRetryButton.textContent = buttonState.text;
    if (buttonState.remaining) {
      var left = connectionRetryAfter - now;
      var untilNextSecond = left - (buttonState.remaining - 1) * 1000;
      retryCountdownTimer = setTimeout(refreshConnectionRetryButton, Math.max(1, untilNextSecond));
    }
  }
  connectionRetryButton.addEventListener('click', function() {
    if (retryPending || connectionState !== 'disconnected' || !currentDeviceId || !currentDeviceId.startsWith('ssh:')) return;
    retryPending = true;
    refreshConnectionRetryButton();
    sendToExtension({ cmd: 'retryConnection', deviceId: currentDeviceId });
  });

  function storeNavigation() {
    if (!localMode) return;
    vscode.setState(Object.assign({}, vscode.getState() || {}, { navigation: navigation }));
  }

  function updateLocalIntro() {
    var hint = document.getElementById('server-intro-hint');
    if (localMode) {
      var environment = localLinux
        ? (zh ? '当前本地环境是 Linux，你可以查看本机性能，也可以在此本地窗口查看远程 Linux 服务器的监控（仅限免密）。' : 'This local environment is Linux. You can monitor this machine and remote Linux servers in the same local window (passwordless SSH only).')
        : (zh ? '当前本地环境是 macOS／Windows。选择一台 Linux 服务器后，可以在此本地窗口查看其性能和进程（仅限免密）。' : 'This local environment is macOS/Windows. Select a Linux server to view its performance and processes in this local window (passwordless SSH only).');
      var remote = zh
        ? '你也可以在远程 Linux 窗口安装本扩展，直接在远程窗口中使用。'
        : 'You can also install the extension in a remote Linux window and use it there directly.';
      var install = sshDefaultInstalled
        ? (zh ? '已加入 Remote-SSH 默认列表，连接服务器时自动安装。' : 'Added to the Remote-SSH default list; installs automatically on SSH hosts.')
        : (zh ? '加入 Remote-SSH 默认列表后，连接服务器时自动安装。' : 'Add to the Remote-SSH default list to install automatically on SSH hosts.');
      document.getElementById('server-intro-text').textContent = [zh ? '系统监控支持 Linux 环境。' : 'System Monitor supports Linux environments.', environment, remote, install].join(zh ? '' : ' ');
    }
    hint.classList.toggle('show', localMode && __initCfg.showLocalIntro === true && !localIntroDismissed && navigation.page === 'servers');
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
    var reordered = navigation.tabs.filter(function(value) { return value !== draggedId; });
    reordered.splice(targetIndex, 0, draggedId);
    navigation = Object.assign({}, navigation, { tabs: reordered });
    renderDeviceTabs();
    storeNavigation();
    sendToExtension({ cmd: 'reorderDevices', tabs: reordered });
  }


  function clearDeviceContent() {
    cpuHist = []; ramHist = []; netTxHist = []; netRxHist = [];
    sshTxHist = []; sshRxHist = []; diskRHist = []; diskWHist = []; gpuHist = {};
    renderedDiskKeys = []; renderedAcceleratorKeys = []; lastDiskPayload = [];
    selectedGpus = {}; lastFreeIdxs = []; lastGpuPayload = [];
    procData = []; pendingProcData = null;
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
    var hasTabs = navigation.tabs.length > 0;
    deviceStrip.hidden = editorMode || !hasTabs || navigation.page === 'servers';
    document.getElementById('device-strip-wrap').hidden = deviceStrip.hidden;
    topbar.hidden = false;
    document.getElementById('tab-perf-btn').hidden = !hasTabs;
    document.getElementById('tab-proc-btn').hidden = !hasTabs;
    serverTabButton.hidden = editorMode;
    deviceStrip.querySelectorAll('.device-tab').forEach(function(tab) {
      var active = navigation.selected === tab.dataset.deviceId && navigation.page !== 'servers';
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    var serverPageActive = navigation.page === 'servers';
    document.getElementById('updated').hidden = serverPageActive;
    document.getElementById('pause-btn').hidden = serverPageActive;
    document.getElementById('topbar-server-refresh').hidden = editorMode || !serverPageActive;
    updateDeviceScrollbar();
  }

  function renderDeviceTabs() {
    if (!localMode) return;
    deviceStrip.innerHTML = '';
    if (editorMode) { updateDeviceTabsPresentation(); return; }
    navigation.tabs.forEach(function(id) {
      var tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'device-tab' + (navigation.selected === id && navigation.page !== 'servers' ? ' active' : '');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', navigation.selected === id && navigation.page !== 'servers' ? 'true' : 'false');
      var name = document.createElement('span');
      name.textContent = id === 'local' ? (zh ? '本机' : 'Local') : id.slice(4);
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
        close.title = zh ? '关闭设备' : 'Close device';
        close.addEventListener('click', function(event) { event.stopPropagation(); sendToExtension({ cmd: 'closeDevice', id: id }); });
        tab.appendChild(close);
      }
      deviceStrip.appendChild(tab);
    });
    updateDeviceTabsPresentation();
  }


  function showNavigation(state) {
    if (!localMode || !state) return;
    if (editorMode) state = Object.assign({}, state, { tabs: [editorDeviceId], selected: editorDeviceId, page: state.page === 'proc' ? 'proc' : 'perf' });
    closeRemoteMenu();
    var tabsChanged = navigation.tabs.length !== state.tabs.length || navigation.tabs.some(function(id, index) { return id !== state.tabs[index]; });
    if (requestedPage && !tabsChanged && navigation.selected === state.selected) {
      if (state.page === requestedPage) requestedPage = null;
      else state = Object.assign({}, state, { page: requestedPage });
    } else requestedPage = null;
    var tabAvailabilityChanged = (navigation.tabs.length === 0) !== (state.tabs.length === 0);
    if (tabAvailabilityChanged) topbar.classList.add('instant-page');
    var nextDeviceId = state.selected;
    var deviceChanged = nextDeviceId !== currentDeviceId;
    if (deviceChanged) {
      currentDeviceId = nextDeviceId;
      connectionState = null;
      connectionRetryAfter = null;
      retryPending = false;
      setSparkActivity(paused, nextDeviceId === 'local');
      refreshConnectionRetryButton();
      clearDeviceContent();
    }
    navigation = state;
    processDisplay = state.processDisplay || processDisplay;
    if (tabsChanged || deviceStrip.childElementCount !== state.tabs.length) renderDeviceTabs();
    else updateDeviceTabsPresentation();
    switchTab(state.page || 'servers', false);
    updateLocalIntro();
    if (deviceChanged) connectionBanner.classList.remove('show');
    else connectionBanner.classList.toggle('show', !!connectionBannerText.textContent && state.page !== 'servers');
    storeNavigation();
    if (tabAvailabilityChanged) requestAnimationFrame(function() {
      requestAnimationFrame(function() { topbar.classList.remove('instant-page'); });
    });
  }

  function showConnection(connection) {
    var state = connection && connection.state;
    connectionState = state;
    connectionRetryAfter = connection && typeof connection.retryAfter === 'number' ? connection.retryAfter : null;
    setSparkActivity(paused, state === 'connected' || currentDeviceId === 'local');
    var text = state === 'connecting' ? (zh ? '正在连接服务器…' : 'Connecting to server…') : state === 'disconnected' ? (connection.error || (zh ? '连接已断开，正在重试。' : 'Disconnected; retrying.')) : '';
    connectionBannerText.textContent = text;
    connectionBannerText.title = text;
    refreshConnectionRetryButton();
    connectionBanner.classList.toggle('show', !!text && navigation.page !== 'servers');
  }

  function restoreHistory(samples) {
    if (!localMode) return;
    cpuHist = []; ramHist = []; netTxHist = []; netRxHist = [];
    sshTxHist = []; sshRxHist = []; diskRHist = []; diskWHist = []; gpuHist = {};
    (samples || []).forEach(function(point) {
      function add(series, value) { pushHist(series, Number(value) || 0, point.t, true); }
      add(cpuHist, point.cpu); add(ramHist, point.ram);
      add(netTxHist, point.netTx); add(netRxHist, point.netRx);
      add(diskRHist, point.diskR); add(diskWHist, point.diskW);
      add(sshTxHist, point.sshTx); add(sshRxHist, point.sshRx);
      (point.gpus || []).forEach(function(gpu) {
        if (!gpuHist[gpu.idx]) gpuHist[gpu.idx] = [];
        pushHist(gpuHist[gpu.idx], Number(gpu.util) || 0, point.t, true);
      });
    });
    var now = Date.now();
    var inactive = paused || !connectionAllowsAnimation;
    allSparkSeries().forEach(function(series) {
      if (!series.length) return;
      var latest = series[series.length - 1];
      latest.receivedAt = inactive ? now - Math.max(1, (curInterval || 2) * 1000) : Math.min(now, latest.sourceTime);
    });
    if (inactive) sparkStoppedAt = now;
  }

  window.addEventListener('message', function(event) {
    var data = event.data;
    if (!localMode || !data) return;
    if (data.cmd === 'navigation') showNavigation(data.state);
    else if (data.cmd === 'localIntroDismissed') { localIntroDismissed = true; updateLocalIntro(); }
    else if (data.cmd === 'deviceState') {
      showNavigation(data.state);
      restoreHistory(data.samples);
      if (data.viewModel) renderMonitorSnapshot(data.viewModel, true, data.sampleTime, true);
      showConnection(data.connection);
    }
    else if (data.cmd === 'servers') { serverRows = data.hosts || []; serverError = data.error || ''; renderServers(); }
    else if (data.cmd === 'remoteFolders' && remoteMenuHost === data.host) showRemoteMenu(data.folders || []);
    else if (data.cmd === 'history') restoreHistory(data.samples);
    else if (data.cmd === 'connection' && data.deviceId === currentDeviceId) showConnection(data);
    else if (data.cmd === 'retryConnectionResult' && data.deviceId === currentDeviceId) {
      retryPending = false;
      if (data.error && connectionState === 'disconnected') {
        connectionBannerText.textContent = data.error;
        connectionBannerText.title = data.error;
      }
      refreshConnectionRetryButton();
    }
    else if (data.cmd === 'config' && data.serversCfg) { serversCfg = data.serversCfg; renderServers(); }
    else if (data.cmd === 'sshDefaultExtensions') {
      sshDefaultInstalled = data.installed === true;
      sshDefaultPending = false;
      updateSshDefaultUi(data.error);
    }
  });

  showNavigation(navigation);
