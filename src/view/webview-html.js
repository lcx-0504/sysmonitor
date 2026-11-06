'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const pkg = require('../../package.json');
const { createTranslator, resolveLanguage } = require('../i18n');
const { COLLECTION_FIELDS, REFRESH_SETTING } = require('../config/default-config');
const { DISK_PRESETS } = require('../domain/disk');
const WEBVIEW_SCRIPT_FILES = ['app.mjs', 'chart-state.mjs', 'charts.mjs', 'layout.mjs', 'performance.mjs', 'settings.mjs', 'navigation.mjs', 'servers.mjs', 'processes.mjs'];

async function getWebviewHtml({ initConfig, nonce, webview, vscode }) {
  const language = resolveLanguage(initConfig && initConfig.language);
  const t = createTranslator(language);
  const style = await fs.readFile(path.join(__dirname, 'assets', 'webview.css'), 'utf8');
  const moduleUri = webview?.asWebviewUri
    ? webview.asWebviewUri(vscode.Uri.file(path.join(__dirname, 'assets', 'main.mjs'))).toString()
    : './main.mjs';
  const configBase64 = Buffer.from(JSON.stringify({ ...initConfig, collectionFields: COLLECTION_FIELDS, refreshSetting: REFRESH_SETTING, diskPresets: DISK_PRESETS }), "utf8").toString("base64");
  const surface = initConfig && initConfig.surface === 'editor' ? 'editor' : 'sidebar';
  const paused = initConfig && initConfig.paused === true;
  return `<!DOCTYPE html>
<html lang="${language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}' ${webview?.cspSource || ''};">
<style nonce="${nonce}">${style}</style>
</head>
<body data-config="${configBase64}" data-surface="${surface}">

<!-- ── 顶栏 ── -->
<div class="topbar">
  <div class="topbar-left">
  <button class="tb on" id="tab-perf-btn">${t("perfTab")}</button>
  <button class="tb" id="tab-proc-btn">${t("procTab")}</button>
  <button class="tb" id="tab-servers-btn" hidden>${t("serversTab")}</button>
  </div>
  <div class="topbar-right">
    <button type="button" class="tb" id="topbar-more" aria-haspopup="menu" aria-expanded="false" aria-label="${t("moreActions")}" title="${t("moreActions")}" hidden>…</button>
    <span class="topbar-info" id="updated">--</span>
    <button class="tb" id="topbar-server-refresh" hidden>${t("refreshList")}</button>
    <button class="tb${paused ? '' : ' on'}" id="pause-btn">${paused ? t("stopped") : t("running")}</button>
    <button class="tb on" id="settings-btn">${t("settBtn")}</button>
  </div>
</div>
<div class="device-strip-wrap" id="device-strip-wrap" hidden>
  <div class="device-strip" id="device-strip" role="tablist" aria-label="${t("devices")}" hidden></div>
  <div class="device-scrollbar" id="device-scrollbar" aria-hidden="true" hidden><div class="device-scrollbar-thumb" id="device-scrollbar-thumb"></div></div>
</div>

<div class="connection-banner" id="connection-banner"><span id="connection-banner-text"></span><button type="button" id="connection-retry" hidden>${t("retry")}</button></div>

<!-- ── 设置模态 ── -->
<div class="modal-mask" id="modal-mask">
<div class="modal">
  <div class="modal-title"><span>${t("settBtn")}</span><span class="flex-1"></span><button class="tb" id="open-vsc-settings">settings.json ↗</button><button class="tb" id="modal-close">✕</button></div>
  <div class="modal-body" id="modal-body">
  <div class="sett-section" id="sett-timeouts-section">
    <div class="sett-label">${t("connectionAndCollection")}</div>
    <div class="setting-row interval-setting-row"><span class="setting-title">${t("refreshIntervalLabel")}</span><div class="sett-row" id="interval-row"></div></div>
    <div class="setting-row custom-timeout-row"><span class="setting-info sett-heading"><span class="setting-title">${t("customCollection")}</span><button type="button" class="sett-info-icon" id="timeout-info" aria-label="${t("collectionInfoLabel")}">ⓘ</button></span><span class="setting-control timeout-controls"><button type="button" class="tb timeout-reset" id="timeout-reset" hidden>${t("restoreDefaults")}</button><button type="button" class="setting-switch" role="switch" aria-checked="false" id="timeout-toggle"><span></span></button></span></div>
    <div id="sett-timeouts-body" hidden></div>
  </div>
  <div class="sett-section">
    <div class="sett-label sett-heading"><span>${t("statusBar")}</span><button type="button" class="sett-info-icon" id="sett-bar-info" aria-label="${t("statusBarScope")}">ⓘ</button></div>
    <div id="sett-body" class="settings-options"></div>
  </div>
  <div class="sett-section">
    <div class="sett-label">${t("diskLabel")}</div>
    <div id="sett-disk-body" class="settings-options"></div>
  </div>
  <div class="sett-section">
    <div class="sett-label">${t("displayLabel")}</div>
    <div id="sett-display-body" class="settings-options"></div>
  </div>
  <div class="sett-section">
    <div class="sett-label">${t("actionButtons")}</div>
    <div id="sett-actions-body" class="settings-options"></div>
  </div>
  <div class="sett-section">
    <div class="sett-label">${t("serversTab")}</div>
    <div id="sett-servers-body" class="settings-options"></div>
    <div class="sett-hint ssh-default-error" id="ssh-default-error" hidden></div>
  </div>
  <div id="config-save-error" role="status" hidden><span>${t("configSaveFailed")}</span><button type="button" class="tb" id="config-save-retry">${t("retry")}</button></div>
  <div class="copyright">v${pkg.version} · © ${new Date().getFullYear()} Li Chenxi · ${pkg.license}<br><a href="https://marketplace.visualstudio.com/items?itemName=LiChenxi.sysmonitor">Marketplace</a> · <a href="https://open-vsx.org/extension/LiChenxi/sysmonitor">Open VSX</a> · <a href="https://github.com/lcx-0504/sysmonitor">GitHub</a></div>
  </div>
  <div class="modal-scrollbar" id="modal-scrollbar" aria-hidden="true" hidden><div class="modal-scrollbar-thumb" id="modal-scrollbar-thumb"></div></div>
</div>
</div>

<!-- ── 性能 tab ── -->
<div class="tab-content active" id="tab-perf">
<div class="net-ssh-row" id="system-row">
  <div class="card" id="cpu-card">
    <svg class="spark-bg" id="cpu-spark" viewBox="0 0 100 100" preserveAspectRatio="none"><path id="cpu-spark-area" /></svg>
    <div class="card-head"><span class="card-label">CPU</span><span class="card-value" id="cpu-val">--</span></div>
    <div class="track"><div class="fill" id="cpu-bar"></div></div>
    <div class="detail-row"><span>${t("minutes", { count: 1 })}</span><span id="load-1">--</span></div>
    <div class="detail-row"><span>${t("minutes", { count: 5 })}</span><span id="load-5">--</span></div>
    <div class="detail-row"><span>${t("minutes", { count: 15 })}</span><span id="load-15">--</span></div>
  </div>
  <div class="card" id="mem-card">
    <svg class="spark-bg" id="ram-spark" viewBox="0 0 100 100" preserveAspectRatio="none"><path id="ram-spark-area" /></svg>
    <div class="card-head"><span class="card-label">RAM</span><span class="card-value" id="mem-val">--</span></div>
    <div class="track"><div class="fill" id="mem-bar"></div></div>
    <div class="detail-row"><span>${t("used")}</span><span id="mem-used">--</span></div>
    <div class="detail-row"><span>${t("avail")}</span><span id="mem-avail">--</span></div>
    <div class="detail-row"><span>${t("total")}</span><span id="mem-total">--</span></div>
  </div>
</div>

<div class="card disk-empty" id="disk-card">
  <svg class="spark-bg" id="disk-spark" viewBox="0 0 100 100" preserveAspectRatio="none"><path id="disk-spark-r-area" /><path id="disk-spark-w-area" /></svg>
  <div class="card-head"><span class="card-label">${t("diskLabel")}</span><span class="card-value" id="disk-io-value"><span id="disk-io-val">--</span><button type="button" class="disk-alert" id="disk-io-info" data-disk-io-info aria-label="${t('diskIoDetails')}">ⓘ</button></span></div>
  <div id="disk-body"></div>
</div>

<div class="net-ssh-row" id="network-row">
  <div class="card">
    <svg class="spark-bg" id="net-spark" viewBox="0 0 100 100" preserveAspectRatio="none"><path id="net-spark-tx-area" /><path id="net-spark-rx-area" /></svg>
    <div class="card-head"><span class="card-label" id="net-title">${t("net")}</span></div>
    <div class="net-row">
      <div class="net-item">
        <div class="net-dir">${t("up")}</div>
        <div class="net-speed" id="net-tx">--</div>
      </div>
      <div class="net-item">
        <div class="net-dir">${t("down")}</div>
        <div class="net-speed" id="net-rx">--</div>
      </div>
    </div>
  </div>
  <div class="card" id="ssh-card" hidden>
    <svg class="spark-bg" id="ssh-spark" viewBox="0 0 100 100" preserveAspectRatio="none"><path id="ssh-spark-tx-area" /><path id="ssh-spark-rx-area" /></svg>
    <div class="card-head"><span class="card-label">${t("localSSH")}</span><span class="card-value" id="ssh-latency" title="${t("latency")} · TCP RTT">--</span></div>
    <div class="net-row">
      <div class="net-item">
        <div class="net-dir">${t("up")}</div>
        <div class="net-speed" id="ssh-tx">--</div>
      </div>
      <div class="net-item">
        <div class="net-dir">${t("down")}</div>
        <div class="net-speed" id="ssh-rx">--</div>
      </div>
    </div>
  </div>
</div>

<div class="card" id="free-gpu-card" hidden>
  <div class="card-head"><span class="card-label">GPU</span><span class="card-value" id="gpu-summary">--</span></div>
  <div class="capsules" id="gpu-capsules"></div>
  <div class="capsule-actions" id="capsule-actions">
    <button class="action-btn" id="select-all-btn">${t("selAll")}</button>
    <button class="action-btn" id="clear-btn">${t("clear")}</button>
    <button class="action-btn primary" id="copy-btn" disabled>${t("copyEnv")}</button>
  </div>
</div>
<div class="gpu-grid" id="gpu-body"></div>
</div>

<!-- ── 进程 tab ── -->
<div class="tab-content" id="tab-proc">
  <div class="proc-toolbar-wrap">
    <div class="proc-sort-group" id="proc-toolbar"></div>
    <span class="proc-count" id="proc-count">--</span>
    <div class="filter-wrap" id="filter-wrap"><input class="proc-filter" id="proc-filter" placeholder="${t("filterHint")}" /><button class="filter-clear" id="filter-clear">&times;</button></div>
  </div>
  <div class="filter-hint" id="filter-hint"><span class="hint-close" id="hint-close">&times;</span>${t("searchHint")}${t("sentenceSeparator")}${t("searchHintGpu")}${t("sentenceSeparator")}<code>GPU0</code> <code>#0</code> <code>GPU 0</code></div>
  <div class="table-scroll">
    <table><thead><tr id="proc-hdr"></tr></thead><tbody id="proc-tbody"></tbody></table>
  </div>
  <div class="proc-footnote" id="proc-footnote" hidden><span id="proc-footnote-text"></span><button type="button" class="gpu-info" id="proc-footnote-info" aria-label="${t("processSearchScope")}" hidden>ⓘ</button></div>
</div>

<div class="tab-content" id="tab-servers">
  <div class="filter-hint server-intro-hint" id="server-intro-hint"><span id="server-intro-text"></span><div class="server-intro-actions"><small id="server-intro-ssh-error" hidden></small><button type="button" class="tb" id="server-intro-close">${t("gotIt")}</button><button type="button" class="tb on" id="server-intro-ssh-default">${t("addToDefaults")}</button></div></div>
  <div class="server-list" id="server-list"></div>
</div>

<script type="module" nonce="${nonce}" src="${moduleUri}"></script>
</body>
</html>`;
}


module.exports = { getWebviewHtml, WEBVIEW_SCRIPT_FILES };
