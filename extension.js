// extension.js
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const pkg = require(path.join(__dirname, 'package.json'));
const EXTENSION_ID = `${pkg.publisher}.${pkg.name}`;

const isSSH = !!(process.env.SSH_CLIENT || process.env.SSH_CONNECTION || process.env.SSH_TTY);
const sshClientIp = (process.env.SSH_CONNECTION || '').split(/\s+/)[0] || '';
const CPU_CORES = os.cpus().length;
let prevCpu = null;
let prevNet = null;
let prevNetTime = 0;
let prevSshBytes = null;
let prevSshTime = 0;
let _log = null;
function dbg(msg) { if (_log) _log.appendLine('[' + new Date().toISOString().slice(11, 23) + '] ' + msg); }

function getCpuPercent() {
  try {
    const lines = fs.readFileSync('/proc/stat', 'utf8').split('\n');
    const p = lines[0].split(/\s+/).slice(1).map(Number);
    const idle = p[3] + (p[4] || 0);
    const total = p.reduce((a, b) => a + b, 0);
    if (!prevCpu) { prevCpu = { idle, total }; return 0; }
    const dTotal = total - prevCpu.total;
    const dIdle = idle - prevCpu.idle;
    prevCpu = { idle, total };
    return dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0;
  } catch {
    return Math.min(100, Math.round(os.loadavg()[0] / CPU_CORES * 100));
  }
}

function getMemInfo() {
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (key) => parseInt(raw.match(new RegExp(key + ':\\s+(\\d+)'))[1]) * 1024;
    const total = get('MemTotal');
    const avail = get('MemAvailable');
    const used = total - avail;
    return { total, used, avail, percent: Math.round(used / total * 100) };
  } catch {
    const total = os.totalmem(), free = os.freemem(), used = total - free;
    return { total, used, avail: free, percent: Math.round(used / total * 100) };
  }
}

function getNetSpeed() {
  try {
    const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
    let rx = 0, tx = 0;
    for (const l of lines) {
      const p = l.trim().split(/\s+/);
      if (p.length >= 10 && !p[0].startsWith('lo')) {
        rx += parseInt(p[1]) || 0;
        tx += parseInt(p[9]) || 0;
      }
    }
    if (!prevNet) { prevNet = { rx, tx }; prevNetTime = Date.now(); return { rx: 0, tx: 0 }; }
    const dtSec = (Date.now() - prevNetTime) / 1000 || 1;
    const result = { rx: (rx - prevNet.rx) / dtSec, tx: (tx - prevNet.tx) / dtSec };
    prevNet = { rx, tx };
    prevNetTime = Date.now();
    return result;
  } catch { return { rx: 0, tx: 0 }; }
}

function getAllGpus() {
  try {
    const out = execSync(
      'nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit --format=csv,noheader,nounits',
      { timeout: 3000 }
    ).toString().trim();
    return out.split('\n').filter(Boolean).map(line => {
      const [idx, name, util, memUsed, memTotal, temp, pd, pl] = line.split(', ');
      return {
        idx: parseInt(idx), name: name.trim(),
        util: parseInt(util), memUsed: parseInt(memUsed), memTotal: parseInt(memTotal),
        temp: parseInt(temp),
        power: isNaN(parseFloat(pd)) ? null : { draw: parseFloat(pd).toFixed(0), limit: parseFloat(pl).toFixed(0) },
      };
    });
  } catch { return []; }
}

function getSshTraffic() {
  if (!isSSH) return { isSSH: false };
  try {
    let totalSent = 0, totalRecv = 0;
    const filter = sshClientIp
      ? "ss -ti state established '( sport = :22 and dst " + sshClientIp + " )' 2>/dev/null"
      : "ss -ti state established '( sport = :22 )' 2>/dev/null";
    const out = execSync(filter, { timeout: 1000 }).toString();
    for (const line of out.split('\n')) {
      const sm = line.match(/bytes_sent:(\d+)/);
      const rm = line.match(/bytes_received:(\d+)/);
      if (sm) totalSent += parseInt(sm[1]);
      if (rm) totalRecv += parseInt(rm[1]);
    }
    if (!prevSshBytes) { prevSshBytes = { sent: totalSent, recv: totalRecv }; prevSshTime = Date.now(); return { isSSH: true, rx: 0, tx: 0 }; }
    const sshDt = (Date.now() - prevSshTime) / 1000 || 1;
    const result = {
      isSSH: true,
      tx: Math.max(0, (totalSent - prevSshBytes.sent) / sshDt),
      rx: Math.max(0, (totalRecv - prevSshBytes.recv) / sshDt),
    };
    prevSshBytes = { sent: totalSent, recv: totalRecv };
    prevSshTime = Date.now();
    return result;
  } catch { return { isSSH: true, rx: 0, tx: 0 }; }
}

const fmtBytes = (b) => b < 1e6 ? (b / 1024).toFixed(0) + ' KB/s' : (b / 1048576).toFixed(1) + ' MB/s';
const fmtSize = (b) => b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : (b / 1048576).toFixed(0) + ' MB';
const fmtDiskSize = (b) => b >= 1.0995116e12 ? (b / 1.0995116e12).toFixed(1) + 'T' : b >= 1073741824 ? (b / 1073741824).toFixed(1) + 'G' : b >= 1048576 ? (b / 1048576).toFixed(0) + 'M' : (b / 1024).toFixed(0) + 'K';

let _diskCache = [];
let _diskRefreshing = false;

const VIRTUAL_FS = new Set(['tmpfs', 'devtmpfs', 'sysfs', 'proc', 'efivarfs', 'squashfs', 'cgroup', 'cgroup2', 'configfs', 'debugfs', 'devpts', 'fusectl', 'hugetlbfs', 'mqueue', 'pstore', 'securityfs', 'binfmt_misc', 'autofs', 'tracefs', 'ramfs']);
const DISK_PRESET_DEFAULT = 'vfat,/proc,/sys,/run,/snap,/usr,/etc,/dev,/init';
const DISK_PRESET_MORE = '';

function parseDiskRules(rules) {
  const fsList = [], pathList = [];
  if (!rules) return { fsList, pathList };
  for (const r of rules.split(',')) {
    const t = r.trim();
    if (!t) continue;
    if (t.startsWith('/')) pathList.push(t);
    else fsList.push(t);
  }
  return { fsList, pathList };
}

function shouldExcludeDisk(fstype, mount, rules, skipVirtual) {
  if (rules === null) return false;
  if (!skipVirtual && VIRTUAL_FS.has(fstype)) return true;
  const { fsList, pathList } = typeof rules === 'object' ? rules : parseDiskRules(rules);
  if (fsList.some(f => fstype === f)) return true;
  if (pathList.some(p => mount === p || mount.startsWith(p.endsWith('/') ? p : p + '/'))) return true;
  return false;
}

function parseDfOutput(out, diskCfg) {
  const rules = normalizeMountFilter(diskCfg);
  const parsed = rules !== null ? parseDiskRules(rules) : null;
  const skipVirtual = (typeof diskCfg === 'object' && diskCfg.mountFilter === 'custom' && diskCfg.showVirtualFs);
  return out.trim().split('\n').slice(1).reduce((acc, line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 7) return acc;
    const [fs, fstype, blocks, used, , pctStr, ...mountParts] = parts;
    const mount = mountParts.join(' ');
    if (shouldExcludeDisk(fstype, mount, parsed, skipVirtual)) return acc;
    const total = parseInt(blocks) * 1024;
    if (!total) return acc;
    const usedBytes = parseInt(used) * 1024;
    const pct = parseInt(pctStr);
    acc.push({ mount, total, used: usedBytes, pct: isNaN(pct) ? 0 : pct });
    return acc;
  }, []);
}

function parseFindmntJson(jsonStr, diskCfg) {
  const rules = normalizeMountFilter(diskCfg);
  const parsed = rules !== null ? parseDiskRules(rules) : null;
  const skipVirtual = (typeof diskCfg === 'object' && diskCfg.mountFilter === 'custom' && diskCfg.showVirtualFs);
  try {
    const list = JSON.parse(jsonStr).filesystems || [];
    return list.reduce((acc, f) => {
      const fstype = f.fstype || '';
      const mount = f.target || '';
      if (shouldExcludeDisk(fstype, mount, parsed, skipVirtual)) return acc;
      const total = f.size || 0;
      if (!total) return acc;
      const usedBytes = f.used || 0;
      const pct = parseInt(f['use%']) || 0;
      acc.push({ mount, total, used: usedBytes, pct: isNaN(pct) ? 0 : pct });
      return acc;
    }, []);
  } catch { return null; }
}

function normalizeMountFilter(diskCfg) {
  const f = typeof diskCfg === 'string' ? diskCfg : (diskCfg.mountFilter || 'default');
  if (f === 'default') return DISK_PRESET_DEFAULT;
  if (f === 'more') return DISK_PRESET_MORE;
  if (f === 'all') return null;
  if (f === 'custom') {
    const parts = [];
    if (diskCfg.customFsExclude) parts.push(diskCfg.customFsExclude);
    if (diskCfg.customPathExclude) parts.push(diskCfg.customPathExclude);
    return parts.join(',') || '';
  }
  return f || DISK_PRESET_DEFAULT;
}

function refreshDiskCache(diskCfg, cb) {
  if (_diskRefreshing) return;
  if (typeof diskCfg === 'function') { cb = diskCfg; diskCfg = getConfig().diskCfg; }
  if (!diskCfg) diskCfg = getConfig().diskCfg;
  _diskRefreshing = true;
  const { exec } = require('child_process');
  exec('findmnt -l -b -o FSTYPE,SIZE,USED,USE%,TARGET --json 2>/dev/null', { timeout: 5000 }, (err, stdout) => {
    if (!err && stdout) {
      const result = parseFindmntJson(stdout, diskCfg);
      if (result) { _diskCache = result; _diskRefreshing = false; if (cb) cb(); return; }
    }
    exec('df -PT --local 2>/dev/null', { timeout: 5000 }, (err2, stdout2) => {
      _diskRefreshing = false;
      if (!err2 && stdout2) _diskCache = parseDfOutput(stdout2, diskCfg);
      if (cb) cb();
    });
  });
}

function getDiskInfo() { return _diskCache; }

function getWebviewHtml(nonce, initCfg) {
  const cfgStr = JSON.stringify(JSON.stringify(initCfg || {}));
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}' 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  :root {
    --card-bg: var(--vscode-sideBar-background, #1e1e1e);
    --border:  var(--vscode-widget-border, #3c3c3c);
    --text:    var(--vscode-foreground, #cccccc);
    --muted:   var(--vscode-descriptionForeground, #888);
    --accent:  var(--vscode-progressBar-background, #0078d4);
    --warn:    #d4a017;
    --danger:  #d44000;
    --radius:  6px;
    --gap:     10px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; scrollbar-color: var(--vscode-scrollbarSlider-background) transparent; scrollbar-width: thin; }
  html, body { height: 100%; margin: 0; overflow: hidden; }
  body { font-family: var(--vscode-font-family, sans-serif); font-size: 12px; color: var(--text); padding: 0; background: var(--card-bg); display: flex; flex-direction: column; }

  /* ── 顶部栏 ── */
  .topbar { display: flex; align-items: center; padding: 6px var(--gap); border-bottom: 1px solid var(--border); background: var(--card-bg); z-index: 10; gap: 4px; flex-wrap: wrap; row-gap: 4px; flex-shrink: 0; }
  .tb { background: transparent; color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 2px 8px; font-size: 10px; cursor: pointer; font-family: inherit; white-space: nowrap; }
  .tb:hover { border-color: var(--accent); }
  .tb.on { background: var(--accent); color: #fff; border-color: var(--accent); }
  .tb.mini { padding: 1px 5px; font-size: 9px; }
  .spacer { flex: 1; min-width: 0; }
  .topbar-info { font-size: 10px; color: var(--muted); white-space: nowrap; }
  .topbar-right { display: flex; gap: 4px; align-items: center; margin-left: auto; }

  .tab-content { padding: var(--gap); display: none; flex: 1; overflow-y: auto; min-height: 0; }
  .tab-content.active { display: block; }
  #tab-proc.active { display: flex; flex-direction: column; padding: 0; }
  #tab-proc .proc-toolbar-wrap { flex-shrink: 0; padding: var(--gap) var(--gap) 0 var(--gap); }
  #tab-proc .filter-hint { flex-shrink: 0; margin: 4px var(--gap) 0 var(--gap); }
  #tab-proc .table-scroll { flex: 1; overflow: auto; min-height: 0; }

  /* ── 模态 ── */
  .modal-mask { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 100; justify-content: center; align-items: center; }
  .modal-mask.open { display: flex; }
  .modal { background: var(--card-bg); border: 1px solid var(--border); border-radius: var(--radius); width: 90%; max-width: 360px; max-height: 80vh; overflow-y: hidden; padding: 0; display: flex; flex-direction: column; }
  .modal-title { font-size: 14px; font-weight: 600; padding: 12px 12px 8px; display: flex; align-items: center; gap: 6px; flex-shrink: 0; border-bottom: 1px solid var(--border); }
  .modal-body { flex: 1; overflow-y: auto; padding: 12px; min-height: 0; }
  .flex-1 { flex: 1; }
  .copyright { text-align: center; font-size: 9px; color: var(--muted); margin-top: 8px; opacity: .5; line-height: 1.6; }
  .copyright a { color: var(--muted); text-decoration: none; }
  .copyright a:hover { text-decoration: underline; }
  .modal-tabs { display: flex; gap: 4px; margin-bottom: 10px; }
  .modal-tab-content { display: none; }
  .modal-tab-content.active { display: block; }
  .sett-section { margin-bottom: 10px; }
  .sett-section:last-child { margin-bottom: 0; }
  .sett-label { font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 4px; text-transform: uppercase; letter-spacing: .5px; }
  .sett-row { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; flex-wrap: wrap; }
  .sett-row:last-child { margin-bottom: 0; }
  .sett-sub { margin-left: 12px; margin-top: 2px; }
  .sett-hint { font-size: 9px; color: var(--muted); margin-top: 2px; }
  .card { margin-bottom: 10px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius); position: relative; overflow: hidden; }
  .card > *:not(.spark-bg) { position: relative; z-index: 1; }
  .spark-bg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 0; }
  .card-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
  .card-label { font-size: 11px; font-weight: 600; }
  .card-value { font-size: 11px; color: var(--muted); }
  .track { height: 4px; border-radius: 2px; background: var(--border); overflow: hidden; margin-bottom: 6px; }
  .fill  { height: 100%; border-radius: 2px; background: var(--accent); transition: width .5s ease, background .5s ease; }
  .fill.warn   { background: var(--warn); }
  .fill.danger { background: var(--danger); }
  .detail-row { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); }
  .detail-row + .detail-row { margin-top: 3px; }
  .detail-row span:last-child { color: var(--text); }
  .net-ssh-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: stretch; margin-bottom: 10px; }
  .net-ssh-row > .card { flex: 1 1 140px; min-width: 0; margin-bottom: 0; }
  .net-row { display: flex; gap: 6px; }
  .net-item { flex: 1; min-width: 0; }
  .net-dir  { font-size: 10px; color: var(--muted); margin-bottom: 3px; white-space: nowrap; }
  .net-speed { font-size: 12px; font-weight: 500; white-space: nowrap; }
  .mem-inline { display: flex; gap: 12px; font-size: 11px; color: var(--muted); }
  .mem-inline span:nth-child(2) { color: var(--text); }
  .mem-inline span:nth-child(4) { color: var(--text); }
  .gpu-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
  #disk-body { container-type: inline-size; }
  .disk-item { margin-bottom: 8px; }
  .disk-item:last-child { margin-bottom: 0; }
  .disk-header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 3px; }
  .disk-mount { font-size: 11px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1 1 auto; }
  .disk-info { flex: 0 0 auto; font-size: 10px; color: var(--muted); white-space: nowrap; display: flex; align-items: baseline; gap: 6px; }
  .disk-footer { display: none; justify-content: space-between; align-items: baseline; margin-top: 2px; }
  .disk-meta { font-size: 10px; color: var(--muted); }
  .disk-pct { font-size: 10px; font-weight: 600; }
  .disk-pct.warn { color: var(--warn); }
  .disk-pct.danger { color: var(--danger); }
  @container (max-width: 200px) {
    .disk-info { display: none; }
    .disk-footer { display: flex; }
  }
  .gpu-mini { flex: 1 1 180px; min-width: 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius); position: relative; overflow: hidden; }
  .gpu-mini > *:not(.spark-bg) { position: relative; z-index: 1; }
  .gpu-na { font-size: 11px; color: var(--muted); }
  .gpu-title { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; gap: 4px; }
  .gpu-name { font-size: 11px; font-weight: 600; white-space: nowrap; flex-shrink: 0; }
  .gpu-sub { font-size: 10px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; cursor: default; direction: rtl; text-align: left; }
  .bar-label { display: flex; justify-content: space-between; font-size: 10px; color: var(--muted); margin-bottom: 2px; gap: 4px; overflow: hidden; }
  .bar-label span:first-child { flex-shrink: 0; white-space: nowrap; }
  .bar-label span:last-child { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; direction: rtl; text-align: left; }
  .gpu-stats { display: flex; gap: 12px; font-size: 11px; color: var(--muted); margin-top: 4px; overflow: hidden; }
  .gpu-stats span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .gpu-stats b { color: var(--text); font-weight: 500; }
  .gpu-link { font-size: 9px; color: var(--accent); cursor: pointer; opacity: .7; transition: opacity .15s; white-space: nowrap; }
  .gpu-link:hover { opacity: 1; text-decoration: underline; }
  .capsules { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; margin-bottom: 4px; }
  .cap { display: inline-flex; align-items: center; justify-content: center; min-width: 26px; padding: 2px 7px; border-radius: 10px; font-size: 10px; font-weight: 600; cursor: pointer; border: 1px solid var(--border); color: var(--muted); background: transparent; user-select: none; transition: all .15s; }
  .cap:hover { border-color: var(--accent); color: var(--text); }
  .cap.sel { background: var(--accent); color: #fff; border-color: var(--accent); }
  .cap.busy { opacity: .35; cursor: default; }
  .cap.busy:hover { border-color: var(--border); color: var(--muted); }
  .capsule-actions { display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap; row-gap: 4px; position: relative; }
  .action-btn { background: transparent; color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 2px 8px; font-size: 10px; cursor: pointer; font-family: inherit; white-space: nowrap; }
  .action-btn:hover { border-color: var(--accent); }
  .action-btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  .action-btn.primary:hover { opacity: .85; }
  .action-btn:disabled { opacity: .35; cursor: default; }
  .action-btn:disabled:hover { border-color: var(--border); opacity: .35; }

  /* ── 进程 tab ── */
  .proc-toolbar-wrap { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; row-gap: 4px; }
  .proc-sort-group { display: flex; gap: 3px; flex-shrink: 0; }
  .proc-sort-group .sb { background: none; border: 1px solid var(--border); border-radius: 3px; color: var(--muted); font-size: 10px; cursor: pointer; padding: 2px 6px; font-family: inherit; }
  .proc-sort-group .sb:hover { border-color: var(--accent); color: var(--text); }
  .proc-sort-group .sb.on { background: var(--accent); color: #fff; border-color: transparent; }
  .proc-count { font-size: 10px; color: var(--muted); white-space: nowrap; flex-shrink: 0; margin-left: auto; }
  .filter-wrap { position: relative; flex: 1; min-width: 80px; display: flex; }
  .proc-filter { width: 100%; background: var(--vscode-input-background, #3c3c3c); border: 1px solid var(--border); border-radius: 3px; color: var(--text); font-size: 10px; padding: 3px 20px 3px 6px; font-family: inherit; outline: none; }
  .proc-filter:focus { border-color: var(--accent); }
  .filter-clear { position: absolute; right: 3px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--muted); cursor: pointer; font-size: 12px; line-height: 1; padding: 0 2px; display: none; }
  .filter-clear:hover { color: var(--text); }
  .filter-wrap.has-text .filter-clear { display: block; }
  .filter-hint { display: none; font-size: 10px; color: var(--muted); background: var(--vscode-input-background, #2d2d2d); border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px; margin-bottom: 4px; line-height: 1.5; flex-shrink: 0; }
  .filter-hint.show { display: block; }
  .filter-hint code { background: var(--border); border-radius: 2px; padding: 0 3px; font-size: 9px; }
  .filter-hint .hint-close { float: right; cursor: pointer; color: var(--muted); margin-left: 8px; font-size: 11px; }
  .filter-hint .hint-close:hover { color: var(--text); }
  .table-scroll { overflow-x: auto; }
  table { border-collapse: collapse; min-width: 500px; width: 100%; }
  th { font-size: 10px; font-weight: 600; color: var(--muted); text-align: left; padding: 3px 4px; border-bottom: 1px solid var(--border); white-space: nowrap; position: sticky; top: 0; background: var(--card-bg); z-index: 2; }
  td { padding: 2px 4px; border-bottom: 1px solid var(--vscode-widget-border,#1e1e1e); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px; }
  td[title] { cursor: default; }
  tr:hover td { background: var(--vscode-list-hoverBackground, rgba(255,255,255,.04)); }
  .r { text-align: right; }
  .gpu-tag { font-size: 9px; background: var(--vscode-badge-background,#4d4d4d); color: var(--vscode-badge-foreground,#fff); border-radius: 3px; padding: 0 4px; white-space: nowrap; display: inline-block; margin-right: 2px; }
  .pmuted { color: var(--muted); }
  .sett-input { background: var(--vscode-input-background, #3c3c3c); border: 1px solid var(--border); border-radius: 3px; color: var(--text); font-size: 10px; padding: 2px 6px; font-family: inherit; outline: none; width: 80px; }
  .sett-input.wide { flex: 1; width: 0; min-width: 0; box-sizing: border-box; }
  .sett-input[readonly] { opacity: .5; cursor: default; }
  .tb[disabled] { opacity: .4; cursor: default; pointer-events: none; }
  .sett-input:focus { border-color: var(--accent); }
  .sett-input.err { border-color: var(--danger); }
  .sett-err { font-size: 9px; color: var(--danger); margin-top: 1px; }
  .custom-group { margin-top: 4px; margin-bottom: 8px; margin-left: 2px; padding: 4px 4px 4px 8px; box-shadow: inset 2px 0 0 var(--muted); border-radius: 0 4px 4px 0; }
  .dim { opacity: .4; }
</style>
</head>
<body>

<!-- ── 顶栏 ── -->
<div class="topbar">
  <button class="tb on" id="tab-perf-btn">性能</button>
  <button class="tb" id="tab-proc-btn">进程</button>
  <div class="spacer"></div>
  <span class="topbar-info" id="updated">--</span>
  <div class="topbar-right">
    <button class="tb on" id="pause-btn">运行中</button>
    <button class="tb on" id="settings-btn">设置</button>
  </div>
</div>

<!-- ── 设置模态 ── -->
<div class="modal-mask" id="modal-mask">
<div class="modal">
  <div class="modal-title"><span id="modal-title-text">设置</span><span class="flex-1"></span><button class="tb" id="open-vsc-settings">settings.json ↗</button><button class="tb" id="modal-close">✕</button></div>
  <div class="modal-body">
  <div class="sett-section">
    <div class="sett-label" id="sett-interval-label">刷新间隔</div>
    <div class="sett-row" id="interval-row"></div>
  </div>
  <div class="sett-section">
    <div class="sett-label" id="sett-bar-label">状态栏</div>
    <div id="sett-body"></div>
  </div>
  <div class="sett-section">
    <div class="sett-label" id="sett-disk-label">磁盘</div>
    <div id="sett-disk-body"></div>
  </div>
  <div class="sett-section">
    <div class="sett-label" id="sett-display-label">显示</div>
    <div id="sett-display-body"></div>
  </div>
  <div class="copyright">v${pkg.version} · © ${new Date().getFullYear()} Li Chenxi · ${pkg.license}<br><a href="https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor">Marketplace</a> · <a href="https://open-vsx.org/extension/LiChenxi/sysmonitor">Open VSX</a> · <a href="https://github.com/lcx-0504/sysmonitor">GitHub</a></div>
  </div>
</div>
</div>

<!-- ── 性能 tab ── -->
<div class="tab-content active" id="tab-perf">
<div class="net-ssh-row">
  <div class="card">
    <svg class="spark-bg" id="cpu-spark" viewBox="0 0 100 100" preserveAspectRatio="none"><path id="cpu-spark-area" /></svg>
    <div class="card-head"><span class="card-label">CPU</span><span class="card-value" id="cpu-val">--</span></div>
    <div class="track"><div class="fill" id="cpu-bar" style="width:0%"></div></div>
    <div class="detail-row"><span id="l-1m">1 分钟</span><span id="load-1">--</span></div>
    <div class="detail-row"><span id="l-5m">5 分钟</span><span id="load-5">--</span></div>
    <div class="detail-row"><span id="l-15m">15 分钟</span><span id="load-15">--</span></div>
  </div>
  <div class="card">
    <svg class="spark-bg" id="ram-spark" viewBox="0 0 100 100" preserveAspectRatio="none"><path id="ram-spark-area" /></svg>
    <div class="card-head"><span class="card-label">RAM</span><span class="card-value" id="mem-val">--</span></div>
    <div class="track"><div class="fill" id="mem-bar" style="width:0%"></div></div>
    <div class="detail-row"><span id="l-used">已用</span><span id="mem-used">--</span></div>
    <div class="detail-row"><span id="l-avail">可用</span><span id="mem-avail">--</span></div>
    <div class="detail-row"><span id="l-total">总计</span><span id="mem-total">--</span></div>
  </div>
</div>

<div class="card" id="disk-card" style="display:none">
  <div class="card-head"><span class="card-label" id="disk-label">Disk</span></div>
  <div id="disk-body"></div>
</div>

<div class="net-ssh-row">
  <div class="card" id="net-card">
    <svg class="spark-bg" id="net-spark" viewBox="0 0 100 100" preserveAspectRatio="none"><path id="net-spark-tx-area" /><path id="net-spark-rx-area" /></svg>
    <div class="card-head"><span class="card-label" id="net-title">网络</span></div>
    <div class="net-row">
      <div class="net-item">
        <div class="net-dir" id="net-up-label">↑ 上传</div>
        <div class="net-speed" id="net-tx">--</div>
      </div>
      <div class="net-item">
        <div class="net-dir" id="net-down-label">↓ 下载</div>
        <div class="net-speed" id="net-rx">--</div>
      </div>
    </div>
  </div>
  <div class="card" id="ssh-card" style="display:none">
    <svg class="spark-bg" id="ssh-spark" viewBox="0 0 100 100" preserveAspectRatio="none"><path id="ssh-spark-tx-area" /><path id="ssh-spark-rx-area" /></svg>
    <div class="card-head"><span class="card-label" id="ssh-label">本机 SSH</span></div>
    <div class="net-row">
      <div class="net-item">
        <div class="net-dir" id="ssh-up-label">↑ 上传</div>
        <div class="net-speed" id="ssh-tx">--</div>
      </div>
      <div class="net-item">
        <div class="net-dir" id="ssh-down-label">↓ 下载</div>
        <div class="net-speed" id="ssh-rx">--</div>
      </div>
    </div>
  </div>
</div>

<div class="card" id="free-gpu-card" style="display:none">
  <div class="card-head"><span class="card-label">GPU</span><span class="card-value" id="gpu-summary">--</span></div>
  <div class="capsules" id="gpu-capsules"></div>
  <div class="capsule-actions">
    <button class="action-btn" id="select-all-btn">全选空闲</button>
    <button class="action-btn" id="clear-btn">清除</button>
    <button class="action-btn primary" id="copy-btn" disabled>复制环境变量</button>
  </div>
</div>
<div class="gpu-grid" id="gpu-body"><span class="gpu-na">检测中…</span></div>
</div>

<!-- ── 进程 tab ── -->
<div class="tab-content" id="tab-proc">
  <div class="proc-toolbar-wrap">
    <div class="proc-sort-group" id="proc-toolbar"></div>
    <span class="proc-count" id="proc-count">--</span>
    <div class="filter-wrap" id="filter-wrap"><input class="proc-filter" id="proc-filter" placeholder="搜索进程..." /><button class="filter-clear" id="filter-clear">&times;</button></div>
  </div>
  <div class="filter-hint" id="filter-hint"></div>
  <div class="table-scroll">
    <table><thead><tr id="proc-hdr"></tr></thead><tbody id="proc-tbody"></tbody></table>
  </div>
</div>

<script nonce="${nonce}">
  var vscode = acquireVsCodeApi();
  var zh = true, T = {}, paused = false;

  function colorClass(p) { return p >= 90 ? 'danger' : p >= 70 ? 'warn' : ''; }
  function setBar(id, pct) { var e = document.getElementById(id); if(e){e.style.width=pct+'%'; e.className='fill '+colorClass(pct);} }

  function setLang(lang) {
    zh = lang && lang.startsWith('zh');
    T = zh
      ? { min:' 分钟',cores:' 核',used:'已用',avail:'可用',total:'总计',srvNet:'服务器网络',net:'网络',localSSH:'本机 SSH',up:'↑ 上传',down:'↓ 下载',selAll:'全选空闲',clear:'清除',copyEnv:'复制环境变量',detecting:'检测中…',noGpu:'未检测到 NVIDIA GPU',updAt:'更新于 ',utilLabel:'利用率',memLabel:'显存',tempLabel:'温度',pwLabel:'功耗',
          perfTab:'性能',procTab:'进程',settBtn:'设置',running:'运行中',stopped:'已暂停',enabled:'已开启',disabled:'已关闭',settTitle:'设置',interval:'刷新间隔',statusBar:'状态栏',barToggle:'显示状态栏',barAlign:'位置',barPriority:'优先级',barPriorityTip:'数字越大越靠左（左侧）或越靠右（右侧），默认 10',close:'关闭',
          netLabel:'网络速率',gpuLabel:'GPU',
          scopeOff:'关',scopeSummary:'总览',scopeCard:'指定卡',scopeMy:'我的卡',metUtil:'仅利用率',metVram:'仅显存',metBoth:'全部显示',
          netUp:'仅上传',netDown:'仅下载',netAll:'全部显示',netMerge:'合并显示',
          sshLabel:'SSH速率',gpuSummary:'GPU总览',gpuPerf:'GPU性能显示',gpuAll:'所有卡',gpuSpecify:'指定卡',gpuFirst:'前几张',gpuMetric:'GPU显示指标',gpuSkipIdle:'隐藏空闲卡',viewProcs:'查看进程',
          diskLabel:'磁盘',diskNoData:'无磁盘数据',diskFilter:'挂载过滤',diskDefault:'默认',diskMore:'更多',diskAll:'全部',diskCustom:'自定义',diskShowVirtual:'排除虚拟 FS',diskShowVirtualTip:'tmpfs, sysfs, proc, devtmpfs 等',diskExcludeFs:'排除 FS 类型',diskExcludeFsTip:'如 vfat, ntfs, fuse 等文件系统类型',diskExcludePath:'排除路径前缀',diskExcludePathTip:'如 /proc, /sys, /run 等挂载路径',diskHideParent:'仅显示叶子挂载点',diskHideParentTip:'适用于 AutoDL 等平台，过滤共享存储池，仅显示个人配额',
          displayLabel:'显示',chartsToggle:'卡片背景图表',sparkLabel:'图表时长',
          pcpu:'CPU',pmem:'内存',pgpu:'GPU',ppid:'PID',puser:'用户',pname:'进程名',pcpuPct:'CPU%',pmemCol:'内存',pgpuCol:'GPU',pcount:'共 {n} 进程',pnoGpu:'—',pcmd:'命令',filterHint:'搜索进程...' }
      : { min:' min',cores:' cores',used:'Used',avail:'Avail',total:'Total',srvNet:'Server Net',net:'Network',localSSH:'Local SSH',up:'↑ Up',down:'↓ Down',selAll:'Select All',clear:'Clear',copyEnv:'Copy Env Var',detecting:'Detecting…',noGpu:'No NVIDIA GPU detected',updAt:'Updated ',utilLabel:'Util',memLabel:'VRAM',tempLabel:'Temp',pwLabel:'Power',
          perfTab:'Perf',procTab:'Procs',settBtn:'Settings',running:'Running',stopped:'Paused',enabled:'Enabled',disabled:'Disabled',settTitle:'Settings',interval:'Refresh Interval',statusBar:'Status Bar',barToggle:'Show Status Bar',barAlign:'Position',barPriority:'Priority',barPriorityTip:'Higher = closer to the edge. Default: 10',close:'Close',
          netLabel:'Network',gpuLabel:'GPU',
          scopeOff:'Off',scopeSummary:'Summary',scopeCard:'Card',scopeMy:'My Card',metUtil:'Util Only',metVram:'VRAM Only',metBoth:'All',
          netUp:'Upload',netDown:'Download',netAll:'All',netMerge:'Merged',
          sshLabel:'SSH Traffic',gpuSummary:'GPU Summary',gpuPerf:'GPU Performance',gpuAll:'All Cards',gpuSpecify:'Specific',gpuFirst:'First N',gpuMetric:'GPU Metric',gpuSkipIdle:'Hide Idle',viewProcs:'View Procs',
          diskLabel:'Disk',diskNoData:'No disk data',diskFilter:'Mount Filter',diskDefault:'Default',diskMore:'More',diskAll:'All',diskCustom:'Custom',diskShowVirtual:'Exclude Virtual FS',diskShowVirtualTip:'tmpfs, sysfs, proc, devtmpfs, etc.',diskExcludeFs:'Exclude FS Type',diskExcludeFsTip:'e.g. vfat, ntfs, fuse',diskExcludePath:'Exclude Path Prefix',diskExcludePathTip:'e.g. /proc, /sys, /run',diskHideParent:'Leaf mounts only',diskHideParentTip:'For platforms like AutoDL: hides shared pools, shows only your quota',
          displayLabel:'Display',chartsToggle:'Card Background Charts',sparkLabel:'Chart Duration',
          pcpu:'CPU',pmem:'Memory',pgpu:'GPU',ppid:'PID',puser:'User',pname:'Process',pcpuPct:'CPU%',pmemCol:'Mem',pgpuCol:'GPU',pcount:'{n} processes',pnoGpu:'—',pcmd:'Command',filterHint:'Search...' };
    document.getElementById('l-1m').textContent = '1' + T.min;
    document.getElementById('l-5m').textContent = '5' + T.min;
    document.getElementById('l-15m').textContent = '15' + T.min;
    document.getElementById('l-used').textContent = T.used;
    document.getElementById('l-avail').textContent = T.avail;
    document.getElementById('l-total').textContent = T.total;
    document.getElementById('disk-label').textContent = T.diskLabel;
    document.getElementById('select-all-btn').textContent = T.selAll;
    document.getElementById('clear-btn').textContent = T.clear;
    document.getElementById('copy-btn').textContent = T.copyEnv;
    document.getElementById('tab-perf-btn').textContent = T.perfTab;
    document.getElementById('tab-proc-btn').textContent = T.procTab;
    document.getElementById('settings-btn').textContent = T.settBtn;
    document.getElementById('pause-btn').textContent = paused ? T.stopped : T.running;
    document.getElementById('proc-filter').placeholder = T.filterHint || '';
    renderProcToolbar();
  }
  setLang('zh');

  // ── 趋势图（时间基准）──
  var SPARK_WINDOW = 5 * 60 * 1000;
  var cpuHist = [], ramHist = [], netTxHist = [], netRxHist = [], sshTxHist = [], sshRxHist = [], gpuHist = {};

  function sparkColor(pct) {
    return pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warn)' : 'var(--accent)';
  }
  function sparkPaths(hist, maxVal) {
    if (hist.length < 2) return null;
    var now = Date.now();
    var t0 = now - SPARK_WINDOW;
    var pts = [];
    // 如果最老的点在窗口外，插值一个 x=0 的虚拟起点
    if (hist[0].t < t0 && hist.length > 1) {
      var a = hist[0], b = hist[1];
      var frac = (t0 - a.t) / (b.t - a.t);
      var v0 = a.v + (b.v - a.v) * frac;
      pts.push('0,' + (100 - Math.min(v0 / maxVal * 100, 100)).toFixed(1));
      for (var i = 1; i < hist.length; i++) {
        var x = ((hist[i].t - t0) / SPARK_WINDOW * 100).toFixed(1);
        var y = (100 - Math.min(hist[i].v / maxVal * 100, 100)).toFixed(1);
        pts.push(x + ',' + y);
      }
    } else {
      for (var i = 0; i < hist.length; i++) {
        var x = ((hist[i].t - t0) / SPARK_WINDOW * 100).toFixed(1);
        var y = (100 - Math.min(hist[i].v / maxVal * 100, 100)).toFixed(1);
        pts.push(x + ',' + y);
      }
    }
    if (pts.length < 2) return null;
    var line = 'M' + pts.join('L');
    var area = line + 'L' + pts[pts.length-1].split(',')[0] + ',100L' + pts[0].split(',')[0] + ',100Z';
    return { line: line, area: area };
  }
  function renderSpark(areaEl, lineEl, hist, maxVal, color) {
    var p = sparkPaths(hist, maxVal);
    if (!p) return;
    areaEl.setAttribute('d', p.area);
    areaEl.setAttribute('fill', color);
    areaEl.setAttribute('fill-opacity', document.body.classList.contains('vscode-dark') ? '0.12' : '0.06');
  }
  function pushHist(arr, val) {
    var now = Date.now();
    arr.push({t: now, v: val});
    var cutoff = now - SPARK_WINDOW;
    // 保留一个窗口外的锚点用于插值
    while (arr.length > 2 && arr[1].t < cutoff) arr.shift();
  }

  // ── 消息处理 ──
  window.addEventListener('message', function(evt) {
    var data = evt.data;
    if (data.cmd === 'config') {
      barCfg = data.barCfg || barCfg;
      diskCfg = data.diskCfg || diskCfg;
      displayCfg = data.displayCfg || displayCfg;
      SPARK_WINDOW = (displayCfg.sparkMinutes || 5) * 60 * 1000;
      applyCharts();
      curInterval = data.interval || curInterval;
      gpuCount = data.gpuCount || gpuCount;
      if (modalOpen) renderSettingsBody();
      return;
    }
    if (data.cmd === 'procs') {
      procData = data.data || [];
      renderProcTable();
      return;
    }
    if (data.cmd !== 'update') return;
    var d = data.payload;
    if (d.lang) setLang(d.lang);

    document.getElementById('cpu-val').textContent = d.cpu + '%';
    setBar('cpu-bar', d.cpu);
    document.getElementById('load-1').textContent = d.load1 + ' / ' + d.cpuCores + T.cores;
    document.getElementById('load-5').textContent = d.load5 + ' / ' + d.cpuCores + T.cores;
    document.getElementById('load-15').textContent = d.load15 + ' / ' + d.cpuCores + T.cores;
    pushHist(cpuHist, d.cpu);
    renderSpark(document.getElementById('cpu-spark-area'), null, cpuHist, 100, sparkColor(d.cpu));

    document.getElementById('mem-val').textContent = d.mem.percent + '%';
    setBar('mem-bar', d.mem.percent);
    document.getElementById('mem-used').textContent = d.mem.usedStr;
    document.getElementById('mem-avail').textContent = d.mem.availStr;
    document.getElementById('mem-total').textContent = d.mem.totalStr;
    pushHist(ramHist, d.mem.percent);
    renderSpark(document.getElementById('ram-spark-area'), null, ramHist, 100, sparkColor(d.mem.percent));

    renderDisk(d.disks);

    var sshCard = document.getElementById('ssh-card');
    var netTitle = document.getElementById('net-title');
    if (d.ssh && d.ssh.isSSH) {
      netTitle.textContent = T.srvNet;
      sshCard.style.display = '';
      document.getElementById('ssh-label').textContent = T.localSSH;
      document.getElementById('ssh-tx').textContent = d.ssh.txStr;
      document.getElementById('ssh-rx').textContent = d.ssh.rxStr;
      pushHist(sshTxHist, d.ssh.rx || 0);
      pushHist(sshRxHist, d.ssh.tx || 0);
      var sshMax = 1;
      sshTxHist.forEach(function(p) { if (p.v > sshMax) sshMax = p.v; });
      sshRxHist.forEach(function(p) { if (p.v > sshMax) sshMax = p.v; });
      renderSpark(document.getElementById('ssh-spark-tx-area'), null, sshTxHist, sshMax, 'var(--warn)');
      renderSpark(document.getElementById('ssh-spark-rx-area'), null, sshRxHist, sshMax, 'var(--accent)');
      document.getElementById('net-up-label').textContent = T.up;
      document.getElementById('net-down-label').textContent = T.down;
      document.getElementById('ssh-up-label').textContent = T.up;
      document.getElementById('ssh-down-label').textContent = T.down;
    } else {
      netTitle.textContent = T.net;
      sshCard.style.display = 'none';
      document.getElementById('net-up-label').textContent = T.up;
      document.getElementById('net-down-label').textContent = T.down;
    }

    var gpuBody = document.getElementById('gpu-body');
    if (d.gpus && d.gpus.length) {
      var gpuKeys = d.gpus.map(function(g) { return g.idx; });
      var gpuSame = gpuKeys.length === _gpuKeys.length && gpuKeys.every(function(k, i) { return k === _gpuKeys[i]; });
      d.gpus.forEach(function(g) {
        if (!gpuHist[g.idx]) gpuHist[g.idx] = [];
        pushHist(gpuHist[g.idx], parseInt(g.util) || 0);
      });
      if (!gpuSame) {
        _gpuKeys = gpuKeys;
        var ghtml = '';
        d.gpus.forEach(function(g) {
          var util = parseInt(g.util) || 0;
          var mu = parseInt(g.memUsed) || 0;
          var mt = parseInt(g.memTotal) || 1;
          var memPct = Math.min(100, Math.round(mu / mt * 100));
          ghtml += '<div class="gpu-mini" style="position:relative;overflow:hidden">'
            + '<svg class="spark-bg" id="gpu-spark-' + g.idx + '" viewBox="0 0 100 100" preserveAspectRatio="none"><path id="gpu-spark-area-' + g.idx + '" /></svg>'
            + '<div class="gpu-title"><span class="gpu-name">GPU ' + g.idx + '</span><span class="gpu-sub" title="' + g.name + '">' + g.name + '</span></div>'
            + '<div class="bar-label"><span>' + T.utilLabel + '</span><span id="gpu-util-text-' + g.idx + '">' + util + '% <span class="gpu-link" data-gpu-link="' + g.idx + '">&nearr; ' + T.viewProcs + '</span></span></div>'
            + '<div class="track"><div class="fill ' + colorClass(util) + '" id="gpu-util-' + g.idx + '"></div></div>'
            + '<div class="bar-label"><span>' + T.memLabel + '</span><span id="gpu-mem-text-' + g.idx + '" title="' + mu + ' / ' + mt + ' MiB (' + memPct + '%)">' + mu + ' / ' + mt + ' MiB (' + memPct + '%)</span></div>'
            + '<div class="track"><div class="fill ' + colorClass(memPct) + '" id="gpu-mem-' + g.idx + '"></div></div>'
            + '<div class="gpu-stats"><span id="gpu-temp-' + g.idx + '" title="' + T.tempLabel + ' ' + (g.temp || 0) + ' °C">' + T.tempLabel + ' <b>' + (g.temp || 0) + ' °C</b></span>' + (g.power ? '<span id="gpu-power-' + g.idx + '" title="' + T.pwLabel + ' ' + g.power.draw + '/' + g.power.limit + ' W">' + T.pwLabel + ' <b>' + g.power.draw + '/' + g.power.limit + ' W</b></span>' : '') + '</div></div>';
        });
        gpuBody.innerHTML = ghtml;
        gpuBody.querySelectorAll('.gpu-link').forEach(function(el) {
          el.addEventListener('click', function() {
            var idx = this.dataset.gpuLink;
            procSort = 'gpu';
            procFilter = 'gpu' + idx;
            filterInput.value = 'GPU' + idx;
            filterWrap.classList.add('has-text');
            switchTab('proc');
            renderProcToolbar();
            renderProcTable();
          });
        });
        requestAnimationFrame(function() {
          d.gpus.forEach(function(g) {
            var util = parseInt(g.util) || 0;
            var mu = parseInt(g.memUsed) || 0, mt = parseInt(g.memTotal) || 1;
            var memPct = Math.min(100, Math.round(mu / mt * 100));
            var ub = document.getElementById('gpu-util-' + g.idx);
            var mb = document.getElementById('gpu-mem-' + g.idx);
            if (ub) ub.style.width = util + '%';
            if (mb) mb.style.width = memPct + '%';
            var ga = document.getElementById('gpu-spark-area-' + g.idx);
            if (ga && gpuHist[g.idx]) renderSpark(ga, null, gpuHist[g.idx], 100, sparkColor(util));
          });
        });
      } else {
        d.gpus.forEach(function(g) {
          var util = parseInt(g.util) || 0;
          var mu = parseInt(g.memUsed) || 0, mt = parseInt(g.memTotal) || 1;
          var memPct = Math.min(100, Math.round(mu / mt * 100));
          var ub = document.getElementById('gpu-util-' + g.idx);
          var mb = document.getElementById('gpu-mem-' + g.idx);
          if (ub) { ub.style.width = util + '%'; ub.className = 'fill ' + colorClass(util); }
          if (mb) { mb.style.width = memPct + '%'; mb.className = 'fill ' + colorClass(memPct); }
          var ut = document.getElementById('gpu-util-text-' + g.idx);
          if (ut) { var link = ut.querySelector('.gpu-link'); ut.textContent = util + '% '; if (link) ut.appendChild(link); }
          var mt2 = document.getElementById('gpu-mem-text-' + g.idx);
          if (mt2) { mt2.textContent = mu + ' / ' + mt + ' MiB (' + memPct + '%)'; mt2.title = mu + ' / ' + mt + ' MiB (' + memPct + '%)'; }
          var te = document.getElementById('gpu-temp-' + g.idx);
          if (te) { te.innerHTML = T.tempLabel + ' <b>' + (g.temp || 0) + ' °C</b>'; te.title = T.tempLabel + ' ' + (g.temp || 0) + ' °C'; }
          var pw = document.getElementById('gpu-power-' + g.idx);
          if (pw && g.power) { pw.innerHTML = T.pwLabel + ' <b>' + g.power.draw + '/' + g.power.limit + ' W</b>'; pw.title = T.pwLabel + ' ' + g.power.draw + '/' + g.power.limit + ' W'; }
          var ga = document.getElementById('gpu-spark-area-' + g.idx);
          if (ga && gpuHist[g.idx]) renderSpark(ga, null, gpuHist[g.idx], 100, sparkColor(util));
        });
      }
    } else {
      gpuBody.innerHTML = '<span class="gpu-na">' + T.noGpu + '</span>';
    }

    document.getElementById('net-tx').textContent = d.net.txStr;
    document.getElementById('net-rx').textContent = d.net.rxStr;
    pushHist(netTxHist, d.net.tx || 0);
    pushHist(netRxHist, d.net.rx || 0);
    var netMax = 1;
    netTxHist.forEach(function(p) { if (p.v > netMax) netMax = p.v; });
    netRxHist.forEach(function(p) { if (p.v > netMax) netMax = p.v; });
    renderSpark(document.getElementById('net-spark-tx-area'), null, netTxHist, netMax, 'var(--warn)');
    renderSpark(document.getElementById('net-spark-rx-area'), null, netRxHist, netMax, 'var(--accent)');

    var freeCard = document.getElementById('free-gpu-card');
    if (d.gpus && d.gpus.length) {
      freeCard.style.display = '';
      var caps = document.getElementById('gpu-capsules');
      var freeCount = 0;
      var capsHtml = '';
      d.gpus.forEach(function(g) {
        var util = parseInt(g.util) || 0;
        var memPct = g.memTotal > 0 ? Math.round((parseInt(g.memUsed) || 0) / g.memTotal * 100) : 0;
        var isFree = util < 5 && memPct < 10;
        if (isFree) freeCount++;
        var cls = isFree ? (selectedGpus[g.idx] ? 'cap sel' : 'cap') : 'cap busy';
        capsHtml += '<button class="' + cls + '" data-idx="' + g.idx + '" data-free="' + (isFree?1:0) + '">' + g.idx + '</button>';
      });
      caps.innerHTML = capsHtml;
      document.getElementById('gpu-summary').textContent = zh
        ? freeCount + ' 空闲 / ' + d.gpus.length + ' 张'
        : freeCount + ' free / ' + d.gpus.length + ' GPUs';
      updateCopyBtn();
      lastFreeIdxs = d.gpus.filter(function(g) {
        var u = parseInt(g.util) || 0;
        var mp = g.memTotal > 0 ? Math.round((parseInt(g.memUsed) || 0) / g.memTotal * 100) : 0;
        return u < 5 && mp < 10;
      }).map(function(g){ return g.idx; });
    } else { freeCard.style.display = 'none'; }

    document.getElementById('updated').textContent = T.updAt + new Date().toLocaleTimeString();
  });

  // ── GPU 胶囊 ──
  var selectedGpus = {}, lastFreeIdxs = [];
  function updateCopyBtn() { document.getElementById('copy-btn').disabled = Object.keys(selectedGpus).length === 0; }
  document.getElementById('gpu-capsules').addEventListener('click', function(e) {
    var btn = e.target;
    if (!btn.dataset || !btn.dataset.idx || btn.dataset.free === '0') return;
    var idx = parseInt(btn.dataset.idx);
    if (selectedGpus[idx]) { delete selectedGpus[idx]; btn.classList.remove('sel'); }
    else { selectedGpus[idx] = true; btn.classList.add('sel'); }
    updateCopyBtn();
  });
  document.getElementById('select-all-btn').addEventListener('click', function() {
    lastFreeIdxs.forEach(function(i){ selectedGpus[i] = true; });
    document.querySelectorAll('.cap:not(.busy)').forEach(function(b){ b.classList.add('sel'); });
    updateCopyBtn();
  });
  document.getElementById('clear-btn').addEventListener('click', function() {
    selectedGpus = {};
    document.querySelectorAll('.cap.sel').forEach(function(b){ b.classList.remove('sel'); });
    updateCopyBtn();
  });
  document.getElementById('copy-btn').addEventListener('click', function() {
    if (this.disabled) return;
    var ids = Object.keys(selectedGpus).map(Number).sort(function(a,b){return a-b;}).join(',');
    var ta = document.createElement('textarea'); ta.value = 'CUDA_VISIBLE_DEVICES=' + ids;
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
  });

  // ── Tab 切换 ──
  function switchTab(name) {
    document.querySelectorAll('.tab-content').forEach(function(d){d.classList.remove('active');});
    document.getElementById('tab-'+name).classList.add('active');
    document.getElementById('tab-perf-btn').classList.toggle('on', name==='perf');
    document.getElementById('tab-proc-btn').classList.toggle('on', name==='proc');
    if (name === 'proc') vscode.postMessage({cmd:'needProcs'});
  }
  document.getElementById('tab-perf-btn').addEventListener('click',function(){switchTab('perf');});
  document.getElementById('tab-proc-btn').addEventListener('click',function(){switchTab('proc');});

  // ── 暂停 ──
  document.getElementById('pause-btn').addEventListener('click',function(){
    paused = !paused;
    this.textContent = paused ? T.stopped : T.running;
    this.classList.toggle('on', !paused);
    vscode.postMessage({cmd:'pause',value:paused});
  });

  // ── 设置模态 ──
  var __initCfg = JSON.parse(${cfgStr});
  var barCfg = __initCfg.barCfg || {barEnabled:true,cpu:true,ram:true,disk:false,net:'off',ssh:false,gpu:{summary:true,mode:'off',cards:[],metric:'both'}};
  var diskCfg = __initCfg.diskCfg || {mountFilter:'default',hideParentMounts:true};
  var displayCfg = __initCfg.displayCfg || {charts:true};
  var curInterval = __initCfg.interval || 2, gpuCount = __initCfg.gpuCount || 8, modalOpen = false;
  SPARK_WINDOW = (displayCfg.sparkMinutes || 5) * 60 * 1000;

  function applyCharts() {
    var vis = displayCfg.charts !== false ? '' : 'none';
    document.querySelectorAll('.spark-bg').forEach(function(el) { el.style.display = vis; });
  }

  // ── 磁盘渲染 ──
  var _diskKeys = [], _gpuKeys = [];
  function renderDisk(disks) {
    var card = document.getElementById('disk-card');
    var el = document.getElementById('disk-body');
    if (!disks || !disks.length) { card.style.display = 'none'; _diskKeys = []; return; }
    card.style.display = '';
    var keys = disks.map(function(d) { return d.mount; });
    var same = keys.length === _diskKeys.length && keys.every(function(k, i) { return k === _diskKeys[i]; });
    if (!same) {
      _diskKeys = keys;
      var h = '';
      disks.forEach(function(d, i) {
        var cls = colorClass(d.pct);
        h += '<div class="disk-item">'
          + '<div class="disk-header"><span class="disk-mount" title="' + d.mount + '">' + d.mount + '</span>'
          + '<span class="disk-info"><span class="disk-meta" id="disk-meta-' + i + '">' + d.usedStr + ' / ' + d.totalStr + '</span><span class="disk-pct ' + cls + '" id="disk-pct-' + i + '">' + d.pct + '%</span></span></div>'
          + '<div class="track"><div class="fill ' + cls + '" id="disk-fill-' + i + '"></div></div>'
          + '<div class="disk-footer"><span class="disk-meta" id="disk-fmeta-' + i + '">' + d.usedStr + ' / ' + d.totalStr + '</span><span class="disk-pct ' + cls + '" id="disk-fpct-' + i + '">' + d.pct + '%</span></div>'
          + '</div>';
      });
      el.innerHTML = h;
      requestAnimationFrame(function() {
        disks.forEach(function(d, i) {
          var fill = document.getElementById('disk-fill-' + i);
          if (fill) fill.style.width = d.pct + '%';
        });
      });
    } else {
      disks.forEach(function(d, i) {
        var cls = colorClass(d.pct);
        var fill = document.getElementById('disk-fill-' + i);
        if (fill) { fill.style.width = d.pct + '%'; fill.className = 'fill ' + cls; }
        var meta = document.getElementById('disk-meta-' + i);
        if (meta) meta.textContent = d.usedStr + ' / ' + d.totalStr;
        var pct = document.getElementById('disk-pct-' + i);
        if (pct) { pct.textContent = d.pct + '%'; pct.className = 'disk-pct ' + cls; }
        var fmeta = document.getElementById('disk-fmeta-' + i);
        if (fmeta) fmeta.textContent = d.usedStr + ' / ' + d.totalStr;
        var fpct = document.getElementById('disk-fpct-' + i);
        if (fpct) { fpct.textContent = d.pct + '%'; fpct.className = 'disk-pct ' + cls; }
      });
    }
  }

  function openModal() {
    modalOpen = true;
    document.getElementById('modal-mask').classList.add('open');
    document.getElementById('modal-title-text').textContent = T.settTitle;
    document.getElementById('sett-interval-label').textContent = T.interval;
    document.getElementById('sett-bar-label').textContent = T.statusBar;
    document.getElementById('sett-disk-label').textContent = T.diskLabel;
    document.getElementById('sett-display-label').textContent = T.displayLabel;
    renderIntervalRow();
    renderSettingsBody();
  }
  function closeModal() { modalOpen = false; document.getElementById('modal-mask').classList.remove('open'); }
  document.getElementById('settings-btn').addEventListener('click', openModal);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-mask').addEventListener('click', function(e){ if (e.target===this) closeModal(); });
  document.getElementById('open-vsc-settings').addEventListener('click', function(){ vscode.postMessage({cmd:'openSettings'}); });
  document.addEventListener('click', function(e) {
    var a = e.target.closest('a[href]');
    if (a && a.href) { e.preventDefault(); vscode.postMessage({cmd:'openLink', url:a.href}); }
  });

  function renderIntervalRow() {
    var row = document.getElementById('interval-row');
    row.innerHTML = '';
    [1,2,5,10].forEach(function(s) {
      var b = document.createElement('button');
      b.className = 'tb' + (curInterval===s?' on':'');
      b.textContent = s+(zh?'秒':'s');
      b.addEventListener('click', function(){ curInterval=s; renderIntervalRow(); vscode.postMessage({cmd:'setConfig',key:'refreshInterval',value:s}); });
      row.appendChild(b);
    });
  }

  function getCfg() { return barCfg; }
  var _pushTimer = null;
  function pushCfg() {
    if (_pushTimer) clearTimeout(_pushTimer);
    _pushTimer = setTimeout(function() {
      _pushTimer = null;
      vscode.postMessage({cmd:'setConfig',key:'statusBar',value:barCfg});
    }, 300);
  }

  function renderSettingsBody() {
    var cfg = getCfg();
    var gpu = cfg.gpu || {};
    var body = document.getElementById('sett-body');
    var h = '';
    function row(label, content) { return '<div class="sett-row"><span style="font-size:10px;color:var(--muted);min-width:60px">'+label+'</span>'+content+'</div>'; }
    function toggle(key, label) {
      return '<button class="tb'+(cfg[key]?' on':'')+'" data-act="bool" data-key="'+key+'">'+label+'</button>';
    }
    function radio(key, val, label) {
      return '<button class="tb'+(cfg[key]===val?' on':'')+'" data-act="radio" data-key="'+key+'" data-val="'+val+'">'+label+'</button>';
    }

    var barOn = cfg.barEnabled !== false;
    h += row(T.barToggle, '<button class="tb'+(barOn?' on':'')+'" data-act="bar-toggle">'+(barOn?T.enabled:T.disabled)+'</button>');
    if (!barOn) { body.innerHTML = h; bindSettingsEvents(body, cfg); return; }
    var curAlign = cfg.alignment || 'left';
    h += row(T.barAlign, '<button class="tb'+(curAlign==='left'?' on':'')+'" data-act="radio" data-key="alignment" data-val="left">'+(zh?'左':'Left')+'</button><button class="tb'+(curAlign==='right'?' on':'')+'" data-act="radio" data-key="alignment" data-val="right">'+(zh?'右':'Right')+'</button>');
    var curPri = typeof cfg.priority === 'number' ? cfg.priority : 10;
    h += row(T.barPriority+' <span title="'+T.barPriorityTip+'" style="cursor:help">ⓘ</span>', '<input class="sett-input" id="bar-priority-input" type="number" min="0" max="10000" value="'+curPri+'" style="width:60px" />');
    h += row('CPU', toggle('cpu', cfg.cpu ? T.enabled : T.disabled));
    h += row('RAM', toggle('ram', cfg.ram ? T.enabled : T.disabled));
    h += row(T.diskLabel, toggle('disk', cfg.disk ? T.enabled : T.disabled));
    h += row(T.netLabel, radio('net','off',T.scopeOff)+radio('net','up',T.netUp)+radio('net','down',T.netDown)+radio('net','both',T.netAll)+radio('net','combined',T.netMerge));
    h += row(T.sshLabel, toggle('ssh', cfg.ssh ? T.enabled : T.disabled));
    h += row(T.gpuSummary, '<button class="tb'+(gpu.summary?' on':'')+'" data-act="gpu-summary">'+(gpu.summary?T.enabled:T.disabled)+'</button>');

    var gpuMode = gpu.mode || 'off';
    h += row(T.gpuPerf,
      '<button class="tb'+(gpuMode==='off'?' on':'')+'" data-act="gpu-mode" data-val="off">'+T.scopeOff+'</button>'
      +'<button class="tb'+(gpuMode==='all'?' on':'')+'" data-act="gpu-mode" data-val="all">'+T.gpuAll+'</button>'
      +'<button class="tb'+(gpuMode==='first'?' on':'')+'" data-act="gpu-mode" data-val="first">'+T.gpuFirst+'</button>'
      +'<button class="tb'+(gpuMode==='specify'?' on':'')+'" data-act="gpu-mode" data-val="specify">'+T.gpuSpecify+'</button>'
      +'<button class="tb'+(gpuMode==='my'?' on':'')+'" data-act="gpu-mode" data-val="my">'+T.scopeMy+'</button>');

    if (gpuMode === 'first') {
      var fv = gpu.firstN || 2;
      h += '<div class="sett-row" style="margin-left:60px"><input class="sett-input" id="gpu-first-input" type="number" min="1" max="'+gpuCount+'" value="'+fv+'" style="width:50px" /><span style="font-size:10px;color:var(--muted);margin-left:4px">'+(zh?'张':'cards')+'</span></div>';
    }

    if (gpuMode === 'specify') {
      var val = (gpu.cards||[]).join(',');
      h += '<div class="sett-row" style="margin-left:60px"><input class="sett-input" id="gpu-cards-input" value="'+val+'" placeholder="0,1,3" /><span class="sett-err" id="gpu-cards-err"></span></div>';
    }

    if (gpuMode !== 'off') {
      var met = gpu.metric || 'both';
      h += row(T.gpuMetric,
        '<button class="tb'+(met==='util'?' on':'')+'" data-act="gpu-metric" data-val="util">'+T.metUtil+'</button>'
        +'<button class="tb'+(met==='vram'?' on':'')+'" data-act="gpu-metric" data-val="vram">'+T.metVram+'</button>'
        +'<button class="tb'+(met==='both'?' on':'')+'" data-act="gpu-metric" data-val="both">'+T.metBoth+'</button>');
      h += row(T.gpuSkipIdle, '<button class="tb'+(gpu.skipIdle?' on':'')+'" data-act="gpu-skip-idle">'+(gpu.skipIdle?T.enabled:T.disabled)+'</button>');
    }

    body.innerHTML = h;
    bindSettingsEvents(body, cfg);

    var diskBody = document.getElementById('sett-disk-body');
    var curFilter = diskCfg.mountFilter || 'default';
    var dh = '<div class="sett-row"><span style="font-size:10px;color:var(--muted);min-width:60px">' + T.diskFilter + '</span>';
    dh += '<button class="tb' + (curFilter==='default'?' on':'') + '" data-act="disk-filter" data-val="default">' + T.diskDefault + '</button>';
    dh += '<button class="tb' + (curFilter==='more'?' on':'') + '" data-act="disk-filter" data-val="more">' + T.diskMore + '</button>';
    dh += '<button class="tb' + (curFilter==='all'?' on':'') + '" data-act="disk-filter" data-val="all">' + T.diskAll + '</button>';
    dh += '<button class="tb' + (curFilter==='custom'?' on':'') + '" data-act="disk-filter" data-val="custom">' + T.diskCustom + '</button></div>';
    var isCustom = curFilter === 'custom';
    var presetVals = {default:{fs:'vfat',paths:'/proc,/sys,/run,/snap,/usr,/etc,/dev,/init',vfs:false},more:{fs:'',paths:'',vfs:false},all:{fs:'',paths:'',vfs:true}};
    var showFs, showPaths, showVfs;
    if (isCustom) {
      showFs = diskCfg.customFsExclude || '';
      showPaths = diskCfg.customPathExclude || '';
      showVfs = diskCfg.showVirtualFs;
    } else {
      var pv = presetVals[curFilter] || presetVals['default'];
      showFs = pv.fs; showPaths = pv.paths; showVfs = pv.vfs;
    }
    var dis = isCustom ? '' : ' disabled';
    dh += '<div class="custom-group' + (isCustom ? '' : ' dim') + '">';
    dh += '<div class="sett-row"><span style="font-size:9px;color:var(--muted);min-width:70px" title="' + T.diskShowVirtualTip + '">' + T.diskShowVirtual + ' ⓘ</span>';
    dh += '<button class="tb' + (!showVfs ? ' on' : '') + '"' + dis + ' data-act="disk-show-virtual">' + (!showVfs ? T.enabled : T.disabled) + '</button></div>';
    dh += '<div class="sett-row" style="margin-top:2px"><span style="font-size:9px;color:var(--muted);min-width:70px" title="' + T.diskExcludeFsTip + '">' + T.diskExcludeFs + ' ⓘ</span>';
    dh += '<input class="sett-input wide" id="disk-fs-input" type="text" value="' + showFs.replace(/"/g,'&quot;') + '"' + (isCustom ? ' placeholder="vfat,ntfs"' : '') + (isCustom ? '' : ' readonly') + ' /></div>';
    dh += '<div class="sett-row" style="margin-top:2px"><span style="font-size:9px;color:var(--muted);min-width:70px" title="' + T.diskExcludePathTip + '">' + T.diskExcludePath + ' ⓘ</span>';
    dh += '<input class="sett-input wide" id="disk-path-input" type="text" value="' + showPaths.replace(/"/g,'&quot;') + '"' + (isCustom ? ' placeholder="/proc,/sys,/run"' : '') + (isCustom ? '' : ' readonly') + ' /></div>';
    dh += '</div>';
    dh += '<div class="sett-row" style="margin-top:6px"><span style="font-size:10px;color:var(--muted);min-width:60px" title="' + T.diskHideParentTip + '">' + T.diskHideParent + ' ⓘ</span>';
    dh += '<button class="tb' + (diskCfg.hideParentMounts !== false ? ' on' : '') + '" data-act="disk-hide-parent">' + (diskCfg.hideParentMounts !== false ? T.enabled : T.disabled) + '</button></div>';
    diskBody.innerHTML = dh;
    void diskBody.offsetHeight;
    diskBody.querySelectorAll('[data-act="disk-filter"]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var val = this.dataset.val;
        if (val === 'custom' && curFilter !== 'custom') {
          diskCfg.customFsExclude = showFs;
          diskCfg.customPathExclude = showPaths;
          diskCfg.showVirtualFs = showVfs;
        }
        diskCfg.mountFilter = val;
        vscode.postMessage({cmd:'setConfig',key:'disk',value:diskCfg});
        renderSettingsBody();
      });
    });
    if (curFilter === 'custom') {
      var vfsBtn = diskBody.querySelector('[data-act="disk-show-virtual"]');
      if (vfsBtn) vfsBtn.addEventListener('click', function() {
        diskCfg.showVirtualFs = !diskCfg.showVirtualFs;
        vscode.postMessage({cmd:'setConfig',key:'disk',value:diskCfg});
        renderSettingsBody();
      });
      var _diskTimer = null;
      function onDiskCustomInput() {
        if (_diskTimer) clearTimeout(_diskTimer);
        _diskTimer = setTimeout(function() {
          var fsInput = document.getElementById('disk-fs-input');
          var pathInput = document.getElementById('disk-path-input');
          if (fsInput) diskCfg.customFsExclude = fsInput.value;
          if (pathInput) diskCfg.customPathExclude = pathInput.value;
          vscode.postMessage({cmd:'setConfig',key:'disk',value:diskCfg});
        }, 600);
      }
      var fsInput = document.getElementById('disk-fs-input');
      var pathInput = document.getElementById('disk-path-input');
      if (fsInput) fsInput.addEventListener('input', onDiskCustomInput);
      if (pathInput) pathInput.addEventListener('input', onDiskCustomInput);
    }
    var hideParentBtn = diskBody.querySelector('[data-act="disk-hide-parent"]');
    if (hideParentBtn) hideParentBtn.addEventListener('click', function() {
      diskCfg.hideParentMounts = !diskCfg.hideParentMounts;
      vscode.postMessage({cmd:'setConfig',key:'disk',value:diskCfg});
      renderSettingsBody();
    });

    var dispBody = document.getElementById('sett-display-body');
    var dph = '<div class="sett-row"><span style="font-size:10px;color:var(--muted);min-width:60px">' + T.chartsToggle + '</span>';
    dph += '<button class="tb' + (displayCfg.charts !== false ? ' on' : '') + '" data-act="charts-toggle">' + (displayCfg.charts !== false ? T.enabled : T.disabled) + '</button></div>';
    dph += '<div class="sett-row"><span style="font-size:10px;color:var(--muted);min-width:60px">' + T.sparkLabel + '</span>';
    [1,2,5,10,30].forEach(function(m) {
      var cur = displayCfg.sparkMinutes || 5;
      dph += '<button class="tb' + (cur===m?' on':'') + '" data-act="spark-min" data-val="' + m + '">' + m + (zh?'分':'m') + '</button>';
    });
    dph += '</div>';
    dispBody.innerHTML = dph;
    dispBody.querySelector('[data-act="charts-toggle"]').addEventListener('click', function() {
      displayCfg.charts = !displayCfg.charts;
      vscode.postMessage({cmd:'setConfig',key:'display',value:displayCfg});
      applyCharts();
      renderSettingsBody();
    });
    dispBody.querySelectorAll('[data-act="spark-min"]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        displayCfg.sparkMinutes = parseInt(this.dataset.val);
        SPARK_WINDOW = displayCfg.sparkMinutes * 60 * 1000;
        vscode.postMessage({cmd:'setConfig',key:'display',value:displayCfg});
        renderSettingsBody();
      });
    });
  }

  function bindSettingsEvents(body, cfg) {
    var priInput = document.getElementById('bar-priority-input');
    if (priInput) {
      priInput.addEventListener('input', function() {
        var n = parseInt(this.value);
        if (isNaN(n) || n < 0) n = 10;
        cfg.priority = n;
        pushCfg();
      });
    }
    var cardsInput = document.getElementById('gpu-cards-input');
    if (cardsInput) {
      cardsInput.addEventListener('input', function() {
        var raw = this.value.trim();
        var errEl = document.getElementById('gpu-cards-err');
        if (!raw) { cfg.gpu.cards = []; errEl.textContent = ''; pushCfg(); return; }
        var parts = raw.split(',');
        var valid = true, nums = [];
        parts.forEach(function(s) {
          var n = parseInt(s.trim());
          if (isNaN(n) || n < 0) valid = false;
          else nums.push(n);
        });
        if (!valid) { errEl.textContent = zh?'格式错误，请用逗号分隔数字':'Invalid format'; this.classList.add('err'); return; }
        this.classList.remove('err');
        var badCards = nums.filter(function(n){ return n >= gpuCount; });
        errEl.textContent = badCards.length ? (zh?'卡 '+badCards.join(',')+' 不存在，将不显示':'Card '+badCards.join(',')+' not found') : '';
        cfg.gpu.cards = nums.filter(function(n){ return n < gpuCount; });
        cfg.gpu.cards.sort(function(a,b){return a-b;});
        pushCfg();
      });
    }

    var firstInput = document.getElementById('gpu-first-input');
    if (firstInput) {
      firstInput.addEventListener('input', function() {
        var n = parseInt(this.value);
        if (isNaN(n) || n < 1) n = 1;
        if (n > gpuCount) n = gpuCount;
        cfg.gpu.firstN = n;
        pushCfg();
      });
    }

    body.querySelectorAll('[data-act]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var a = this.dataset.act;
        if (a==='bool') { cfg[this.dataset.key] = !cfg[this.dataset.key]; }
        else if (a==='radio') { cfg[this.dataset.key] = this.dataset.val; }
        else if (a==='gpu-summary') { cfg.gpu.summary = !cfg.gpu.summary; }
        else if (a==='gpu-mode') {
          cfg.gpu.mode = this.dataset.val;
        }
        else if (a==='gpu-metric') { cfg.gpu.metric = this.dataset.val; }
        else if (a==='gpu-skip-idle') { cfg.gpu.skipIdle = !cfg.gpu.skipIdle; }
        else if (a==='bar-toggle') { cfg.barEnabled = !(cfg.barEnabled !== false); }
        pushCfg();
        renderSettingsBody();
      });
    });
  }

  // ── 进程 tab 逻辑 ──
  var procSort = 'cpu', procData = [], procFilter = '';
  function renderProcToolbar() {
    var tb = document.getElementById('proc-toolbar');
    if(!tb) return;
    tb.innerHTML = '<button class="sb'+(procSort==='cpu'?' on':'')+'" data-s="cpu">CPU</button>'
      +'<button class="sb'+(procSort==='mem'?' on':'')+'" data-s="mem">RAM</button>'
      +'<button class="sb'+(procSort==='gpu'?' on':'')+'" data-s="gpu">GPU</button>';
    tb.querySelectorAll('.sb').forEach(function(b){
      b.addEventListener('click',function(){procSort=this.dataset.s;renderProcToolbar();renderProcTable();});
    });
  }
  var filterInput = document.getElementById('proc-filter');
  var filterWrap = document.getElementById('filter-wrap');
  filterInput.addEventListener('input',function(){
    procFilter = this.value.toLowerCase();
    filterWrap.classList.toggle('has-text', this.value.length > 0);
    renderProcTable();
  });
  var _state = vscode.getState() || {};
  var hintDismissed = !!_state.hintDismissed;
  var hintShown = false;
  filterInput.addEventListener('focus', function() {
    if (hintDismissed || hintShown) return;
    hintShown = true;
    var hint = document.getElementById('filter-hint');
    var hintText = zh
      ? '<span class="hint-close" id="hint-close">&times;</span>支持搜索进程名、用户名、PID、命令行。GPU 搜索：<code>GPU0</code> <code>#0</code> <code>GPU 0</code>'
      : '<span class="hint-close" id="hint-close">&times;</span>Search by name, user, PID, command. GPU: <code>GPU0</code> <code>#0</code> <code>GPU 0</code>';
    hint.innerHTML = hintText;
    hint.classList.add('show');
    document.getElementById('hint-close').addEventListener('click', function() {
      hint.classList.remove('show');
      hintDismissed = true;
      vscode.setState(Object.assign(_state, { hintDismissed: true }));
    });
  });
  document.getElementById('filter-clear').addEventListener('click',function(){
    filterInput.value = '';
    procFilter = '';
    filterWrap.classList.remove('has-text');
    renderProcTable();
    filterInput.focus();
  });
  function fmtPMem(b){return b>=1073741824?(b/1073741824).toFixed(1)+' G':b>=1048576?(b/1048576).toFixed(0)+' M':(b/1024).toFixed(0)+' K';}
  function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  function procSearchStr(p) {
    var s = p.name.toLowerCase() + ' ' + p.user.toLowerCase() + ' ' + (p.cmd||'').toLowerCase() + ' ' + p.pid;
    if (p.gpus && p.gpus.length) {
      p.gpus.forEach(function(g){ s += ' gpu'+g.idx + ' gpu '+g.idx + ' #'+g.idx; });
    }
    return s;
  }
  function renderProcTable(){
    var filtered = procData;
    if (procFilter) {
      filtered = procData.filter(function(p){
        return procSearchStr(p).indexOf(procFilter) >= 0;
      });
    }
    var sorted = filtered.slice();
    if(procSort==='cpu') sorted.sort(function(a,b){return b.cpu-a.cpu;});
    else if(procSort==='mem') sorted.sort(function(a,b){return b.mem-a.mem;});
    else sorted.sort(function(a,b){return (b.vram||0)-(a.vram||0);});
    sorted = sorted.slice(0,80);
    document.getElementById('proc-count').textContent = (filtered.length < procData.length)
      ? T.pcount.replace('{n}', filtered.length + '/' + procData.length)
      : T.pcount.replace('{n}', procData.length);
    document.getElementById('proc-hdr').innerHTML =
      '<th>PID</th><th>'+T.pname+'</th><th>'+T.puser+'</th><th class="r">CPU%</th><th class="r">RAM</th><th class="r">RAM%</th><th>GPU</th><th>'+T.pcmd+'</th>';
    var html = '';
    sorted.forEach(function(p){
      var gpuCell = '';
      if (p.gpus && p.gpus.length) {
        var tags = p.gpus.map(function(g){return '<span class="gpu-tag">#'+g.idx+' '+g.vram+'M</span>';}).join(' ');
        gpuCell = tags;
      } else {
        gpuCell = '<span class="pmuted">'+T.pnoGpu+'</span>';
      }
      var cmdShort = p.cmd && p.cmd.length > 50 ? p.cmd.substring(0,50)+'…' : (p.cmd||p.name);
      var cpuTxt = p.cpu.toFixed(1);
      html+='<tr>'
        +'<td class="r">'+p.pid+'</td>'
        +'<td title="PID '+p.pid+'&#10;'+esc(p.cmd||p.name)+'">'+esc(p.name)+'</td>'
        +'<td>'+esc(p.user)+'</td>'
        +'<td class="r">'+cpuTxt+'</td>'
        +'<td class="r">'+fmtPMem(p.mem)+'</td>'
        +'<td class="r">'+p.memPct+'%</td>'
        +'<td>'+gpuCell+'</td>'
        +'<td title="'+esc(p.cmd||'')+'">'+esc(cmdShort)+'</td>'
        +'</tr>';
    });
    document.getElementById('proc-tbody').innerHTML = html;
  }
  renderProcToolbar();

</script>
</body>
</html>`;
}

// ── 统一配置缓存层 ──────────────────────────────────────────────────────────
const CFG_DEFAULTS = {
  interval: 2,
  barCfg: { barEnabled: true, alignment: 'left', priority: 10, cpu: true, ram: false, net: 'off', ssh: false, gpu: { summary: true, mode: 'off', cards: [], metric: 'both' } },
  diskCfg: { mountFilter: 'default', hideParentMounts: true },
  displayCfg: { charts: true, sparkMinutes: 5 },
};
const CFG_KEY_MAP = { interval: 'refreshInterval', barCfg: 'statusBar', diskCfg: 'disk', displayCfg: 'display' };
let _cfgCache = null;
let _selfWriting = false;
let _dirtyKeys = new Set();
let _flushTimer = null;

function _readSettingsOnce() {
  const c = vscode.workspace.getConfiguration('sysmonitor');
  return {
    interval: c.get('refreshInterval', CFG_DEFAULTS.interval),
    barCfg: c.get('statusBar') || CFG_DEFAULTS.barCfg,
    diskCfg: c.get('disk') || CFG_DEFAULTS.diskCfg,
    displayCfg: c.get('display') || CFG_DEFAULTS.displayCfg,
  };
}

function initConfig() { _cfgCache = _readSettingsOnce(); }

function getConfig() {
  if (!_cfgCache) initConfig();
  return _cfgCache;
}

function setConfigValue(key, value) {
  if (!_cfgCache) initConfig();
  _cfgCache[key] = value;
  _dirtyKeys.add(key);
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(_flushConfig, 500);
}

function _flushConfig() {
  _flushTimer = null;
  if (_dirtyKeys.size === 0) return;
  _selfWriting = true;
  const c = vscode.workspace.getConfiguration('sysmonitor');
  const ps = [];
  for (const key of _dirtyKeys) ps.push(c.update(CFG_KEY_MAP[key], _cfgCache[key], true));
  _dirtyKeys.clear();
  Promise.all(ps).then(() => { setTimeout(() => { _selfWriting = false; }, 200); });
}

function refreshConfigFromSettings() {
  _cfgCache = _readSettingsOnce();
}

function getMyGpuIndices() {
  try {
    const user = os.userInfo().username;
    const out = execSync('nvidia-smi --query-compute-apps=pid,gpu_uuid --format=csv,noheader', { timeout: 3000 }).toString().trim();
    if (!out) return [];
    const uuidSet = new Set();
    for (const line of out.split('\n').filter(Boolean)) {
      const parts = line.split(', ');
      const pid = parts[0].trim();
      try {
        const status = fs.readFileSync('/proc/' + pid + '/status', 'utf8');
        const m = status.match(/Uid:\s+(\d+)/);
        if (m && parseInt(m[1]) === process.getuid()) uuidSet.add(parts[1].trim());
      } catch { }
    }
    if (uuidSet.size === 0) return [];
    const uuidOut = execSync('nvidia-smi --query-gpu=index,gpu_uuid --format=csv,noheader', { timeout: 3000 }).toString().trim();
    const indices = [];
    for (const line of uuidOut.split('\n').filter(Boolean)) {
      const parts = line.split(', ');
      if (uuidSet.has(parts[1].trim())) indices.push(parseInt(parts[0]));
    }
    return indices;
  } catch { return []; }
}

// ── 进程数据采集 ─────────────────────────────────────────────────────────────
function getProcessData() {
  const totalMem = os.totalmem();
  const procs = [];
  try {
    const psOut = execSync('ps -eo pid,user,%cpu,rss,args --sort=-%cpu --no-headers | head -100', { timeout: 3000 }).toString();
    for (const line of psOut.trim().split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
      if (m) {
        const cpu = parseFloat(m[3]) || 0;
        const rss = parseInt(m[4]) * 1024;
        if (rss > 1e6 || cpu > 0) {
          const args = m[5].trim();
          const name = args.split(/\s+/)[0].split('/').pop();
          procs.push({ pid: parseInt(m[1]), user: m[2], cpu, mem: rss, memPct: totalMem > 0 ? +(rss / totalMem * 100).toFixed(1) : 0, name, cmd: args });
        }
      }
    }
  } catch { }
  try {
    const gpuOut = execSync('nvidia-smi --query-compute-apps=pid,gpu_uuid,used_memory --format=csv,noheader,nounits', { timeout: 3000 }).toString().trim();
    if (gpuOut) {
      const uuidToIdx = {};
      try {
        const idxOut = execSync('nvidia-smi --query-gpu=index,gpu_uuid --format=csv,noheader', { timeout: 2000 }).toString().trim();
        for (const line of idxOut.split('\n').filter(Boolean)) {
          const [idx, uuid] = line.split(', ');
          uuidToIdx[uuid.trim()] = parseInt(idx);
        }
      } catch { }
      const gpuMap = {};
      for (const line of gpuOut.split('\n').filter(Boolean)) {
        const parts = line.split(', ');
        const pid = parseInt(parts[0]);
        const uuid = (parts[1] || '').trim();
        const vram = parseInt(parts[2]) || 0;
        if (pid) {
          if (!gpuMap[pid]) gpuMap[pid] = [];
          gpuMap[pid].push({ idx: uuidToIdx[uuid] !== undefined ? uuidToIdx[uuid] : -1, vram });
        }
      }
      for (const p of procs) {
        if (gpuMap[p.pid]) {
          p.gpus = gpuMap[p.pid];
          p.vram = gpuMap[p.pid].reduce((s, g) => s + g.vram, 0);
        }
      }
    }
  } catch { }
  return procs;
}

class MonitorViewProvider {
  constructor(ctx) { this._view = null; this._ctx = ctx; this._interval = 2000; this._paused = false; }

  resolveWebviewView(view) {
    this._view = view;
    view.webview.options = { enableScripts: true };
    const nonce = Math.random().toString(36).slice(2, 18);
    const cfg = getConfig();
    const gpus = getAllGpus();
    view.webview.html = getWebviewHtml(nonce, { interval: cfg.interval, barCfg: cfg.barCfg, diskCfg: cfg.diskCfg, displayCfg: cfg.displayCfg, gpuCount: gpus.length || 8 });

    view.webview.onDidReceiveMessage(msg => {
      if (msg.cmd === 'getConfig') {
        this._pushConfig();
      } else if (msg.cmd === 'setConfig') {
        if (msg.key === 'refreshInterval') {
          dbg('setConfig refreshInterval: ' + msg.value);
          setConfigValue('interval', msg.value);
          this._resetTimer(msg.value * 1000);
          updateBar();
        } else if (msg.key === 'statusBar') {
          setConfigValue('barCfg', msg.value);
          updateBar();
        } else if (msg.key === 'disk') {
          setConfigValue('diskCfg', msg.value);
          refreshDiskCache(msg.value, () => { if (this._tick) this._tick(); });
        } else if (msg.key === 'display') {
          setConfigValue('displayCfg', msg.value);
        }
      } else if (msg.cmd === 'openSettings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'sysmonitor');
      } else if (msg.cmd === 'openLink') {
        if (msg.url && /^https?:\/\//.test(msg.url)) {
          vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
      } else if (msg.cmd === 'pause') {
        this._paused = !!msg.value;
      } else if (msg.cmd === 'needProcs') {
        this._pushProcs();
      }
    });

    const tick = () => {
      if (!this._view || this._paused) return;
      const _t0 = Date.now();
      const cpu = getCpuPercent();
      const mem = getMemInfo();
      const net = getNetSpeed();
      const gpus = getAllGpus();
      const ssh = getSshTraffic();
      const loads = os.loadavg();
      const lang = vscode.env.language;
      const netData = { rx: net.rx, tx: net.tx, rxStr: fmtBytes(net.rx), txStr: fmtBytes(net.tx) };
      const diskCfg = getConfig().diskCfg;
      let disks = getDiskInfo().map(d => ({ mount: d.mount, usedStr: fmtDiskSize(d.used), totalStr: fmtDiskSize(d.total), pct: d.pct }));
      if (diskCfg.hideParentMounts !== false) {
        const mounts = disks.map(d => d.mount);
        disks = disks.filter(d => d.mount === '/' || !mounts.some(m => m !== d.mount && m.startsWith(d.mount + '/')));
      }
      const payload = {
        lang, cpu, cpuCores: CPU_CORES,
        load1: loads[0].toFixed(2), load5: loads[1].toFixed(2), load15: loads[2].toFixed(2),
        mem: { percent: mem.percent, usedStr: fmtSize(mem.used), availStr: fmtSize(mem.avail), totalStr: fmtSize(mem.total) },
        gpus,
        net: netData,
        ssh: ssh.isSSH ? { isSSH: true, tx: ssh.tx, rx: ssh.rx, txStr: fmtBytes(ssh.rx), rxStr: fmtBytes(ssh.tx) } : { isSSH: false },
        disks,
      };
      this._view.webview.postMessage({ cmd: 'update', payload });
      latestData = { cpu, mem: { percent: mem.percent }, net: netData, ssh: payload.ssh, gpus, diskRoot: disks.find(d => d.mount === '/') };
      updateBar();
      const elapsed = Date.now() - _t0;
      if (elapsed > 500) dbg('slow tick: ' + elapsed + 'ms  interval=' + this._interval);
    };
    this._tick = tick;

    this._interval = cfg.interval * 1000;
    // 首次同步加载磁盘数据（findmnt 优先，可发现 Docker bind mount；回退到 df）
    try {
      const fmOut = execSync('findmnt -l -b -o FSTYPE,SIZE,USED,USE%,TARGET --json 2>/dev/null', { timeout: 3000 }).toString();
      const r = parseFindmntJson(fmOut, cfg.diskCfg);
      if (r) _diskCache = r; else throw 0;
    } catch { try { _diskCache = parseDfOutput(execSync('df -PT --local 2>/dev/null', { timeout: 3000 }).toString(), cfg.diskCfg); } catch { } }
    tick();
    this._timer = setInterval(tick, this._interval);
    this._diskTimer = setInterval(() => { refreshDiskCache(getConfig().diskCfg); }, 10000);

    this._procsTimer = setInterval(() => { this._pushProcs(); }, 5000);

    view.onDidDispose(() => {
      clearInterval(this._timer);
      clearInterval(this._diskTimer);
      clearInterval(this._procsTimer);
      this._view = null;
    });
  }

  _resetTimer(ms) {
    dbg('_resetTimer: ' + ms + 'ms (was ' + this._interval + 'ms)');
    this._interval = ms;
    clearInterval(this._timer);
    this._timer = setInterval(this._tick, ms);
  }

  _pushProcs() {
    if (!this._view || this._paused) return;
    const data = getProcessData();
    this._view.webview.postMessage({ cmd: 'procs', data });
  }

  _pushConfig() {
    if (!this._view) return;
    const cfg = getConfig();
    const gpus = getAllGpus();
    this._view.webview.postMessage({
      cmd: 'config', interval: cfg.interval, barCfg: cfg.barCfg, diskCfg: cfg.diskCfg, displayCfg: cfg.displayCfg,
      gpuCount: gpus.length || 8,
    });
  }
}

let latestData = {};
let barRef = null;

function formatBarText(cfg, data) {
  if (cfg.barEnabled === false) return '';
  const parts = [];
  if (cfg.cpu && data.cpu !== undefined) parts.push('$(dashboard) ' + data.cpu + '%');
  if (cfg.ram && data.mem) parts.push('$(server) ' + data.mem.percent + '%');
  if (cfg.disk && data.diskRoot) parts.push('$(database) ' + data.diskRoot.pct + '%');
  if (cfg.net && cfg.net !== 'off' && data.net) {
    let netTxt = '';
    if (cfg.net === 'up') netTxt = '↑' + data.net.txStr;
    else if (cfg.net === 'down') netTxt = '↓' + data.net.rxStr;
    else if (cfg.net === 'combined') netTxt = '↕' + data.net.txStr;
    else if (cfg.net === 'both') netTxt = '↑' + data.net.txStr + ' ↓' + data.net.rxStr;
    if (cfg.ssh && data.ssh && data.ssh.isSSH) {
      netTxt += ' (SSH ↑' + data.ssh.txStr + ' ↓' + data.ssh.rxStr + ')';
    }
    parts.push(netTxt);
  } else if (cfg.ssh && data.ssh && data.ssh.isSSH) {
    parts.push('SSH ↑' + data.ssh.txStr + ' ↓' + data.ssh.rxStr);
  }
  if (cfg.gpu && data.gpus && data.gpus.length) {
    const gpu = cfg.gpu;
    const metric = gpu.metric || 'both';
    if (gpu.summary) {
      let free = 0;
      data.gpus.forEach(g => {
        const u = parseInt(g.util) || 0;
        const mp = g.memTotal > 0 ? Math.round((parseInt(g.memUsed) || 0) / g.memTotal * 100) : 0;
        if (u < 5 && mp < 10) free++;
      });
      parts.push('$(circuit-board) ' + free + '/' + data.gpus.length);
    }
    const mode = gpu.mode || 'off';
    if (mode !== 'off') {
      let detailIndices = [];
      if (mode === 'all') { data.gpus.forEach(g => detailIndices.push(g.idx)); }
      else if (mode === 'first') { const n = gpu.firstN || 2; for (let i = 0; i < Math.min(n, data.gpus.length); i++) detailIndices.push(data.gpus[i].idx); }
      else if (mode === 'specify' && gpu.cards && gpu.cards.length) { detailIndices = gpu.cards.slice(); }
      else if (mode === 'my') { detailIndices = getMyGpuIndices(); }
      detailIndices.sort((a, b) => a - b);
      const gpuParts = [];
      detailIndices.forEach(idx => {
        const g = data.gpus.find(x => x.idx === idx);
        if (!g) return;
        const u = parseInt(g.util) || 0;
        const mu = parseInt(g.memUsed) || 0;
        const mt = parseInt(g.memTotal) || 1;
        const mp = Math.round(mu / mt * 100);
        if (gpu.skipIdle && u < 5 && mp < 10) return;
        if (metric === 'util') gpuParts.push('#' + idx + ' ' + u + '%');
        else if (metric === 'vram') gpuParts.push('#' + idx + ' ' + mp + '%V');
        else gpuParts.push('#' + idx + ' ' + u + '%/' + mp + '%V');
      });
      if (gpuParts.length) parts.push('$(circuit-board) ' + gpuParts.join(' '));
    }
  }
  return parts.length > 0 ? parts.join('  ') : '$(pulse) Monitor';
}

function updateBar() {
  if (!barRef) return;
  const cfg = getConfig().barCfg;
  const txt = formatBarText(cfg, latestData);
  if (txt) { barRef.text = txt; barRef.show(); }
  else { barRef.hide(); }
}

function activate(context) {
  _log = vscode.window.createOutputChannel('System Monitor');
  context.subscriptions.push(_log);
  dbg('activate');
  const lang = vscode.env.language || '';
  const zh = lang.startsWith('zh');

  if (!vscode.env.remoteName) {
    const dismissed = context.globalState.get('sysmonitor.notifyDismissed', false);
    const sshCfg = vscode.workspace.getConfiguration('remote.SSH');
    const defaultExts = (sshCfg.get('defaultExtensions') || []).map(s => s.toLowerCase());
    const alreadyAdded = defaultExts.includes(EXTENSION_ID.toLowerCase());

    if (!dismissed && !alreadyAdded) {
      const autoBtn = zh ? '一键加入 SSH 默认扩展' : 'Add to SSH default extensions';
      const dismissBtn = zh ? '不再提醒' : "Don't remind me";
      vscode.window.showInformationMessage(
        zh
          ? 'System Monitor 仅在远程 Linux 环境中运行。使用 Remote-SSH 时，可将扩展 ID 写入设置以自动安装到服务器。'
          : 'System Monitor only runs on remote Linux. For Remote-SSH, you can auto-install it on servers.',
        autoBtn, dismissBtn
      ).then(choice => {
        if (choice === autoBtn) {
          const c = vscode.workspace.getConfiguration('remote.SSH');
          const list = (c.get('defaultExtensions') || []).slice();
          if (!list.includes(EXTENSION_ID)) {
            list.push(EXTENSION_ID);
            c.update('defaultExtensions', list, true).then(() => {
              context.globalState.update('sysmonitor.notifyDismissed', true);
              vscode.window.showInformationMessage(zh
                ? '已添加 ' + EXTENSION_ID + ' 到 SSH 默认扩展。'
                : 'Added ' + EXTENSION_ID + ' to SSH default extensions.');
            });
          }
        } else if (choice === dismissBtn) {
          context.globalState.update('sysmonitor.notifyDismissed', true);
        }
      });
    } else if (!dismissed && alreadyAdded) {
      context.globalState.update('sysmonitor.notifyDismissed', true);
      vscode.window.showInformationMessage(zh
        ? '✅ System Monitor 已在 SSH 默认扩展列表中，下次连接 Linux 服务器时将自动安装。'
        : '✅ System Monitor is already in your SSH default extensions and will auto-install on Linux servers.');
    }
    context.subscriptions.push(
      vscode.commands.registerCommand('sysmonitor.openPanel', () => {
        vscode.window.showInformationMessage(zh
          ? '请先打开远程文件夹或 WSL（侧边栏图标仅在远程窗口显示）。'
          : 'Open a remote folder or WSL first (activity bar icon only appears in remote windows).');
      })
    );
    return;
  }

  if (process.platform !== 'linux') {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('sysmonitor.panel', {
        resolveWebviewView(view) {
          const nonce = Math.random().toString(36).slice(2, 18);
          const title = zh ? '仅支持 Linux 远程' : 'Linux remote only';
          const body = zh
            ? '当前远程环境不是 Linux（' + process.platform + '），本扩展无法采集系统指标。请在 Linux 服务器、WSL2（Linux 发行版）或 Linux 容器中使用。'
            : 'This remote is not Linux (' + process.platform + '). System Monitor only supports Linux. Use a Linux server, WSL2 distro, or Linux container.';
          view.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:16px;font-size:12px;line-height:1.6}h3{margin:0 0 10px;font-size:13px}p{color:var(--vscode-descriptionForeground);margin:0}</style></head><body>
<h3>${title}</h3><p>${body}</p></body></html>`;
        }
      })
    );
    context.subscriptions.push(
      vscode.commands.registerCommand('sysmonitor.openPanel', () => {
        vscode.commands.executeCommand('workbench.view.extension.sysmonitor-container');
      })
    );
    return;
  }

  const provider = new MonitorViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('sysmonitor.panel', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const initCfg = getConfig().barCfg;
  const initAlign = initCfg.alignment === 'right' ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left;
  const initPri = typeof initCfg.priority === 'number' ? initCfg.priority : 10;
  let bar = vscode.window.createStatusBarItem(initAlign, initPri);
  bar.command = 'sysmonitor.openPanel';
  bar.tooltip = 'System Monitor (Remote)';
  barRef = bar;
  if (initCfg.barEnabled !== false) bar.show();
  context.subscriptions.push(bar);

  function recreateBar() {
    const cfg = getConfig().barCfg;
    const align = cfg.alignment === 'right' ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left;
    const pri = typeof cfg.priority === 'number' ? cfg.priority : 10;
    if (bar.alignment === align && bar.priority === pri) return;
    bar.dispose();
    bar = vscode.window.createStatusBarItem(align, pri);
    bar.command = 'sysmonitor.openPanel';
    bar.tooltip = 'System Monitor (Remote)';
    barRef = bar;
    context.subscriptions.push(bar);
    updateBar();
  }

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('sysmonitor')) {
      dbg('onDidChangeConfiguration: selfWriting=' + _selfWriting);
      if (!_selfWriting) {
        refreshConfigFromSettings();
        if (provider._view) provider._pushConfig();
      }
      recreateBar();
      updateBar();
      const newInt = getConfig().interval * 1000;
      dbg('  config interval check: newInt=' + newInt + '  provider._interval=' + provider._interval);
      if (provider._interval !== newInt) {
        provider._resetTimer(newInt);
      }
    }
  }));

  context.subscriptions.push(
    vscode.commands.registerCommand('sysmonitor.openPanel', () => {
      vscode.commands.executeCommand('workbench.view.extension.sysmonitor-container');
    })
  );
}

function deactivate() { }
module.exports = { activate, deactivate };
