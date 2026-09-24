  // Local windows can monitor several Linux hosts. Each webview owns its navigation state.
  var localMode = __initCfg.localMode === true;
  var localLinux = __initCfg.localLinux === true;
  var previousNavigationState = localMode ? vscode.getState() : null;
  var navigation = (previousNavigationState && previousNavigationState.navigation) || __initCfg.navigation || { tabs: [], selected: null, page: 'servers' };
  var serverRows = [];
  var serverError = '';
  var localIntroDismissed = false;
  // Microsoft VS Code Codicons: open-in-product, multiple-windows, remote, terminal (MIT).
  var serverIcons = {
    editor: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M15 3.5V6.5C15 6.776 14.776 7 14.5 7C14.224 7 14 6.776 14 6.5V3.5C14 2.673 13.327 2 12.5 2H3.5C2.673 2 2 2.673 2 3.5V12.5C2 13.327 2.673 14 3.5 14H6.5C6.776 14 7 14.224 7 14.5C7 14.776 6.776 15 6.5 15H3.5C2.121 15 1 13.879 1 12.5V3.5C1 2.121 2.121 1 3.5 1H12.5C13.879 1 15 2.121 15 3.5ZM15 9.5C15 9.224 14.776 9 14.5 9H9.5C9.224 9 9 9.224 9 9.5V14.5C9 14.776 9.224 15 9.5 15C9.776 15 10 14.776 10 14.5V10.707L14.146 14.853C14.244 14.951 14.372 14.999 14.5 14.999C14.628 14.999 14.756 14.95 14.854 14.853C15.049 14.658 15.049 14.341 14.854 14.146L10.708 10H14.501C14.777 10 15.001 9.776 15.001 9.5H15Z"/></svg>',
    window: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M6 1.5l.5-.5h8l.5.5v7l-.5.5H12V8h2V4H7v1H6V1.5zM7 2v1h7V2H7zM1.5 7l-.5.5v7l.5.5h8l.5-.5v-7L9.5 7h-8zM2 9V8h7v1H2zm0 1h7v4H2v-4z"/></svg>',
    remote: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M12.904 9.57L8.928 5.596l3.976-3.976-.619-.62L8 5.286v.619l4.285 4.285.62-.618zM3 5.62l4.072 4.07L3 13.763l.619.618L8 10v-.619L3.619 5 3 5.619z"/></svg>',
    terminal: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.75 1.5H5.25C3.1815 1.5 1.5 3.183 1.5 5.25V18.75C1.5 20.8185 3.1815 22.5 5.25 22.5H18.75C20.8185 22.5 22.5 20.8185 22.5 18.75V5.25C22.5 3.183 20.8185 1.5 18.75 1.5ZM21 18.75C21 19.9905 19.9905 21 18.75 21H5.25C4.0095 21 3 19.9905 3 18.75V5.25C3 4.0095 4.0095 3 5.25 3H18.75C19.9905 3 21 4.0095 21 5.25V18.75ZM10.281 13.281L5.781 17.781C5.634 17.928 5.442 18 5.25 18C5.058 18 4.866 17.9265 4.719 17.781C4.4265 17.4885 4.4265 17.013 4.719 16.7205L8.688 12.7515L4.719 8.7825C4.4265 8.49 4.4265 8.0145 4.719 7.722C5.0115 7.4295 5.487 7.4295 5.7795 7.722L10.2795 12.222C10.572 12.5145 10.572 12.99 10.2795 13.2825L10.281 13.281ZM19.5 17.25C19.5 17.664 19.164 18 18.75 18H11.25C10.836 18 10.5 17.664 10.5 17.25C10.5 16.836 10.836 16.5 11.25 16.5H18.75C19.164 16.5 19.5 16.836 19.5 17.25Z"/></svg>'
  };
  var serverRowNodes = new Map();
  var remoteMenu = null, remoteMenuButton = null, remoteMenuHost = null;
  var pointerDrag = null;
  var suppressDeviceClick = false;
  var requestedPage = null;
  var currentDeviceId = navigation.selected;
  var serverTabButton = document.getElementById('tab-servers-btn');
  var serverPage = document.getElementById('tab-servers');
  var deviceStrip = document.getElementById('device-strip');
  var topbar = document.querySelector('.topbar');
  var connectionBanner = document.getElementById('connection-banner');

  function storeNavigation() {
    if (!localMode) return;
    vscode.setState(Object.assign({}, vscode.getState() || {}, { navigation: navigation }));
  }

  function updateLocalIntro() {
    var hint = document.getElementById('server-intro-hint');
    if (localMode) {
      var environment = localLinux
        ? (zh ? '当前本地环境是 Linux，你可以查看本机性能，也可以在此本地窗口查看远程 Linux 服务器的监控。' : 'This local environment is Linux. You can monitor this machine and remote Linux servers in the same local window.')
        : (zh ? '当前本地环境是 macOS／Windows。选择一台 Linux 服务器后，可以在此本地窗口查看其性能和进程。' : 'This local environment is macOS/Windows. Select a Linux server to view its performance and processes in this local window.');
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

  function closeRemoteMenu() {
    if (remoteMenu) remoteMenu.remove();
    if (remoteMenuButton) remoteMenuButton.setAttribute('aria-expanded', 'false');
    remoteMenu = null; remoteMenuButton = null; remoteMenuHost = null;
  }

  function positionRemoteMenu() {
    if (!remoteMenu || !remoteMenuButton) return;
    var rect = remoteMenuButton.getBoundingClientRect();
    remoteMenu.style.left = Math.max(4, Math.min(rect.right - remoteMenu.offsetWidth, window.innerWidth - remoteMenu.offsetWidth - 4)) + 'px';
    remoteMenu.style.top = (window.innerHeight - rect.bottom >= remoteMenu.offsetHeight + 4 ? rect.bottom + 3 : Math.max(4, rect.top - remoteMenu.offsetHeight - 3)) + 'px';
  }

  function renderRemoteMenu(folders) {
    if (!remoteMenu) return;
    remoteMenu.innerHTML = '';
    var connect = document.createElement('button');
    connect.type = 'button'; connect.className = 'server-folder-item'; connect.setAttribute('role', 'menuitem');
    connect.textContent = zh ? '连接主机' : 'Connect to host';
    connect.addEventListener('click', function() {
      var host = remoteMenuHost; closeRemoteMenu();
      sendToExtension({ cmd: 'openRemoteWindow', host: host });
    });
    remoteMenu.appendChild(connect);
    if (folders.length) {
      var divider = document.createElement('div');
      divider.className = 'server-folder-divider';
      divider.setAttribute('aria-hidden', 'true');
      remoteMenu.appendChild(divider);
    }
    folders.forEach(function(folder) {
      var item = document.createElement('button');
      item.type = 'button'; item.className = 'server-folder-item'; item.setAttribute('role', 'menuitem');
      item.textContent = folder.folder; item.title = folder.folder;
      item.addEventListener('click', function() {
        var host = remoteMenuHost; closeRemoteMenu();
        sendToExtension({ cmd: 'openRemoteWindow', host: host, folderIndex: folder.index });
      });
      remoteMenu.appendChild(item);
    });
    positionRemoteMenu();
  }

  function openRemoteMenu(host, button) {
    if (remoteMenuButton === button) { closeRemoteMenu(); return; }
    closeRemoteMenu();
    remoteMenu = document.createElement('div');
    remoteMenu.className = 'server-folder-menu';
    remoteMenu.setAttribute('role', 'menu');
    remoteMenuHost = host; remoteMenuButton = button;
    button.setAttribute('aria-expanded', 'true');
    document.body.appendChild(remoteMenu);
    renderRemoteMenu([]);
    sendToExtension({ cmd: 'listRemoteFolders', host: host });
  }

  document.addEventListener('click', function(event) {
    if (remoteMenu && !remoteMenu.contains(event.target) && !remoteMenuButton.contains(event.target)) closeRemoteMenu();
  });
  document.addEventListener('keydown', function(event) { if (event.key === 'Escape') closeRemoteMenu(); });
  serverPage.addEventListener('scroll', closeRemoteMenu);
  window.addEventListener('resize', closeRemoteMenu);

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
    deviceStrip.hidden = !hasTabs || navigation.page === 'servers';
    topbar.hidden = false;
    document.getElementById('tab-perf-btn').hidden = !hasTabs;
    document.getElementById('tab-proc-btn').hidden = !hasTabs;
    serverTabButton.hidden = false;
    deviceStrip.querySelectorAll('.device-tab').forEach(function(tab) {
      var active = navigation.selected === tab.dataset.deviceId && navigation.page !== 'servers';
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    var serverPageActive = navigation.page === 'servers';
    document.querySelector('.server-page-head').hidden = true;
    document.getElementById('updated').hidden = serverPageActive;
    document.getElementById('pause-btn').hidden = serverPageActive;
    document.getElementById('topbar-server-refresh').hidden = !serverPageActive;
  }

  function renderDeviceTabs() {
    if (!localMode) return;
    deviceStrip.innerHTML = '';
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

  function renderServers() {
    if (!localMode) return;
    var list = document.getElementById('server-list');
    var names = new Set(serverRows.map(function(server) { return server.host; }));
    serverRowNodes.forEach(function(row, host) {
      if (!names.has(host)) { row.remove(); serverRowNodes.delete(host); }
    });
    var placeholder = list.querySelector('.server-placeholder');
    if (placeholder) placeholder.remove();
    if (!serverRows.length) {
      var empty = document.createElement('div');
      empty.className = 'server-placeholder';
      empty.textContent = serverError || (zh ? '未在 SSH 配置中找到服务器。' : 'No hosts found in SSH config.');
      list.appendChild(empty);
    }
    serverRows.forEach(function(server, index) {
      var row = serverRowNodes.get(server.host);
      if (!row) {
        row = document.createElement('div');
        row.className = 'server-row';
        var main = document.createElement('div');
        main.className = 'server-main';
        var name = document.createElement('span');
        name.className = 'server-name';
        name.textContent = server.host; name.title = server.host;
        var meta = document.createElement('div');
        meta.className = 'server-meta';
        var status = document.createElement('span');
        status.className = 'server-state';
        var indicator = document.createElement('span');
        indicator.className = 'server-state-dot';
        var stateText = document.createElement('span');
        status.appendChild(indicator); status.appendChild(stateText);
        var summary = document.createElement('span');
        summary.className = 'server-summary';
        meta.appendChild(status); meta.appendChild(summary);
        main.appendChild(name); main.appendChild(meta);
        var actions = document.createElement('div');
        actions.className = 'server-actions';
        var open = document.createElement('button');
        open.type = 'button'; open.className = 'tb server-open';
        open.textContent = zh ? '打开' : 'Open';
        open.addEventListener('click', function() { sendToExtension({ cmd: 'openServer', host: server.host }); });
        var editor = document.createElement('button');
        editor.type = 'button'; editor.className = 'server-action server-editor';
        editor.innerHTML = serverIcons.editor;
        editor.title = zh ? '在编辑器中打开' : 'Open in Editor';
        editor.setAttribute('aria-label', editor.title);
        editor.addEventListener('click', function() { sendToExtension({ cmd: 'openServer', host: server.host, inEditor: true }); });
        var floating = document.createElement('button');
        floating.type = 'button'; floating.className = 'server-action server-window';
        floating.innerHTML = serverIcons.window;
        floating.title = zh ? '在新窗口中打开监控' : 'Open Monitor in New Window';
        floating.setAttribute('aria-label', floating.title);
        floating.addEventListener('click', function() { sendToExtension({ cmd: 'openServer', host: server.host, inWindow: true }); });
        var remote = document.createElement('button');
        remote.type = 'button'; remote.className = 'server-action server-remote';
        remote.innerHTML = serverIcons.remote;
        remote.title = zh ? '打开 Remote-SSH 窗口' : 'Open Remote-SSH Window';
        remote.setAttribute('aria-label', remote.title);
        remote.setAttribute('aria-haspopup', 'menu');
        remote.setAttribute('aria-expanded', 'false');
        remote.addEventListener('click', function() { openRemoteMenu(server.host, remote); });
        var terminal = document.createElement('button');
        terminal.type = 'button'; terminal.className = 'server-action server-terminal';
        terminal.innerHTML = serverIcons.terminal;
        terminal.title = zh ? '打开 SSH 终端' : 'Open SSH Terminal';
        terminal.setAttribute('aria-label', terminal.title);
        terminal.addEventListener('click', function() { sendToExtension({ cmd: 'openTerminal', host: server.host }); });
        actions.appendChild(open); actions.appendChild(editor); actions.appendChild(floating); actions.appendChild(terminal); actions.appendChild(remote);
        row.appendChild(main); row.appendChild(actions);
        serverRowNodes.set(server.host, row);
      }
      var status = row.querySelector('.server-state');
      var statusClass = 'server-state' + (server.state === 'connected' ? ' connected' : server.state === 'disconnected' ? ' error' : '');
      if (status.className !== statusClass) status.className = statusClass;
      var indicatorClass = server.busy ? 'server-spinner' : 'server-state-dot';
      if (status.firstChild.className !== indicatorClass) status.firstChild.className = indicatorClass;
      status.lastChild.textContent = server.state === 'connected' ? (zh ? '已连接' : 'Connected') : server.state === 'connecting' ? (zh ? '连接中…' : 'Connecting…') : server.state === 'disconnected' ? (zh ? '连接失败' : 'Failed') : (zh ? '未连接' : 'Idle');
      var summary = row.querySelector('.server-summary');
      var summaryClass = 'server-summary' + (server.state === 'disconnected' ? ' error' : '');
      if (summary.className !== summaryClass) summary.className = summaryClass;
      var summaryText = server.error || (server.metrics && server.metrics.length ? ' · ' + server.metrics.join(' · ') : server.state === 'connected' ? (zh ? ' · 正在采集…' : ' · Collecting…') : '');
      if (summary.textContent !== summaryText) summary.textContent = summaryText;
      summary.title = server.error || '';
      row.querySelector('.server-open').disabled = !!server.busy;
      row.querySelectorAll('.server-action').forEach(function(button) { button.disabled = !!server.busy; });
      var position = list.children[index] || null;
      if (position !== row) list.insertBefore(row, position);
    });
  }

  function showNavigation(state) {
    if (!localMode || !state) return;
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
      clearDeviceContent();
    }
    navigation = state;
    processDisplay = state.processDisplay || processDisplay;
    if (tabsChanged || deviceStrip.childElementCount !== state.tabs.length) renderDeviceTabs();
    else updateDeviceTabsPresentation();
    switchTab(state.page || 'servers', false);
    updateLocalIntro();
    if (deviceChanged) connectionBanner.classList.remove('show');
    else connectionBanner.classList.toggle('show', !!connectionBanner.textContent && state.page !== 'servers');
    storeNavigation();
    if (tabAvailabilityChanged) requestAnimationFrame(function() {
      requestAnimationFrame(function() { topbar.classList.remove('instant-page'); });
    });
  }

  function showConnection(connection) {
    var state = connection && connection.state;
    var text = state === 'connecting' ? (zh ? '正在连接服务器…' : 'Connecting to server…') : state === 'disconnected' ? (connection.error || (zh ? '连接已断开，正在重试。' : 'Disconnected; retrying.')) : '';
    connectionBanner.textContent = text;
    connectionBanner.classList.toggle('show', !!text && navigation.page !== 'servers');
  }

  function restoreHistory(samples) {
    if (!localMode) return;
    cpuHist = []; ramHist = []; netTxHist = []; netRxHist = [];
    sshTxHist = []; sshRxHist = []; diskRHist = []; diskWHist = []; gpuHist = {};
    (samples || []).forEach(function(point) {
      function add(series, value) { series.push({ t: point.t, v: Number(value) || 0 }); }
      add(cpuHist, point.cpu); add(ramHist, point.ram);
      add(netTxHist, point.netTx); add(netRxHist, point.netRx);
      add(diskRHist, point.diskR); add(diskWHist, point.diskW);
      add(sshTxHist, point.sshTx); add(sshRxHist, point.sshRx);
      (point.gpus || []).forEach(function(gpu) {
        if (!gpuHist[gpu.idx]) gpuHist[gpu.idx] = [];
        gpuHist[gpu.idx].push({ t: point.t, v: Number(gpu.util) || 0 });
      });
    });
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
    else if (data.cmd === 'remoteFolders' && remoteMenuHost === data.host) renderRemoteMenu(data.folders || []);
    else if (data.cmd === 'history') restoreHistory(data.samples);
    else if (data.cmd === 'connection' && data.deviceId === currentDeviceId) showConnection(data);
    else if (data.cmd === 'config' && data.serversCfg) serversCfg = data.serversCfg;
    else if (data.cmd === 'sshDefaultExtensions') {
      sshDefaultInstalled = data.installed === true;
      sshDefaultPending = false;
      updateSshDefaultUi(data.error);
    }
  });

  document.getElementById('server-refresh-btn').addEventListener('click', function() { sendToExtension({cmd:'refreshServers'}); });
  document.getElementById('topbar-server-refresh').addEventListener('click', function() { sendToExtension({cmd:'refreshServers'}); });
  document.getElementById('server-settings-btn').addEventListener('click', openModal);
  document.getElementById('server-intro-ssh-default').addEventListener('click', addSshDefaultExtension);
  updateSshDefaultUi();
  document.getElementById('server-intro-close').textContent = zh ? '我知道了' : 'Got it';
  document.getElementById('server-intro-close').addEventListener('click', function() {
    localIntroDismissed = true;
    updateLocalIntro();
    sendToExtension({ cmd: 'dismissLocalIntro' });
  });
  showNavigation(navigation);
