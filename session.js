// session.js — Session tab data collection & message handling
const { execSync, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');

// ── module-level dependencies (injected via setup) ──────────────────────────
let _dbg = () => {};
let _getConfig = null;
let _screenAvailable = null;
let _tmuxAvailable = null;

function setup(dbgFn, getConfigFn) {
  _dbg = dbgFn || _dbg;
  _getConfig = getConfigFn || _getConfig;
}

// ── tool detection ─────────────────────────────────────────────────────────
function checkSessionTools() {
  if (_screenAvailable === null) {
    try { execSync('which screen 2>/dev/null', { timeout: 2000 }); _screenAvailable = true; } catch { _screenAvailable = false; }
  }
  if (_tmuxAvailable === null) {
    try { execSync('which tmux 2>/dev/null', { timeout: 2000 }); _tmuxAvailable = true; } catch { _tmuxAvailable = false; }
  }
  return { screen: _screenAvailable, tmux: _tmuxAvailable };
}

// ── date formatting ────────────────────────────────────────────────────────
function formatScreenDate(dateStr) {
  try {
    let d = new Date(dateStr);
    if (isNaN(d.getTime())) {
      const m = dateStr.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2})[时:：](\d{1,2})(?:[分:：](\d{1,2}))?/);
      if (m) d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]), parseInt(m[4]), parseInt(m[5]), parseInt(m[6]) || 0);
    }
    if (isNaN(d.getTime())) return dateStr;
    const y = d.getFullYear(), mo = String(d.getMonth() + 1).padStart(2, '0'), da = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0'), mi = String(d.getMinutes()).padStart(2, '0');
    return y + '/' + mo + '/' + da + ' ' + h + ':' + mi;
  } catch { return dateStr; }
}

function formatTmuxDate(ts) {
  const d = new Date(ts * 1000);
  const y = d.getFullYear(), mo = String(d.getMonth() + 1).padStart(2, '0'), da = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0'), mi = String(d.getMinutes()).padStart(2, '0');
  return y + '/' + mo + '/' + da + ' ' + h + ':' + mi;
}

// ── screen sessions ────────────────────────────────────────────────────────
function getScreenSessions(cb) {
  execFile('screen', ['-ls'], { timeout: 5000 }, (err, stdout) => {
    if (err) { cb([]); return; }
    const lines = (stdout || '').split('\n');
    const sessions = [];
    const re = /^\s+(\d+\.\S+)\s+\(([^)]+)\)\s+\((\w+)\)/;
    for (const line of lines) {
      const m = line.match(re);
      if (m) sessions.push({ id: m[1], name: m[1], type: 'screen', created: formatScreenDate(m[2]), status: m[3], windowCount: 0 });
    }
    if (sessions.length === 0) { cb([]); return; }
    let pending = sessions.length;
    for (const s of sessions) {
      execFile('screen', ['-S', s.name, '-Q', 'number'], { timeout: 3000 }, (e2, out2) => {
        if (!e2 && out2) s.windowCount = parseInt(out2.trim()) || 0;
        if (--pending === 0) cb(sessions);
      });
    }
  });
}

function getScreenWindows(sessionName, cb) {
  execFile('screen', ['-S', sessionName, '-Q', 'windows'], { timeout: 5000 }, (err, stdout) => {
    if (!err && stdout) {
      const wins = [];
      const re = /(\d+)([*\$]?)\s+(\S+)/g;
      let m;
      while ((m = re.exec(stdout)) !== null) wins.push({ index: parseInt(m[1]), name: m[3], active: m[2] === '*' });
      if (wins.length) { cb(wins); return; }
    }
    execFile('screen', ['-S', sessionName, '-Q', 'number'], { timeout: 3000 }, (err2, numOut) => {
      const n = (!err2 && numOut) ? parseInt(numOut.trim()) : 0;
      if (n <= 0) { cb([{ index: 0, name: 'window', active: true }]); return; }
      const wins = []; let pending = n;
      for (let i = 0; i < n; i++) {
        execFile('screen', ['-S', sessionName, '-p', String(i), '-Q', 'title'], { timeout: 3000 }, (e3, titleOut) => {
          const title = (!e3 && titleOut) ? titleOut.trim() || ('window ' + i) : ('window ' + i);
          wins.push({ index: i, name: title, active: i === (n - 1) });
          if (--pending === 0) { wins.sort((a, b) => a.index - b.index); cb(wins); }
        });
      }
    });
  });
}

function getScreenHardcopy(sessionName, windowIndex, cb, maxLines) {
  const n = maxLines || (_getConfig ? _getConfig().terminalLines : 20) || 20;
  const mktmp = () => os.tmpdir() + '/sysmonitor_screen_hc_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);
  const readFile = (f) => { try { return fs.readFileSync(f, 'utf-8'); } catch { return ''; } };
  const strategies = [
    { args: ['-S', sessionName, '-p', String(windowIndex), '-X', 'hardcopy'], label: 'hardcopy -p' },
    { args: ['-S', sessionName, '-p', String(windowIndex), '-X', 'hardcopyh'], label: 'hardcopyh -p' },
    { args: ['-S', sessionName, '-X', 'hardcopy', '-p', String(windowIndex)], label: 'hardcopy reordered' },
  ];
  let idx = 0;
  function next() {
    if (idx >= strategies.length) {
      _dbg('getScreenHardcopy: all strategies failed for ' + sessionName + ':' + windowIndex);
      cb('');
      return;
    }
    const s = strategies[idx++];
    const tmpFile = mktmp();
    execFile('screen', s.args.concat(tmpFile), { timeout: 5000 }, () => {
      const c = readFile(tmpFile);
      try { fs.unlinkSync(tmpFile); } catch {}
      if (c) { cb(truncateTerminal(c, n)); return; }
      next();
    });
  }
  next();
}

// ── tmux sessions ──────────────────────────────────────────────────────────
function getTmuxSessions(cb) {
  execFile('tmux', ['list-sessions', '-F', '#{session_name}:#{session_windows}:#{session_created}:#{session_attached}'], { timeout: 5000 }, (err, stdout) => {
    if (err) { cb([]); return; }
    const sessions = [];
    for (const line of (stdout || '').trim().split('\n')) {
      if (!line) continue;
      const parts = line.split(':');
      if (parts.length >= 4) {
        const ts = parseInt(parts[2]) || 0;
        sessions.push({
          id: parts[0], name: parts[0], type: 'tmux',
          windowCount: parseInt(parts[1]) || 0,
          created: ts ? formatTmuxDate(ts) : '',
          status: parts[3] === '1' ? 'Attached' : 'Detached'
        });
      }
    }
    cb(sessions);
  });
}

function getTmuxWindows(sessionName, cb) {
  execFile('tmux', ['list-windows', '-t', sessionName, '-F', '#{window_index}:#{window_name}:#{window_active}:#{pane_current_command}'], { timeout: 5000 }, (err, stdout) => {
    if (err) { cb(null); return; }
    const wins = [];
    for (const line of (stdout || '').trim().split('\n')) {
      if (!line) continue;
      const parts = line.split(':');
      if (parts.length >= 4) {
        wins.push({ index: parseInt(parts[0]), name: parts[1], active: parts[2] === '1', command: parts.slice(3).join(':') });
      }
    }
    cb(wins);
  });
}

function getTmuxCapture(sessionName, windowIndex, cb, maxLines) {
  const n = maxLines || (_getConfig ? _getConfig().terminalLines : 20) || 20;
  const scrollback = Math.max(n, 500);
  const targets = [
    { target: sessionName + ':' + windowIndex + '.0', scroll: true },
    { target: sessionName + ':' + windowIndex, scroll: true },
    { target: sessionName + ':' + windowIndex + '.0', scroll: false },
    { target: sessionName + ':' + windowIndex, scroll: false },
  ];
  let idx = 0;
  function next() {
    if (idx >= targets.length) {
      _dbg('getTmuxCapture: all strategies failed for ' + sessionName + ':' + windowIndex);
      cb('');
      return;
    }
    const t = targets[idx++];
    const args = ['capture-pane', '-t', t.target, '-p'];
    if (t.scroll) args.push('-S', '-' + scrollback);
    execFile('tmux', args, { timeout: 5000 }, (err, stdout) => {
      if (err) {
        if (idx < targets.length) _dbg('getTmuxCapture: ' + t.target + ' failed, trying next');
        next();
        return;
      }
      const raw = stdout || '';
      if (!raw) { next(); return; }
      cb(truncateTerminal(raw, n));
    });
  }
  next();
}

// ── generic helpers ────────────────────────────────────────────────────────
function truncateTerminal(content, maxLines) {
  maxLines = maxLines || (_getConfig ? _getConfig().terminalLines : 20) || 2000;
  const lines = content.split('\n');
  if (lines.length <= maxLines) return content;
  return lines.slice(-maxLines).join('\n');
}

// ── composite collectors ───────────────────────────────────────────────────
function collectSessions(cb) {
  const tools = checkSessionTools();
  if (!tools.screen && !tools.tmux) { cb({ sessions: [], tools }); return; }
  let all = [], pending = 0;
  const done = () => { if (--pending === 0) cb({ sessions: all, tools }); };
  if (tools.screen) { pending++; getScreenSessions(list => { all = all.concat(list); done(); }); }
  if (tools.tmux) { pending++; getTmuxSessions(list => { all = all.concat(list); done(); }); }
}

function collectWindows(sessionType, sessionName, cb) {
  const handler = (wins) => cb({ windows: wins || [], sessionName, sessionType });
  if (sessionType === 'tmux') getTmuxWindows(sessionName, handler);
  else getScreenWindows(sessionName, handler);
}

function collectTerminalOutput(sessionType, sessionName, windowIndex, cb, maxLines) {
  const handler = (content) => cb({ content, sessionName, windowIndex, sessionType });
  if (sessionType === 'tmux') getTmuxCapture(sessionName, windowIndex, handler, maxLines);
  else getScreenHardcopy(sessionName, windowIndex, handler, maxLines);
}

// ── session message handler (called by MonitorViewProvider) ────────────────
function handleSessionMessage(msg, provider) {
  const vscode = require('vscode');

  if (msg.cmd === 'needSessions') {
    if (!provider._view) return;
    collectSessions((data) => {
      if (provider._view) provider._view.webview.postMessage({ cmd: 'sessions', data });
    });
  } else if (msg.cmd === 'needSessionWindows') {
    if (!provider._view) return;
    collectWindows(msg.sessionType, msg.sessionName, (data) => {
      if (provider._view) provider._view.webview.postMessage({ cmd: 'sessionWindows', data });
    });
  } else if (msg.cmd === 'needTerminalOutput') {
    if (!provider._view) return;
    const maxLines = (_getConfig ? _getConfig().terminalLines : 20) || 20;
    collectTerminalOutput(msg.sessionType, msg.sessionName, msg.windowIndex, (data) => {
      if (provider._view) provider._view.webview.postMessage({ cmd: 'terminalOutput', data });
    }, maxLines);
  } else if (msg.cmd === 'needTerminalPreview') {
    if (!provider._view) return;
    const previewLines = 3;
    const tryCapture = (winIdx, fallback) => {
      collectTerminalOutput(msg.sessionType, msg.sessionName, winIdx, (data) => {
        if (!provider._view) return;
        if (data.content) {
          provider._view.webview.postMessage({ cmd: 'terminalPreview', data: { sessionName: msg.sessionName, content: data.content, windowIndex: winIdx } });
        } else if (fallback) {
          fallback();
        } else {
          provider._view.webview.postMessage({ cmd: 'terminalPreview', data: { sessionName: msg.sessionName, content: '', windowIndex: winIdx } });
        }
      }, previewLines);
    };
    tryCapture(0, () => {
      const getWindows = msg.sessionType === 'tmux' ? getTmuxWindows : getScreenWindows;
      getWindows(msg.sessionName, (wins) => {
        if (!provider._view) return;
        if (wins && wins.length) {
          const activeWin = wins.find(w => w.active) || wins[0];
          tryCapture(activeWin.index, null);
        } else {
          provider._view.webview.postMessage({ cmd: 'terminalPreview', data: { sessionName: msg.sessionName, content: '', windowIndex: 0 } });
        }
      });
    });
  } else if (msg.cmd === 'openSessionTerminal') {
    const name = msg.sessionName.replace(/'/g, '\'\\\'\'');
    const shellCmd = msg.sessionType === 'tmux'
      ? 'tmux attach-session -t \'' + name + '\''
      : 'screen -x \'' + name + '\'';
    const term = vscode.window.createTerminal({ name: msg.sessionName, shellPath: '/bin/sh', shellArgs: ['-c', shellCmd + '; exec $SHELL'] });
    term.show();
  } else if (msg.cmd === 'createSession') {
    const bin = msg.sessionType === 'tmux' ? 'tmux' : 'screen';
    const args = msg.sessionType === 'tmux'
      ? ['new-session', '-d', '-s', msg.sessionName]
      : ['-S', msg.sessionName, '-d', '-m'];
    _dbg('createSession: ' + bin + ' ' + args.join(' '));
    execFile(bin, args, { timeout: 8000 }, (err) => {
      if (err) _dbg('createSession failed: ' + (err.message || err));
      if (provider._view) {
        collectSessions((data) => {
          if (provider._view) provider._view.webview.postMessage({ cmd: 'sessions', data });
        });
      }
    });
  } else if (msg.cmd === 'killSession') {
    const args = msg.sessionType === 'tmux'
      ? ['kill-session', '-t', msg.sessionName]
      : ['-S', msg.sessionName, '-X', 'quit'];
    const bin = msg.sessionType === 'tmux' ? 'tmux' : 'screen';
    execFile(bin, args, { timeout: 5000 }, () => {
      if (provider._view) {
        collectSessions((data) => {
          if (provider._view) provider._view.webview.postMessage({ cmd: 'sessions', data });
        });
      }
    });
  } else {
    return false; // not handled
  }
  return true;
}

// ── convenience: pushConfig session fields ─────────────────────────────────
function getSessionConfigFields() {
  const cfg = _getConfig ? _getConfig() : {};
  return {
    terminalLines: cfg.terminalLines != null ? cfg.terminalLines : 20,
    sessionAutoRefresh: cfg.sessionAutoRefresh != null ? cfg.sessionAutoRefresh : 3,
  };
}

module.exports = {
  setup,
  checkSessionTools,
  collectSessions,
  collectWindows,
  collectTerminalOutput,
  handleSessionMessage,
  getSessionConfigFields,
};
