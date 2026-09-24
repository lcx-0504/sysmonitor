'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const pkg = require('../../package.json');
const WEBVIEW_SCRIPT_FILES = ['webview.js', 'webview-performance.js', 'webview-settings.js', 'webview-processes.js'];

async function getWebviewHtml({ initConfig, nonce }) {
  const [style, ...scripts] = await Promise.all([
    fs.readFile(path.join(__dirname, 'assets', 'webview.css'), 'utf8'),
    ...WEBVIEW_SCRIPT_FILES.map((fileName) => fs.readFile(path.join(__dirname, 'assets', fileName), 'utf8')),
  ]);
  const script = scripts.join('\n');
  const configBase64 = Buffer.from(JSON.stringify(initConfig || {}), "utf8").toString("base64");
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}' 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">${style}</style>
</head>
<body data-config="${configBase64}">

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
  <div class="modal-body" id="modal-body">
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
  <div class="modal-scrollbar" id="modal-scrollbar" aria-hidden="true" hidden><div class="modal-scrollbar-thumb" id="modal-scrollbar-thumb"></div></div>
</div>
</div>

<!-- ── 性能 tab ── -->
<div class="tab-content active" id="tab-perf">
<div class="net-ssh-row" id="system-row">
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
  <svg class="spark-bg" id="disk-spark" viewBox="0 0 100 100" preserveAspectRatio="none"><path id="disk-spark-r-area" /><path id="disk-spark-w-area" /></svg>
  <div class="card-head"><span class="card-label" id="disk-label">Disk</span><span class="card-value" id="disk-io-val"></span></div>
  <div id="disk-body"></div>
</div>

<div class="net-ssh-row" id="network-row">
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
    <div class="card-head"><span class="card-label" id="ssh-label">本机 SSH</span><span class="card-value" id="ssh-latency" title="TCP RTT">--</span></div>
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
  <div class="capsule-actions" id="capsule-actions">
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

<script nonce="${nonce}">${script}</script>
</body>
</html>`;
}


module.exports = { getWebviewHtml, WEBVIEW_SCRIPT_FILES };
