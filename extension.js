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
let prevCpu = null;
let prevNet = null;
let prevSshBytes = null;

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
    return Math.min(100, Math.round(os.loadavg()[0] / os.cpus().length * 100));
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
    if (!prevNet) { prevNet = { rx, tx }; return { rx: 0, tx: 0 }; }
    const result = { rx: (rx - prevNet.rx) / 2, tx: (tx - prevNet.tx) / 2 };
    prevNet = { rx, tx };
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
    if (!prevSshBytes) { prevSshBytes = { sent: totalSent, recv: totalRecv }; return { isSSH: true, rx: 0, tx: 0 }; }
    const result = {
      isSSH: true,
      tx: Math.max(0, (totalSent - prevSshBytes.sent) / 2),
      rx: Math.max(0, (totalRecv - prevSshBytes.recv) / 2),
    };
    prevSshBytes = { sent: totalSent, recv: totalRecv };
    return result;
  } catch { return { isSSH: true, rx: 0, tx: 0 }; }
}

const fmtBytes = (b) => b < 1e6 ? (b / 1024).toFixed(0) + ' KB/s' : (b / 1048576).toFixed(1) + ' MB/s';
const fmtSize = (b) => b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : (b / 1048576).toFixed(0) + ' MB';

function getWebviewHtml(nonce) {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
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
  .modal { background: var(--card-bg); border: 1px solid var(--border); border-radius: var(--radius); width: 90%; max-width: 360px; max-height: 80vh; overflow-y: auto; padding: 12px; }
  .modal-title { font-size: 12px; font-weight: 600; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
  .modal-close { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 16px; line-height: 1; padding: 0 2px; }
  .modal-close:hover { color: var(--text); }
  .modal-tabs { display: flex; gap: 4px; margin-bottom: 10px; }
  .modal-tab-content { display: none; }
  .modal-tab-content.active { display: block; }
  .sett-section { margin-bottom: 10px; }
  .sett-section:last-child { margin-bottom: 0; }
  .sett-label { font-size: 10px; font-weight: 600; color: var(--muted); margin-bottom: 4px; text-transform: uppercase; letter-spacing: .5px; }
  .sett-row { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; flex-wrap: wrap; }
  .sett-row:last-child { margin-bottom: 0; }
  .sett-sub { margin-left: 12px; margin-top: 2px; }
  .sett-hint { font-size: 9px; color: var(--muted); margin-top: 2px; }
  .card { margin-bottom: 10px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius); }
  .card-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
  .card-label { font-size: 11px; font-weight: 600; }
  .card-value { font-size: 11px; color: var(--muted); }
  .track { height: 4px; border-radius: 2px; background: var(--border); overflow: hidden; margin-bottom: 6px; }
  .fill  { height: 100%; border-radius: 2px; background: var(--accent); transition: width .5s ease; }
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
  .gpu-mini { flex: 1 1 180px; min-width: 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius); }
  .gpu-na { font-size: 11px; color: var(--muted); }
  .gpu-title { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; gap: 4px; }
  .gpu-name { font-size: 11px; font-weight: 600; white-space: nowrap; flex-shrink: 0; }
  .gpu-sub { font-size: 10px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .bar-label { display: flex; justify-content: space-between; font-size: 10px; color: var(--muted); margin-bottom: 2px; }
  .bar-label span:last-child { color: var(--text); }
  .gpu-stats { display: flex; gap: 12px; font-size: 11px; color: var(--muted); margin-top: 4px; }
  .gpu-stats span { white-space: nowrap; }
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
  .sett-input:focus { border-color: var(--accent); }
  .sett-input.err { border-color: var(--danger); }
  .sett-err { font-size: 9px; color: var(--danger); margin-top: 1px; }
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
  <div class="modal-title"><span id="modal-title-text">设置</span><span style="flex:1"></span><button class="tb" id="open-vsc-settings" style="font-size:9px">settings.json ↗</button><button class="modal-close" id="modal-close">&times;</button></div>
  <div class="sett-section">
    <div class="sett-label" id="sett-interval-label">刷新间隔</div>
    <div class="sett-row" id="interval-row"></div>
  </div>
  <div class="sett-section">
    <div class="sett-label" id="sett-bar-label">状态栏</div>
    <div id="sett-body"></div>
  </div>
</div>
</div>

<!-- ── 性能 tab ── -->
<div class="tab-content active" id="tab-perf">
<div class="net-ssh-row">
  <div class="card">
    <div class="card-head"><span class="card-label">CPU</span><span class="card-value" id="cpu-val">--</span></div>
    <div class="track"><div class="fill" id="cpu-bar" style="width:0%"></div></div>
    <div class="detail-row"><span id="l-1m">1 分钟</span><span id="load-1">--</span></div>
    <div class="detail-row"><span id="l-5m">5 分钟</span><span id="load-5">--</span></div>
    <div class="detail-row"><span id="l-15m">15 分钟</span><span id="load-15">--</span></div>
  </div>
  <div class="card">
    <div class="card-head"><span class="card-label">RAM</span><span class="card-value" id="mem-val">--</span></div>
    <div class="track"><div class="fill" id="mem-bar" style="width:0%"></div></div>
    <div class="detail-row"><span id="l-used">已用</span><span id="mem-used">--</span></div>
    <div class="detail-row"><span id="l-avail">可用</span><span id="mem-avail">--</span></div>
    <div class="detail-row"><span id="l-total">总计</span><span id="mem-total">--</span></div>
  </div>
</div>

<div class="net-ssh-row">
  <div class="card" id="net-card">
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
          perfTab:'性能',procTab:'进程',settBtn:'设置',running:'运行中',stopped:'已暂停',enabled:'已开启',disabled:'已关闭',settTitle:'设置',interval:'刷新间隔',statusBar:'状态栏',barToggle:'显示状态栏',close:'关闭',
          netLabel:'网络速率',gpuLabel:'GPU',
          scopeOff:'关',scopeSummary:'总览',scopeCard:'指定卡',scopeMy:'我的卡',metUtil:'仅利用率',metVram:'仅显存',metBoth:'全部显示',
          netUp:'仅上传',netDown:'仅下载',netAll:'全部显示',netMerge:'合并显示',
          sshLabel:'SSH速率',gpuSummary:'GPU总览',gpuPerf:'GPU性能显示',gpuAll:'所有卡',gpuSpecify:'指定卡',gpuFirst:'前几张',gpuMetric:'GPU显示指标',gpuSkipIdle:'隐藏空闲卡',viewProcs:'查看进程',
          pcpu:'CPU',pmem:'内存',pgpu:'GPU',ppid:'PID',puser:'用户',pname:'进程名',pcpuPct:'CPU%',pmemCol:'内存',pgpuCol:'GPU',pcount:'共 {n} 进程',pnoGpu:'—',pcmd:'命令',filterHint:'搜索进程...' }
      : { min:' min',cores:' cores',used:'Used',avail:'Avail',total:'Total',srvNet:'Server Net',net:'Network',localSSH:'Local SSH',up:'↑ Up',down:'↓ Down',selAll:'Select All',clear:'Clear',copyEnv:'Copy Env Var',detecting:'Detecting…',noGpu:'No NVIDIA GPU detected',updAt:'Updated ',utilLabel:'Util',memLabel:'VRAM',tempLabel:'Temp',pwLabel:'Power',
          perfTab:'Perf',procTab:'Procs',settBtn:'Settings',running:'Running',stopped:'Paused',enabled:'Enabled',disabled:'Disabled',settTitle:'Settings',interval:'Refresh Interval',statusBar:'Status Bar',barToggle:'Show Status Bar',close:'Close',
          netLabel:'Network',gpuLabel:'GPU',
          scopeOff:'Off',scopeSummary:'Summary',scopeCard:'Card',scopeMy:'My Card',metUtil:'Util Only',metVram:'VRAM Only',metBoth:'All',
          netUp:'Upload',netDown:'Download',netAll:'All',netMerge:'Merged',
          sshLabel:'SSH Traffic',gpuSummary:'GPU Summary',gpuPerf:'GPU Performance',gpuAll:'All Cards',gpuSpecify:'Specific',gpuFirst:'First N',gpuMetric:'GPU Metric',gpuSkipIdle:'Hide Idle',viewProcs:'View Procs',
          pcpu:'CPU',pmem:'Memory',pgpu:'GPU',ppid:'PID',puser:'User',pname:'Process',pcpuPct:'CPU%',pmemCol:'Mem',pgpuCol:'GPU',pcount:'{n} processes',pnoGpu:'—',pcmd:'Command',filterHint:'Search...' };
    document.getElementById('l-1m').textContent = '1' + T.min;
    document.getElementById('l-5m').textContent = '5' + T.min;
    document.getElementById('l-15m').textContent = '15' + T.min;
    document.getElementById('l-used').textContent = T.used;
    document.getElementById('l-avail').textContent = T.avail;
    document.getElementById('l-total').textContent = T.total;
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

  // ── 消息处理 ──
  window.addEventListener('message', function(evt) {
    var data = evt.data;
    if (data.cmd === 'config') {
      barCfg = data.barCfg || barCfg;
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

    document.getElementById('mem-val').textContent = d.mem.percent + '%';
    setBar('mem-bar', d.mem.percent);
    document.getElementById('mem-used').textContent = d.mem.usedStr;
    document.getElementById('mem-avail').textContent = d.mem.availStr;
    document.getElementById('mem-total').textContent = d.mem.totalStr;

    var sshCard = document.getElementById('ssh-card');
    var netTitle = document.getElementById('net-title');
    if (d.ssh && d.ssh.isSSH) {
      netTitle.textContent = T.srvNet;
      sshCard.style.display = '';
      document.getElementById('ssh-label').textContent = T.localSSH;
      document.getElementById('ssh-tx').textContent = d.ssh.txStr;
      document.getElementById('ssh-rx').textContent = d.ssh.rxStr;
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
      var ghtml = '';
      d.gpus.forEach(function(g) {
        var util = parseInt(g.util) || 0;
        var mu = parseInt(g.memUsed) || 0;
        var mt = parseInt(g.memTotal) || 1;
        var memPct = Math.min(100, Math.round(mu / mt * 100));
        var pwStr = g.power ? '<span>' + T.pwLabel + ' <b>' + g.power.draw + '/' + g.power.limit + ' W</b></span>' : '';
        ghtml += '<div class="gpu-mini">'
          + '<div class="gpu-title"><span class="gpu-name">GPU ' + g.idx + '</span><span class="gpu-sub">' + g.name + '</span></div>'
          + '<div class="bar-label"><span>' + T.utilLabel + '</span><span>' + util + '% <span class="gpu-link" data-gpu-link="' + g.idx + '">&nearr; ' + T.viewProcs + '</span></span></div>'
          + '<div class="track"><div class="fill ' + colorClass(util) + '" id="gpu-util-' + g.idx + '"></div></div>'
          + '<div class="bar-label"><span>' + T.memLabel + '</span><span>' + mu + ' / ' + mt + ' MiB (' + memPct + '%)</span></div>'
          + '<div class="track"><div class="fill ' + colorClass(memPct) + '" id="gpu-mem-' + g.idx + '"></div></div>'
          + '<div class="gpu-stats"><span>' + T.tempLabel + ' <b>' + (g.temp || 0) + ' °C</b></span>' + pwStr + '</div></div>';
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
      d.gpus.forEach(function(g) {
        var util = parseInt(g.util) || 0;
        var mu = parseInt(g.memUsed) || 0, mt = parseInt(g.memTotal) || 1;
        var memPct = Math.min(100, Math.round(mu / mt * 100));
        var ub = document.getElementById('gpu-util-' + g.idx);
        var mb = document.getElementById('gpu-mem-' + g.idx);
        if (ub) ub.style.width = util + '%';
        if (mb) mb.style.width = memPct + '%';
      });
    } else {
      gpuBody.innerHTML = '<span class="gpu-na">' + T.noGpu + '</span>';
    }

    document.getElementById('net-tx').textContent = d.net.txStr;
    document.getElementById('net-rx').textContent = d.net.rxStr;

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
  var barCfg = {barEnabled:true,cpu:true,ram:false,net:'off',ssh:false,gpu:{summary:true,mode:'off',cards:[],metric:'both'}};
  var curInterval = 2, gpuCount = 8, modalOpen = false;

  function openModal() {
    modalOpen = true;
    vscode.postMessage({cmd:'getConfig'});
    document.getElementById('modal-mask').classList.add('open');
    document.getElementById('modal-title-text').textContent = T.settTitle;
    document.getElementById('sett-interval-label').textContent = T.interval;
    document.getElementById('sett-bar-label').textContent = T.statusBar;
    renderIntervalRow();
    renderSettingsBody();
  }
  function closeModal() { modalOpen = false; document.getElementById('modal-mask').classList.remove('open'); }
  document.getElementById('settings-btn').addEventListener('click', openModal);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-mask').addEventListener('click', function(e){ if (e.target===this) closeModal(); });
  document.getElementById('open-vsc-settings').addEventListener('click', function(){ vscode.postMessage({cmd:'openSettings'}); });

  function renderIntervalRow() {
    var row = document.getElementById('interval-row');
    row.innerHTML = '';
    [1,2,5,10].forEach(function(s) {
      var b = document.createElement('button');
      b.className = 'tb' + (curInterval===s?' on':'');
      b.textContent = s+'s';
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
    h += row('CPU', toggle('cpu', cfg.cpu ? T.enabled : T.disabled));
    h += row('RAM', toggle('ram', cfg.ram ? T.enabled : T.disabled));
    h += row(T.netLabel, radio('net','off',T.scopeOff)+radio('net','up',T.netUp)+radio('net','down',T.netDown)+radio('net','both',T.netAll)+radio('net','combined',T.netMerge));
    h += row(T.sshLabel, toggle('ssh', cfg.ssh ? T.enabled : T.disabled));
    h += row(T.gpuSummary, '<button class="tb'+(gpu.summary?' on':'')+'" data-act="gpu-summary">'+(gpu.summary?T.enabled:T.disabled)+'</button>');

    var gpuMode = gpu.mode || 'off';
    h += row(T.gpuPerf,
      '<button class="tb'+(gpuMode==='all'?' on':'')+'" data-act="gpu-mode" data-val="all">'+T.gpuAll+'</button>'
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
  }

  function bindSettingsEvents(body, cfg) {
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
          var v = this.dataset.val;
          cfg.gpu.mode = (cfg.gpu.mode === v) ? 'off' : v;
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
  var hintShown = false, hintDismissed = false;
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
      '<th>'+T.pname+'</th><th>'+T.puser+'</th><th class="r">CPU%</th><th class="r">RAM</th><th class="r">RAM%</th><th>GPU</th><th>'+T.pcmd+'</th>';
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

function readConfig() {
  const c = vscode.workspace.getConfiguration('sysmonitor');
  const interval = c.get('refreshInterval', 2);
  const barCfg = c.get('statusBar') || { barEnabled: true, cpu: true, ram: false, net: 'off', ssh: false, gpu: { summary: true, mode: 'off', cards: [], metric: 'both' } };
  return { interval, barCfg };
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
      } catch {}
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
  } catch {}
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
      } catch {}
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
  } catch {}
  return procs;
}

class MonitorViewProvider {
  constructor(ctx) { this._view = null; this._ctx = ctx; this._interval = 2000; this._paused = false; }

  resolveWebviewView(view) {
    this._view = view;
    view.webview.options = { enableScripts: true };
    const nonce = Math.random().toString(36).slice(2, 18);
    view.webview.html = getWebviewHtml(nonce);

    view.webview.onDidReceiveMessage(msg => {
      if (msg.cmd === 'getConfig') {
        this._pushConfig();
      } else if (msg.cmd === 'setConfig') {
        const c = vscode.workspace.getConfiguration('sysmonitor');
        if (msg.key === 'refreshInterval') {
          c.update('refreshInterval', msg.value, true).then(() => updateBar());
          this._resetTimer(msg.value * 1000);
        } else if (msg.key === 'statusBar') {
          c.update('statusBar', msg.value, true).then(() => updateBar());
        }
      } else if (msg.cmd === 'openSettings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'sysmonitor');
      } else if (msg.cmd === 'pause') {
        this._paused = !!msg.value;
      } else if (msg.cmd === 'needProcs') {
        this._pushProcs();
      }
    });

    const tick = () => {
      if (!this._view || this._paused) return;
      const cpu  = getCpuPercent();
      const mem  = getMemInfo();
      const net  = getNetSpeed();
      const gpus = getAllGpus();
      const ssh  = getSshTraffic();
      const loads = os.loadavg();
      const lang = vscode.env.language;
      const netData = { rxStr: fmtBytes(net.rx), txStr: fmtBytes(net.tx) };
      const payload = {
        lang, cpu, cpuCores: os.cpus().length,
        load1: loads[0].toFixed(2), load5: loads[1].toFixed(2), load15: loads[2].toFixed(2),
        mem: { percent: mem.percent, usedStr: fmtSize(mem.used), availStr: fmtSize(mem.avail), totalStr: fmtSize(mem.total) },
        gpus,
        net: netData,
        ssh: ssh.isSSH ? { isSSH: true, txStr: fmtBytes(ssh.rx), rxStr: fmtBytes(ssh.tx) } : { isSSH: false },
      };
      this._view.webview.postMessage({ cmd: 'update', payload });
      latestData = { cpu, mem: { percent: mem.percent }, net: netData, ssh: payload.ssh, gpus };
      updateBar();
    };
    this._tick = tick;

    const { interval } = readConfig();
    this._interval = interval * 1000;
    tick();
    this._timer = setInterval(tick, this._interval);

    this._procsTimer = setInterval(() => { this._pushProcs(); }, 5000);

    view.onDidDispose(() => {
      clearInterval(this._timer);
      clearInterval(this._procsTimer);
      this._view = null;
    });
  }

  _resetTimer(ms) {
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
    const { interval, barCfg } = readConfig();
    const gpus = getAllGpus();
    this._view.webview.postMessage({
      cmd: 'config', interval, barCfg,
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
  const { barCfg } = readConfig();
  const txt = formatBarText(barCfg, latestData);
  if (txt) { barRef.text = txt; barRef.show(); }
  else { barRef.hide(); }
}

function activate(context) {
  const lang = vscode.env.language || '';
  const zh = lang.startsWith('zh');

  if (!vscode.env.remoteName) {
    const autoBtn = zh ? '一键加入 SSH 默认扩展' : 'Add to SSH default extensions';
    vscode.window.showInformationMessage(
      zh
        ? 'System Monitor 在远程窗口（WSL / 容器 / SSH 等）中运行，且仅当远程为 Linux 时可用。使用 Remote-SSH 时可将扩展 ID 写入设置以便自动安装。'
        : 'System Monitor runs in remote windows (WSL, Dev Containers, SSH, …) and only when the remote OS is Linux. For Remote-SSH, you can save the extension ID for auto-install.',
      autoBtn
    ).then(choice => {
      if (choice === autoBtn) {
        const c = vscode.workspace.getConfiguration('remote.SSH');
        const list = (c.get('defaultExtensions') || []).slice();
        if (!list.includes(EXTENSION_ID)) {
          list.push(EXTENSION_ID);
          c.update('defaultExtensions', list, true).then(() => {
            vscode.window.showInformationMessage(zh
              ? '已写入：' + EXTENSION_ID + '（仅影响 Remote-SSH 连接）。'
              : 'Saved: ' + EXTENSION_ID + ' (applies to Remote-SSH only).');
          });
        } else {
          vscode.window.showInformationMessage(zh
            ? '列表中已有 ' + EXTENSION_ID + '。'
            : EXTENSION_ID + ' is already in the list.');
        }
      }
    });
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

  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  bar.command = 'sysmonitor.openPanel';
  bar.tooltip = 'System Monitor (Remote)';
  barRef = bar;
  const { barCfg: initCfg } = readConfig();
  if (initCfg.barEnabled !== false) bar.show();
  context.subscriptions.push(bar);

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('sysmonitor')) {
      updateBar();
      const newInt = readConfig().interval * 1000;
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
