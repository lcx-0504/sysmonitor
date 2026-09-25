  var serverRows = [];
  var serverError = '';

  // Microsoft VS Code Codicons: open-in-product, empty-window, vm-connect, terminal (MIT).
  var serverIcons = {
    editor: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M15 3.5V6.5C15 6.776 14.776 7 14.5 7C14.224 7 14 6.776 14 6.5V3.5C14 2.673 13.327 2 12.5 2H3.5C2.673 2 2 2.673 2 3.5V12.5C2 13.327 2.673 14 3.5 14H6.5C6.776 14 7 14.224 7 14.5C7 14.776 6.776 15 6.5 15H3.5C2.121 15 1 13.879 1 12.5V3.5C1 2.121 2.121 1 3.5 1H12.5C13.879 1 15 2.121 15 3.5ZM15 9.5C15 9.224 14.776 9 14.5 9H9.5C9.224 9 9 9.224 9 9.5V14.5C9 14.776 9.224 15 9.5 15C9.776 15 10 14.776 10 14.5V10.707L14.146 14.853C14.244 14.951 14.372 14.999 14.5 14.999C14.628 14.999 14.756 14.95 14.854 14.853C15.049 14.658 15.049 14.341 14.854 14.146L10.708 10H14.501C14.777 10 15.001 9.776 15.001 9.5H15Z"/></svg>',
    window: '<svg viewBox="0 0 300 300" aria-hidden="true"><path transform="translate(0 300) scale(1 -1)" d="M281 225V75Q281 52 264.5 35.5Q248 19 225 19H75Q52 19 35.5 35.5Q19 52 19 75V136Q27 129 37 124V75Q38 59 48.5 48.5Q59 38 75 38H225Q241 38 252 48.5Q263 59 263 75V206H187L188 216L187 225H263Q263 241 252 252Q241 263 225 263H176Q171 273 164 281H225Q248 281 264.5 264.5Q281 248 281 225ZM0 216Q0 239 11.5 258Q23 277 42 288.5Q61 300 84 300Q107 300 126.5 288.5Q146 277 157.5 258Q169 239 169 216Q169 193 157.5 173.5Q146 154 126.5 142.5Q107 131 84 131Q61 131 42 142.5Q23 154 11.5 173.5Q0 193 0 216ZM28 216Q28 212 31 209Q34 206 38 206H75V169Q75 165 77.5 162Q80 159 84 159Q88 159 91 162Q94 165 94 169V206H131Q135 206 138 209Q141 212 141 216Q141 220 138 222.5Q135 225 131 225H94V263Q94 266 91 269Q88 272 84 272Q80 272 77.5 269Q75 266 75 262V225H38Q34 225 31 222.5Q28 220 28 216Z"/></svg>',
    remote: '<svg viewBox="0 0 300 300" aria-hidden="true"><path transform="translate(0 300) scale(1 -1)" d="M124 38Q129 27 136 19H66Q62 19 59 21.5Q56 24 56 28Q56 32 59 35Q62 38 66 38H94V75H56Q41 75 30 86Q19 97 19 113V244Q19 259 30 270Q41 281 56 281H244Q259 281 270 270Q281 259 281 244V164Q273 171 263 176V244Q262 252 257 257.5Q252 263 244 263H56Q48 262 43 257Q38 252 38 244V113Q38 105 43 99.5Q48 94 56 94H113V84V75V38ZM300 84Q300 61 288.5 42Q277 23 258 11.5Q239 0 216 0Q193 0 173.5 11.5Q154 23 142.5 42Q131 61 131 84Q131 107 142.5 126.5Q154 146 173.5 157.5Q193 169 216 169Q239 169 258 157.5Q277 146 288.5 126.5Q300 107 300 84ZM216 66Q216 67 215 69Q214 71 213 72L185 100Q182 103 178 103Q174 103 171.5 100.5Q169 98 169 94Q169 90 171 87L193 66L171 44Q169 41 169 37.5Q169 34 171.5 31Q174 28 178 28Q182 28 185 31L213 59Q214 60 215 62Q216 64 216 66ZM238 103 260 125Q263 127 263 131Q263 135 260 138Q257 141 253 141Q249 141 246 138L218 110Q217 109 216.5 107Q216 105 216 103Q216 101 216.5 99.5Q217 98 218 96L246 68Q249 66 253 66Q257 66 260 68.5Q263 71 263 75Q263 79 260 82Z"/></svg>',
    terminal: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.75 1.5H5.25C3.1815 1.5 1.5 3.183 1.5 5.25V18.75C1.5 20.8185 3.1815 22.5 5.25 22.5H18.75C20.8185 22.5 22.5 20.8185 22.5 18.75V5.25C22.5 3.183 20.8185 1.5 18.75 1.5ZM21 18.75C21 19.9905 19.9905 21 18.75 21H5.25C4.0095 21 3 19.9905 3 18.75V5.25C3 4.0095 4.0095 3 5.25 3H18.75C19.9905 3 21 4.0095 21 5.25V18.75ZM10.281 13.281L5.781 17.781C5.634 17.928 5.442 18 5.25 18C5.058 18 4.866 17.9265 4.719 17.781C4.4265 17.4885 4.4265 17.013 4.719 16.7205L8.688 12.7515L4.719 8.7825C4.4265 8.49 4.4265 8.0145 4.719 7.722C5.0115 7.4295 5.487 7.4295 5.7795 7.722L10.2795 12.222C10.572 12.5145 10.572 12.99 10.2795 13.2825L10.281 13.281ZM19.5 17.25C19.5 17.664 19.164 18 18.75 18H11.25C10.836 18 10.5 17.664 10.5 17.25C10.5 16.836 10.836 16.5 11.25 16.5H18.75C19.164 16.5 19.5 16.836 19.5 17.25Z"/></svg>'
  };
  var serverRowNodes = new Map();
  var remoteMenu = null, remoteMenuButton = null, remoteMenuHost = null;

  function closeRemoteMenu() {
    if (remoteMenu) remoteMenu.remove();
    if (remoteMenuButton) {
      remoteMenuButton.setAttribute('aria-expanded', 'false');
      remoteMenuButton.removeAttribute('aria-busy');
    }
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

  function showRemoteMenu(folders) {
    if (!remoteMenuButton || remoteMenu) return;
    remoteMenu = document.createElement('div');
    remoteMenu.className = 'server-folder-menu';
    remoteMenu.setAttribute('role', 'menu');
    remoteMenuButton.removeAttribute('aria-busy');
    remoteMenuButton.setAttribute('aria-expanded', 'true');
    document.body.appendChild(remoteMenu);
    renderRemoteMenu(folders);
  }

  function openRemoteMenu(host, button) {
    if (remoteMenuButton === button) { closeRemoteMenu(); return; }
    closeRemoteMenu();
    remoteMenuHost = host; remoteMenuButton = button;
    button.setAttribute('aria-busy', 'true');
    sendToExtension({ cmd: 'listRemoteFolders', host: host });
  }

  document.addEventListener('click', function(event) {
    if (remoteMenuButton && (!remoteMenu || !remoteMenu.contains(event.target)) && !remoteMenuButton.contains(event.target)) closeRemoteMenu();
  });
  document.addEventListener('keydown', function(event) { if (event.key === 'Escape') closeRemoteMenu(); });
  serverPage.addEventListener('scroll', closeRemoteMenu);
  window.addEventListener('resize', closeRemoteMenu);

  function renderServers() {
    if (!localMode) return;
    if (serversCfg.actions && serversCfg.actions.remoteWindow === false) closeRemoteMenu();
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
        floating.title = zh ? '在新窗口打开' : 'Open in New Window';
        floating.setAttribute('aria-label', floating.title);
        floating.addEventListener('click', function() { sendToExtension({ cmd: 'openServer', host: server.host, inWindow: true }); });
        var remote = document.createElement('button');
        remote.type = 'button'; remote.className = 'server-action server-remote';
        remote.innerHTML = serverIcons.remote;
        remote.title = zh ? '打开远程窗口' : 'Open Remote Window';
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
      status.lastChild.textContent = server.state === 'connected' ? (zh ? '已连接' : 'Connected') : server.state === 'connecting' ? (zh ? '连接中…' : 'Connecting…') : server.state === 'loading' ? (zh ? '资源加载中…' : 'Loading resources…') : server.state === 'disconnected' ? (zh ? '连接失败' : 'Failed') : (zh ? '未连接' : 'Idle');
      var summary = row.querySelector('.server-summary');
      var summaryClass = 'server-summary' + (server.state === 'disconnected' ? ' error' : '');
      if (summary.className !== summaryClass) summary.className = summaryClass;
      var summaryText = server.error || (server.metrics && server.metrics.length ? ' · ' + server.metrics.join(' · ') : server.state === 'connected' ? (zh ? ' · 正在采集…' : ' · Collecting…') : '');
      if (summary.textContent !== summaryText) summary.textContent = summaryText;
      summary.title = server.error || '';
      row.querySelector('.server-open').disabled = !!server.busy;
      row.querySelectorAll('.server-action').forEach(function(button) { button.disabled = !!server.busy; });
      var actionsVisible = serversCfg.actions || {};
      row.querySelector('.server-editor').hidden = actionsVisible.editor === false;
      row.querySelector('.server-window').hidden = actionsVisible.window === false;
      row.querySelector('.server-terminal').hidden = actionsVisible.terminal === false;
      row.querySelector('.server-remote').hidden = actionsVisible.remoteWindow === false;
      var position = list.children[index] || null;
      if (position !== row) list.insertBefore(row, position);
    });
  }

  document.getElementById('topbar-server-refresh').addEventListener('click', function() { sendToExtension({cmd:'refreshServers'}); });
  document.getElementById('server-intro-ssh-default').addEventListener('click', addSshDefaultExtension);
  updateSshDefaultUi();
  document.getElementById('server-intro-close').textContent = zh ? '我知道了' : 'Got it';
  document.getElementById('server-intro-close').addEventListener('click', function() {
    localIntroDismissed = true;
    updateLocalIntro();
    sendToExtension({ cmd: 'dismissLocalIntro' });
  });
