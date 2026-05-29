// session-webview.js — Session tab webview components (CSS, HTML, JS, translations)
// These functions return string segments that compose into the main webview HTML.

// ── CSS ────────────────────────────────────────────────────────────────────
function getSessionCSS() {
  return `
  /* Sessions tab */
  #tab-sess.active { display: flex; flex-direction: column; padding: 0; }
  #tab-sess .sess-toolbar { flex-shrink: 0; padding: var(--gap) var(--gap) 0 var(--gap); display: flex; align-items: center; gap: 6px; }
  #tab-sess .sess-body { flex: 1; overflow-y: auto; min-height: 0; padding: var(--gap); }
  .sess-breadcrumb { display: flex; align-items: center; gap: 4px; font-size: 11px; margin-bottom: 8px; flex-shrink: 0; }
  .sess-breadcrumb .bc-item { color: var(--vscode-descriptionForeground); cursor: pointer; padding: 1px 4px; border-radius: 3px; }
  .sess-breadcrumb .bc-item:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground, rgba(255,255,255,.04)); }
  .sess-breadcrumb .bc-sep { color: var(--vscode-descriptionForeground); }
  .sess-breadcrumb .bc-current { color: var(--vscode-foreground); font-weight: 600; }
  .sess-list { display: flex; flex-direction: column; gap: 4px; }
  .sess-item { display: flex; align-items: center; padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; transition: border-color .15s; gap: 8px; }
  .sess-item:hover { border-color: var(--accent); }
  .sess-item .sess-info { flex: 1; min-width: 0; }
  .sess-item .sess-name { font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sess-item .sess-meta { font-size: 10px; color: var(--vscode-descriptionForeground); display: flex; gap: 8px; margin-top: 2px; }
  .sess-badge { font-size: 9px; padding: 1px 5px; border-radius: 3px; background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #fff); white-space: nowrap; }
  .sess-badge.attached { background: var(--accent); }
  .win-list { display: flex; flex-direction: column; gap: 4px; }
  .win-item { display: flex; align-items: center; padding: 5px 10px; border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; transition: border-color .15s; gap: 8px; font-size: 11px; }
  .win-item:hover { border-color: var(--accent); }
  .win-item .win-idx { font-size: 10px; color: var(--vscode-descriptionForeground); width: 24px; flex-shrink: 0; }
  .win-item .win-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .win-item .win-cmd { font-size: 10px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
  .win-active-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
  .win-inactive-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--border); flex-shrink: 0; }
  .sess-terminal-wrap { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  .sess-terminal-toolbar { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex-shrink: 0; }
  .sess-terminal { flex: 1; overflow: auto; min-height: 0; background: var(--vscode-terminal-background, #1e1e1e); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px; }
  .sess-terminal pre { margin: 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.4; white-space: pre-wrap; word-break: break-all; color: var(--vscode-terminal-foreground, #cccccc); }
  .sess-na { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 16px; text-align: center; line-height: 1.6; }
  .sess-loading { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 16px; text-align: center; }
  .sess-refresh { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--border); border-radius: 4px; padding: 2px 8px; font-size: 10px; cursor: pointer; font-family: inherit; }
  .sess-refresh:hover { border-color: var(--accent); }
  .sess-add-btn { flex-shrink: 0; background: transparent; color: var(--vscode-foreground); border: 1px solid var(--border); border-radius: 4px; font-size: 10px; cursor: pointer; padding: 2px 8px; font-family: inherit; display: inline-flex; align-items: center; white-space: nowrap; }
  .sess-add-btn:hover { border-color: var(--accent); background: rgba(0,120,212,0.08); }
  .sess-expand-btn { flex-shrink: 0; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; cursor: pointer; background: transparent; border: 1px solid var(--border); border-radius: 3px; color: var(--vscode-descriptionForeground); font-size: 10px; transition: transform .2s, border-color .15s; user-select: none; }
  .sess-expand-btn:hover { border-color: var(--accent); color: var(--vscode-foreground); }
  .sess-expand-btn.open { transform: rotate(90deg); }
  .sess-connect-btn { flex-shrink: 0; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; cursor: pointer; background: transparent; border: 1px solid var(--border); border-radius: 3px; color: var(--vscode-descriptionForeground); font-size: 11px; transition: border-color .15s, color .15s; user-select: none; }
  .sess-connect-btn:hover { border-color: var(--accent); color: var(--vscode-textLink-foreground); }
  .sess-delete-btn { flex-shrink: 0; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; cursor: pointer; background: transparent; border: 1px solid var(--border); border-radius: 3px; color: var(--vscode-descriptionForeground); font-size: 11px; transition: border-color .15s, color .15s; user-select: none; margin-left: auto; }
  .sess-delete-btn:hover { border-color: #e74c3c; color: #e74c3c; }
  .sess-delete-btn.confirming { border-color: #e74c3c; color: #fff; background: #e74c3c; }
  .sess-preview-wrap { display: none; margin-top: 4px; padding: 6px 8px; background: var(--vscode-terminal-background, #1e1e1e); border: 1px solid var(--border); border-radius: var(--radius); }
  .sess-preview-wrap.show { display: block; }
  .sess-preview-wrap pre { margin: 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; line-height: 1.4; white-space: pre-wrap; word-break: break-all; color: var(--vscode-terminal-foreground, #cccccc); }
  .sess-item.expanded { border-color: var(--accent); }
  .sess-item.delete-pending { border-color: #e74c3c; background: rgba(231, 76, 60, 0.05); }
  /* Session create dialog */
  .sess-dialog-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 100; display: none; align-items: center; justify-content: center; }
  .sess-dialog { background: var(--vscode-editor-background,#1e1e1e); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; min-width: 280px; box-shadow: 0 8px 32px rgba(0,0,0,.4); }
  .sess-dialog h3 { margin: 0 0 12px; font-size: 13px; font-weight: 600; }
  .sess-dialog label { display: block; font-size: 11px; margin-bottom: 4px; color: var(--muted); }
  .sess-dialog input, .sess-dialog select { width: 100%; padding: 4px 8px; background: var(--vscode-input-background,#3c3c3c); color: var(--vscode-input-foreground,#ccc); border: 1px solid var(--border); border-radius: 4px; font-size: 12px; box-sizing: border-box; outline: none; }
  .sess-dialog input:focus, .sess-dialog select:focus { border-color: var(--accent); }
  .sess-dialog-row { margin-bottom: 12px; }
  .sess-dialog-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .sess-dialog-actions button { padding: 4px 14px; font-size: 12px; border-radius: 4px; cursor: pointer; border: 1px solid var(--border); background: var(--vscode-button-background,#0078d4); color: var(--vscode-button-foreground,#fff); font-family: inherit; }
  .sess-dialog-actions button.cancel { background: transparent; color: var(--vscode-foreground); }
  .sess-dialog-actions button.cancel:hover { border-color: var(--accent); }
  `;
}

// ── HTML ───────────────────────────────────────────────────────────────────
function getSessionHTML() {
  return `
<!-- ── 会话 tab ── -->
<div class="tab-content" id="tab-sess">
  <div class="sess-toolbar">
    <button class="sess-add-btn" id="sess-add-btn">新增会话</button>
    <button class="sess-refresh" id="sess-refresh-btn">刷新</button>
    <div class="spacer"></div>
  </div>
  <div class="sess-body" id="sess-body">
    <span class="sess-loading">--</span>
  </div>
</div>

<!-- Session create dialog -->
<div class="sess-dialog-overlay" id="sess-dialog">
  <div class="sess-dialog">
    <h3 id="sess-dialog-title">新建会话</h3>
    <div class="sess-dialog-row">
      <label id="sess-dialog-name-label">会话名称</label>
      <input type="text" id="sess-dialog-name" placeholder="my-session">
    </div>
    <div class="sess-dialog-row">
      <label id="sess-dialog-type-label">类型</label>
      <select id="sess-dialog-type">
        <option value="tmux">Tmux</option>
        <option value="screen">Screen</option>
      </select>
    </div>
    <div class="sess-dialog-actions">
      <button class="cancel" id="sess-dialog-cancel">取消</button>
      <button id="sess-dialog-confirm">创建</button>
    </div>
  </div>
</div>`;
}

// ── Translations ───────────────────────────────────────────────────────────
function getSessionTranslations() {
  return {
    zh: {
      sessTab:'会话',sessNoTools:'未检测到 screen 或 tmux',sessNoSessions:'暂无活跃会话',sessWindows:'窗口',sessAttached:'已连接',sessDetached:'已断开',sessRefresh:'刷新',sessCopyOutput:'复制输出',sessBack:'返回',sessLoading:'加载中…',sessError:'获取数据失败',sessScreen:'Screen',sessTmux:'Tmux',sessTerminal:'终端输出',sessAdd:'新建会话',sessNameLabel:'会话名称',sessTypeLabel:'类型',sessCreate:'创建',sessCancel:'取消',sessNamePlaceholder:'my-session',sessDialogTitle:'新建会话',
      sessLabel:'会话',sessTermLines:'终端行数',sessTermLines10:'10 行',sessTermLines20:'20 行',sessTermLines30:'30 行',sessTermLinesCustom:'自定义',sessAutoRefresh:'自动刷新',sessAutoRefreshOff:'关闭',sessExpand:'展开预览',sessCollapse:'收起预览',sessConnect:'接入终端',sessConnectTitle:'在终端中连接到 {name}',sessDelete:'删除会话',sessDeleteConfirm:'确定要删除会话 "{name}" 吗？此操作不可恢复。',sessDeleteConfirm2:'再次点击确认删除'
    },
    en: {
      sessTab:'Sessions',sessNoTools:'screen and tmux not found',sessNoSessions:'No active sessions',sessWindows:'windows',sessAttached:'Attached',sessDetached:'Detached',sessRefresh:'Refresh',sessCopyOutput:'Copy Output',sessBack:'Back',sessLoading:'Loading…',sessError:'Failed to fetch data',sessScreen:'Screen',sessTmux:'Tmux',sessTerminal:'Terminal Output',sessAdd:'New Session',sessNameLabel:'Session Name',sessTypeLabel:'Type',sessCreate:'Create',sessCancel:'Cancel',sessNamePlaceholder:'my-session',sessDialogTitle:'New Session',
      sessLabel:'Sessions',sessTermLines:'Terminal Lines',sessTermLines10:'10 lines',sessTermLines20:'20 lines',sessTermLines30:'30 lines',sessTermLinesCustom:'Custom',sessAutoRefresh:'Auto Refresh',sessAutoRefreshOff:'Off',sessExpand:'Expand Preview',sessCollapse:'Collapse Preview',sessConnect:'Connect',sessConnectTitle:'Attach to {name} in terminal',sessDelete:'Delete Session',sessDeleteConfirm:'Delete session "{name}"? This cannot be undone.',sessDeleteConfirm2:'Click again to confirm'
    }
  };
}

// ── JavaScript ─────────────────────────────────────────────────────────────
function getSessionJS() {
  return `
  // ── 会话 tab ──
  var sessLevel = 0;          // 0=session list, 1=window list, 2=terminal output
  var sessData = null;         // { sessions: [], tools: { screen, tmux } }
  var sessSelected = null;     // selected session object
  var sessWindows = null;      // windows array for selected session
  var sessWinSelected = null;  // selected window object
  var sessTerminal = null;     // terminal output content string
  var sessTools = { screen: false, tmux: false };
  var sessPreviews = {};       // { sessionName: { content, windowIndex } }
  var sessExpanded = {};       // { sessionName: true }
  var sessDeletePending = {};  // { sessionName: timerId } — two-step delete
  var _sessAutoRefreshTimer = null;

  function toggleSessionPreview(sessionName, sessionType) {
    if (sessExpanded[sessionName]) {
      delete sessExpanded[sessionName];
      delete sessPreviews[sessionName];
      if (Object.keys(sessExpanded).length === 0 && sessLevel !== 2) stopAutoRefresh();
    } else {
      sessExpanded[sessionName] = true;
      vscode.postMessage({ cmd: 'needTerminalPreview', sessionType: sessionType, sessionName: sessionName });
      if (!_sessAutoRefreshTimer) startAutoRefresh();
    }
    renderSessions();
  }

  function stopAutoRefresh() {
    if (_sessAutoRefreshTimer) { clearInterval(_sessAutoRefreshTimer); _sessAutoRefreshTimer = null; }
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    var sec = typeof sessionAutoRefresh === 'number' ? sessionAutoRefresh : 3;
    if (sec <= 0) return;
    _sessAutoRefreshTimer = setInterval(function() {
      if (sessLevel === 2 && sessSelected && sessWinSelected) {
        vscode.postMessage({ cmd: 'needTerminalOutput', sessionType: sessSelected.type, sessionName: sessSelected.name, windowIndex: sessWinSelected.index });
      }
      var expanded = Object.keys(sessExpanded);
      for (var i = 0; i < expanded.length; i++) {
        var sn = expanded[i];
        var st = (sessData && sessData.sessions) ? sessData.sessions.find(function(s) { return s.name === sn; }) : null;
        if (st) vscode.postMessage({ cmd: 'needTerminalPreview', sessionType: st.type, sessionName: sn });
      }
    }, sec * 1000);
  }

  function selectSession(idx) {
    if (!sessData || !sessData.sessions[idx]) return;
    sessSelected = sessData.sessions[idx];
    sessLevel = 1;
    sessWindows = null;
    sessWinSelected = null;
    sessTerminal = null;
    renderSessions();
    vscode.postMessage({ cmd: 'needSessionWindows', sessionType: sessSelected.type, sessionName: sessSelected.name });
  }

  function selectWindow(idx) {
    if (!sessWindows || !sessWindows[idx]) return;
    sessWinSelected = sessWindows[idx];
    sessLevel = 2;
    sessTerminal = null;
    renderSessions();
    startAutoRefresh();
    vscode.postMessage({ cmd: 'needTerminalOutput', sessionType: sessSelected.type, sessionName: sessSelected.name, windowIndex: sessWinSelected.index });
  }

  function navigateSessLevel(level) {
    stopAutoRefresh();
    if (level === 0) {
      sessLevel = 0; sessSelected = null; sessWindows = null; sessWinSelected = null; sessTerminal = null;
    } else if (level === 1) {
      sessLevel = 1; sessWinSelected = null; sessTerminal = null;
    }
    renderSessions();
  }

  function copyTerminalOutput() {
    if (sessTerminal == null) return;
    var ta = document.createElement('textarea'); ta.value = sessTerminal;
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
  }

  function refreshTerminalOutput() {
    if (sessLevel === 0) {
      sessData = null;
      renderSessions();
      vscode.postMessage({ cmd: 'needSessions' });
    } else if (sessLevel === 1 && sessSelected) {
      sessWindows = null;
      renderSessions();
      vscode.postMessage({ cmd: 'needSessionWindows', sessionType: sessSelected.type, sessionName: sessSelected.name });
    } else if (sessLevel === 2 && sessSelected && sessWinSelected) {
      sessTerminal = null;
      renderSessions();
      vscode.postMessage({ cmd: 'needTerminalOutput', sessionType: sessSelected.type, sessionName: sessSelected.name, windowIndex: sessWinSelected.index });
    }
  }

  // ── delegated click handler on sessions body ──
  document.getElementById('sess-body').addEventListener('click', function(e) {
    var el = e.target;
    var bc = el.closest('.bc-item');
    if (bc) { var lvl = parseInt(bc.getAttribute('data-level')); if (!isNaN(lvl)) navigateSessLevel(lvl); return; }
    if (el.classList.contains('sess-expand-btn')) {
      e.stopPropagation();
      toggleSessionPreview(el.getAttribute('data-name'), el.getAttribute('data-type'));
      return;
    }
    if (el.classList.contains('sess-connect-btn')) {
      e.stopPropagation();
      vscode.postMessage({ cmd: 'openSessionTerminal', sessionType: el.getAttribute('data-type'), sessionName: el.getAttribute('data-name') });
      return;
    }
    if (el.classList.contains('sess-delete-btn')) {
      e.stopPropagation();
      var delName = el.getAttribute('data-name');
      if (sessDeletePending[delName]) {
        clearTimeout(sessDeletePending[delName]);
        delete sessDeletePending[delName];
        vscode.postMessage({ cmd: 'killSession', sessionType: el.getAttribute('data-type'), sessionName: delName });
      } else {
        sessDeletePending[delName] = setTimeout(function() { delete sessDeletePending[delName]; renderSessions(); }, 3000);
      }
      renderSessions();
      return;
    }
    if (Object.keys(sessDeletePending).length) {
      for (var k in sessDeletePending) { clearTimeout(sessDeletePending[k]); }
      sessDeletePending = {};
      renderSessions();
    }
    var si = el.closest('.sess-item');
    if (si) { var idx = parseInt(si.getAttribute('data-idx')); if (!isNaN(idx)) selectSession(idx); return; }
    var wi = el.closest('.win-item');
    if (wi) { var idx2 = parseInt(wi.getAttribute('data-idx')); if (!isNaN(idx2)) selectWindow(idx2); return; }
    var act = el.getAttribute('data-action');
    if (act === 'copy') { copyTerminalOutput(); return; }
    if (act === 'refresh') { refreshTerminalOutput(); return; }
  });

  document.getElementById('sess-refresh-btn').addEventListener('click', refreshTerminalOutput);

  // ── session create dialog ──
  function openSessDialog() {
    document.getElementById('sess-dialog').style.display = 'flex';
    document.getElementById('sess-dialog-name').value = '';
    document.getElementById('sess-dialog-name').focus();
  }
  function closeSessDialog() {
    document.getElementById('sess-dialog').style.display = 'none';
  }
  document.getElementById('sess-add-btn').addEventListener('click', openSessDialog);
  document.getElementById('sess-dialog-cancel').addEventListener('click', closeSessDialog);
  document.getElementById('sess-dialog-confirm').addEventListener('click', function() {
    var name = document.getElementById('sess-dialog-name').value.trim();
    if (!name) return;
    var type = document.getElementById('sess-dialog-type').value;
    vscode.postMessage({ cmd: 'createSession', sessionType: type, sessionName: name });
    closeSessDialog();
  });
  document.getElementById('sess-dialog-name').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') document.getElementById('sess-dialog-confirm').click();
    if (e.key === 'Escape') closeSessDialog();
  });
  document.getElementById('sess-dialog').addEventListener('click', function(e) {
    if (e.target === this) closeSessDialog();
  });

  function renderSessions() {
    var body = document.getElementById('sess-body');
    if (!body) return;
    var h = '';

    function bcSep() { return '<span class="bc-sep">›</span>'; }
    if (sessLevel === 0) {
      h += '<div class="sess-breadcrumb"><span class="bc-current">' + esc(T.sessTab || 'Sessions') + '</span></div>';
    } else if (sessLevel === 1) {
      h += '<div class="sess-breadcrumb"><span class="bc-item" data-level="0">' + esc(T.sessTab || 'Sessions') + '</span>' + bcSep() + '<span class="bc-current">' + esc(sessSelected ? sessSelected.name : '') + '</span></div>';
    } else if (sessLevel === 2) {
      h += '<div class="sess-breadcrumb"><span class="bc-item" data-level="0">' + esc(T.sessTab || 'Sessions') + '</span>' + bcSep() + '<span class="bc-item" data-level="1">' + esc(sessSelected ? sessSelected.name : '') + '</span>' + bcSep() + '<span class="bc-current">' + esc(sessWinSelected ? ('#' + sessWinSelected.index + ' ' + sessWinSelected.name) : '') + '</span></div>';
    }

    if (sessLevel === 0) {
      if (!sessData) {
        h += '<div class="sess-loading">' + esc(T.sessLoading || 'Loading...') + '</div>';
      } else if (sessData.sessions.length === 0) {
        var noTools = !sessTools.screen && !sessTools.tmux;
        h += '<div class="sess-na">' + esc(noTools ? (T.sessNoTools || 'screen and tmux not found') : (T.sessNoSessions || 'No active sessions')) + '</div>';
      } else {
        h += '<div class="sess-list">';
        for (var i = 0; i < sessData.sessions.length; i++) {
          var s = sessData.sessions[i];
          var badgeClass = s.status === 'Attached' ? 'attached' : '';
          var statusLabel = s.status === 'Attached' ? (T.sessAttached || 'Attached') : (T.sessDetached || 'Detached');
          var isExpanded = !!sessExpanded[s.name];
          var isDeletePending = !!sessDeletePending[s.name];
          var preview = sessPreviews[s.name];
          h += '<div class="sess-item' + (isExpanded ? ' expanded' : '') + (isDeletePending ? ' delete-pending' : '') + '" data-idx="' + i + '">';
          h += '<span class="sess-expand-btn' + (isExpanded ? ' open' : '') + '" data-action="expand" data-name="' + esc(s.name) + '" data-type="' + s.type + '" title="' + (isExpanded ? T.sessCollapse : T.sessExpand) + '">▶</span>';
          h += '<span class="sess-connect-btn" data-action="connect" data-name="' + esc(s.name) + '" data-type="' + s.type + '" title="' + esc((T.sessConnectTitle || 'Attach to {name} in terminal').replace('{name}', s.name)) + '">⏎</span>';
          h += '<div class="sess-info"><div class="sess-name">' + esc(s.name) + '</div>';
          h += '<div class="sess-meta"><span>' + s.windowCount + ' ' + esc(T.sessWindows || 'windows') + '</span>';
          h += '<span class="sess-badge ' + badgeClass + '">' + esc(statusLabel) + '</span>';
          if (s.created) h += '<span>' + esc(s.created) + '</span>';
          var delTitle = isDeletePending ? (T.sessDeleteConfirm2 || 'Click again to confirm') : (T.sessDelete || 'Delete Session');
          var delIcon = isDeletePending ? '✓' : '✕';
          h += '</div></div><span class="sess-delete-btn' + (isDeletePending ? ' confirming' : '') + '" data-action="delete" data-name="' + esc(s.name) + '" data-type="' + s.type + '" title="' + esc(delTitle) + '">' + delIcon + '</span></div>';
          h += '<div class="sess-preview-wrap' + (isExpanded ? ' show' : '') + '" data-preview="' + esc(s.name) + '">';
          if (isExpanded && !preview) {
            h += '<pre>' + esc(T.sessLoading || 'Loading...') + '</pre>';
          } else if (isExpanded && preview) {
            h += '<pre>' + esc(preview.content || '(empty)') + '</pre>';
          }
          h += '</div>';
        }
        h += '</div>';
      }
    } else if (sessLevel === 1) {
      if (sessWindows === null) {
        h += '<div class="sess-loading">' + esc(T.sessLoading || 'Loading...') + '</div>';
      } else if (sessWindows.length === 0) {
        h += '<div class="sess-na">' + esc(T.sessNoSessions || 'No windows') + '</div>';
      } else {
        h += '<div class="win-list">';
        for (var j = 0; j < sessWindows.length; j++) {
          var w = sessWindows[j];
          h += '<div class="win-item" data-idx="' + j + '">';
          h += '<span class="' + (w.active ? 'win-active-dot' : 'win-inactive-dot') + '"></span>';
          h += '<span class="win-idx">#' + w.index + '</span>';
          h += '<span class="win-name">' + esc(w.name) + '</span>';
          if (w.command) h += '<span class="win-cmd">' + esc(w.command) + '</span>';
          h += '</div>';
        }
        h += '</div>';
      }
    } else if (sessLevel === 2) {
      h += '<div class="sess-terminal-wrap">';
      h += '<div class="sess-terminal-toolbar">';
      h += '<button class="sess-refresh" data-action="copy">' + esc(T.sessCopyOutput || 'Copy Output') + '</button>';
      h += '<button class="sess-refresh" data-action="refresh">' + esc(T.sessRefresh || 'Refresh') + '</button>';
      h += '</div>';
      if (sessTerminal === null) {
        h += '<div class="sess-loading">' + esc(T.sessLoading || 'Loading...') + '</div>';
      } else {
        h += '<div class="sess-terminal" id="sess-terminal-box"><pre>' + esc(sessTerminal || '(empty)') + '</pre></div>';
      }
      h += '</div>';
    }

    body.innerHTML = h;

    if (sessLevel === 2 && sessTerminal !== null) {
      var termBox = document.getElementById('sess-terminal-box');
      if (termBox) termBox.scrollTop = termBox.scrollHeight;
    }
  }

  renderSessions();
  `;
}

// ── Session message handler (webview side) — called from main message handler ──
function handleSessionWebviewMessage(data) {
  if (data.cmd === 'sessions') {
    sessData = data.data;
    sessTools = (data.data && data.data.tools) || { screen: false, tmux: false };
    renderSessions();
    return true;
  }
  if (data.cmd === 'sessionWindows') {
    sessWindows = (data.data && data.data.windows) || [];
    renderSessions();
    return true;
  }
  if (data.cmd === 'terminalOutput') {
    sessTerminal = (data.data && data.data.content) || '';
    renderSessions();
    return true;
  }
  if (data.cmd === 'terminalPreview') {
    var pdata = data.data || {};
    sessPreviews[pdata.sessionName] = { content: pdata.content || '', windowIndex: pdata.windowIndex };
    renderSessions();
    return true;
  }
  return false;
}

// ── Session setLang bindings — called by setLang() to update session UI text ──
function getSessionSetLangCalls() {
  return `
    document.getElementById('tab-sess-btn').textContent = T.sessTab;
    document.getElementById('sess-refresh-btn').textContent = T.sessRefresh;
    document.getElementById('sess-add-btn').textContent = T.sessAdd;
    document.getElementById('sess-dialog-title').textContent = T.sessDialogTitle;
    document.getElementById('sess-dialog-name-label').textContent = T.sessNameLabel;
    document.getElementById('sess-dialog-name').placeholder = T.sessNamePlaceholder || 'my-session';
    document.getElementById('sess-dialog-type-label').textContent = T.sessTypeLabel;
    document.getElementById('sess-dialog-type').options[0].text = 'Tmux';
    document.getElementById('sess-dialog-type').options[1].text = T.sessScreen;
    document.getElementById('sess-dialog-cancel').textContent = T.sessCancel;
    document.getElementById('sess-dialog-confirm').textContent = T.sessCreate;
  `;
}

// ── Session tab-switching logic ──
function getSessionTabSwitchCode() {
  return `
    if (name === 'sess') {
      if (!sessData) vscode.postMessage({cmd:'needSessions'});
      if (sessLevel === 2 || Object.keys(sessExpanded).length > 0) startAutoRefresh();
    } else {
      stopAutoRefresh();
    }
  `;
}

module.exports = {
  getSessionCSS,
  getSessionHTML,
  getSessionTranslations,
  getSessionJS,
  handleSessionWebviewMessage,
  getSessionSetLangCalls,
  getSessionTabSwitchCode,
};
