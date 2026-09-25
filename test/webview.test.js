'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { getWebviewHtml, WEBVIEW_SCRIPT_FILES } = require('../src/view/webview-html');

const readWebviewScript = () => WEBVIEW_SCRIPT_FILES.map((fileName) => fs.readFileSync(path.join(__dirname, '..', 'src/view/assets', fileName), 'utf8')).join('\n');

test('monitor cards start empty while a newly selected SSH server is loading', () => {
  const assets = path.join(__dirname, '..', 'src', 'view', 'assets');
  const css = fs.readFileSync(path.join(assets, 'webview.css'), 'utf8');
  const startup = fs.readFileSync(path.join(assets, 'webview-processes.js'), 'utf8');
  assert.match(css, /\.fill\s*\{\s*width:\s*0;/);
  assert.match(startup, /applyGroupVisibility\(\);\s*document\.getElementById\('ssh-card'\)\.style\.display = 'none';/);
});

test('connection banner keeps a fixed secondary retry control and stops chart animation while disconnected', async () => {
  const html = await getWebviewHtml({ initConfig: {}, nonce: 'test' });
  const assets = path.join(__dirname, '..', 'src/view/assets');
  const css = fs.readFileSync(path.join(assets, 'webview.css'), 'utf8');
  const navigation = fs.readFileSync(path.join(assets, 'webview-navigation.js'), 'utf8');
  const webview = fs.readFileSync(path.join(assets, 'webview.js'), 'utf8');
  assert.match(html, /id="connection-banner-text"[^>]*><\/span><button type="button" class="connection-retry" id="connection-retry" hidden>/);
  assert.match(css, /\.connection-banner\.show \{ display: flex; \}/);
  assert.match(css, /#connection-retry \{[^}]*--vscode-button-secondaryBackground/);
  assert.match(navigation, /sendToExtension\(\{ cmd: 'retryConnection', deviceId: currentDeviceId \}\)/);
  assert.match(webview, /!paused && connectionAllowsAnimation && displayCfg/);
});

test('retry button shows cooldown and keeps manual retry available while paused', () => {
  const navigation = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview-navigation.js'), 'utf8');
  const functionCode = navigation.slice(navigation.indexOf('  function retryButtonState('), navigation.indexOf('  function refreshConnectionRetryButton('));
  const context = {};
  vm.runInNewContext(`${functionCode}\nthis.retryButtonState = retryButtonState;`, context);
  assert.equal(context.retryButtonState('disconnected', false, false, 10000, 2000, true).text, '重试 (8)');
  assert.equal(context.retryButtonState('disconnected', false, true, 10000, 2000, true).text, '重试');
  assert.equal(context.retryButtonState('connecting', false, false, 10000, 2000, true).text, '连接中');
  assert.equal(context.retryButtonState('connecting', false, false, 10000, 2000, true).disabled, true);
  assert.equal(context.retryButtonState('disconnected', false, false, 10000, 2000, false).text, 'Retry (8)');
});

test('retry countdown reaches zero without making the view own the SSH reconnect', () => {
  const navigation = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview-navigation.js'), 'utf8');
  const code = navigation.slice(navigation.indexOf('  var connectionBanner ='), navigation.indexOf('  function storeNavigation('));
  const button = { hidden: true, disabled: false, textContent: '', addEventListener() {} };
  const sent = [];
  let now = 2000, timer = null;
  const context = {
    document: { getElementById: (id) => id === 'connection-retry' ? button : {} },
    currentDeviceId: 'ssh:lab', navigation: { page: 'perf' }, paused: false, zh: true,
    Date: { now: () => now },
    setTimeout: (callback, delay) => { timer = { callback, delay }; return 1; },
    clearTimeout() {},
    sendToExtension: (message) => sent.push(message),
  };
  vm.runInNewContext(`${code}\nthis.refresh = refreshConnectionRetryButton;`, context);
  context.connectionState = 'disconnected';
  context.connectionRetryAfter = 10000;
  context.refresh();
  assert.equal(button.textContent, '重试 (8)');
  assert.equal(timer.delay, 1000);
  now = 10000;
  timer.callback();
  assert.equal(button.textContent, '重试');
  assert.equal(button.disabled, false);
  assert.equal(sent.length, 0);
});

test('status bar settings stay available in local non-Linux windows', () => {
  const settings = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview-settings.js'), 'utf8');
  assert.doesNotMatch(settings, /getElementById\('sett-bar-section'\)\.hidden/);
});

test('tab sorting stays inside the device strip and Webview state updates preserve other hints', () => {
  const assets = path.join(__dirname, '..', 'src/view/assets');
  const navigation = fs.readFileSync(path.join(assets, 'webview-navigation.js'), 'utf8');
  const processes = fs.readFileSync(path.join(assets, 'webview-processes.js'), 'utf8');
  const style = fs.readFileSync(path.join(assets, 'webview.css'), 'utf8');
  assert.doesNotMatch(navigation, /dataTransfer|dragstart/);
  assert.match(navigation, /tab\.setPointerCapture\(event\.pointerId\)/);
  assert.match(navigation, /tab\.addEventListener\('auxclick', function\(event\) \{\s*if \(event\.button !== 1 \|\| id === 'local'\) return;\s*event\.preventDefault\(\);\s*sendToExtension\(\{ cmd: 'closeDevice', id: id \}\)/);
  assert.match(navigation, /moveTabWithinStrip\(event\)/);
  assert.match(navigation, /if \(tabs\.length < 2\) return;/);
  assert.match(navigation, /var minOffset = Math\.min\(0, bounds\.left \+ 1 - drag\.origin\.left\)/);
  assert.match(navigation, /var maxOffset = Math\.max\(0, bounds\.right - 1 - drag\.origin\.right\)/);
  assert.match(style, /\.device-tab\.dragging\s*\{[^}]*opacity:\s*\.68;/);
  assert.match(style, /\.device-strip\s*\{[^}]*clip-path:\s*inset\(0\);/);
  assert.match(style, /\.topbar\.instant-page \.tb\s*\{\s*transition:\s*none;/);
  assert.match(navigation, /var tabAvailabilityChanged = \(navigation\.tabs\.length === 0\) !== \(state\.tabs\.length === 0\)/);
  assert.match(style, /\.server-intro-actions\s*\{[^}]*justify-content:\s*flex-end;/);
  assert.match(style, /\.server-intro-actions \.tb\s*\{[^}]*min-height:\s*26px;/);
  assert.match(style, /\.server-intro-actions small\s*\{[^}]*flex:\s*0 0 100%;/);
  assert.match(navigation, /slot\.tab\.style\.transform = shift \? 'translateX\('/);
  assert.match(navigation, /var shouldReorder = drag\.active && drag\.targetIndex !== drag\.originIndex/);
  assert.doesNotMatch(navigation, /pointerInsideStrip/);
  assert.match(navigation, /vscode\.setState\(Object\.assign\(\{\}, vscode\.getState\(\) \|\| \{\}, \{ navigation: navigation \}\)\)/);
  assert.match(processes, /vscode\.setState\(Object\.assign\(\{\}, vscode\.getState\(\) \|\| \{\}, \{ hintDismissed: true \}\)\)/);
  assert.match(style, /\.gpu-info-popover\.sett-info-popover\s*\{\s*z-index:\s*260;/);
  assert.match(style, /body\[data-surface="editor"\]\s*\{\s*--card-bg:\s*var\(--vscode-editor-background/);
});

test('settings switches finish their transition before a config echo redraws the panel', () => {
  const assets = path.join(__dirname, '..', 'src/view/assets');
  const settings = fs.readFileSync(path.join(assets, 'webview-settings.js'), 'utf8');
  const webview = fs.readFileSync(path.join(assets, 'webview.js'), 'utf8');
  assert.match(settings, /settingsTransitionUntil = Date\.now\(\) \+ 190/);
  assert.match(settings, /if \(rerender\) renderSettingsAfterTransition\(\)/);
  assert.match(webview, /if \(modalOpen && !settingMenu\) renderSettingsAfterTransition\(\)/);
  assert.match(settings, /未显示的服务器会暂停采样，图表趋势可能中断，切换回来时加载会更慢/);
  assert.match(settings, /button\.classList\.toggle\('on', !sshDefaultInstalled\)/);
});

test('page navigation precedes flat device tabs and server actions use Codicons', async () => {
  const html = await getWebviewHtml({ initConfig: {}, nonce: 'test' });
  const assets = path.join(__dirname, '..', 'src', 'view', 'assets');
  const css = fs.readFileSync(path.join(assets, 'webview.css'), 'utf8');
  const navigation = fs.readFileSync(path.join(assets, 'webview-navigation.js'), 'utf8');
  const servers = fs.readFileSync(path.join(assets, 'webview-servers.js'), 'utf8');
  assert.ok(html.indexOf('class="topbar"') < html.indexOf('id="device-strip"'));
  assert.match(css, /\.device-tab\s*\{[^}]*border:\s*0;/);
  assert.match(css, /\.device-tab\s*\{[^}]*height:\s*25px;/);
  assert.match(css, /\.device-tab\.active::after\s*\{[^}]*bottom:\s*0;[^}]*background:\s*var\(--accent\);/);
  assert.match(css, /\.device-tab-close\s*\{[^}]*cursor:\s*pointer;/);
  assert.match(css, /\.device-tab-close:hover\s*\{[^}]*background:/);
  assert.match(servers, /serverIcons = \{[\s\S]*editor: '<svg[\s\S]*window: '<svg[\s\S]*remote: '<svg[\s\S]*terminal: '<svg/);
  assert.match(servers, /row\.querySelector\('\.server-open'\)\.disabled = !!server\.busy/);
  assert.match(servers, /row\.querySelector\('\.server-editor'\)\.hidden = actionsVisible\.editor === false/);
  assert.match(servers, /row\.querySelector\('\.server-window'\)\.hidden = actionsVisible\.window === false/);
  assert.match(servers, /row\.querySelector\('\.server-terminal'\)\.hidden = actionsVisible\.terminal === false/);
  assert.match(servers, /row\.querySelector\('\.server-remote'\)\.hidden = actionsVisible\.remoteWindow === false/);
  assert.match(servers, /server\.state === 'loading' \? \(zh \? '资源加载中…' : 'Loading resources…'\)/);
  assert.doesNotMatch(servers, /editor\.textContent = '↗'|terminal\.textContent = '>_'/);
  assert.match(navigation, /deviceStrip\.hidden = editorMode \|\| !hasTabs \|\| navigation\.page === 'servers'/);
  assert.match(navigation, /serverTabButton\.hidden = editorMode/);
  assert.match(navigation, /document\.getElementById\('updated'\)\.hidden = serverPageActive/);
  assert.match(navigation, /if \(tabsChanged \|\| deviceStrip\.childElementCount !== state\.tabs\.length\) renderDeviceTabs\(\);\s*else updateDeviceTabsPresentation\(\)/);
  const webview = fs.readFileSync(path.join(assets, 'webview.js'), 'utf8');
  assert.match(webview, /requestedPage = name;[\s\S]*?updateDeviceTabsPresentation\(\);[\s\S]*?sendToExtension\(\{cmd:'switchPage',page:name\}\)/);
  assert.match(navigation, /topbar\.hidden = false/);
  assert.match(navigation, /document\.getElementById\('tab-perf-btn'\)\.hidden = !hasTabs/);
  assert.match(navigation, /document\.getElementById\('topbar-server-refresh'\)\.hidden = editorMode \|\| !serverPageActive/);
  assert.match(servers, /open\.textContent = zh \? '打开' : 'Open'/);
  assert.match(servers, /open\.className = 'tb server-open'/);
  assert.match(servers, /editor\.className = 'server-action server-editor'/);
  assert.match(servers, /floating\.className = 'server-action server-window'/);
  assert.match(servers, /sendToExtension\(\{ cmd: 'openServer', host: server\.host, inWindow: true \}\)/);
  assert.match(servers, /remote\.className = 'server-action server-remote'/);
  assert.match(servers, /actions\.appendChild\(open\); actions\.appendChild\(editor\); actions\.appendChild\(floating\); actions\.appendChild\(terminal\); actions\.appendChild\(remote\)/);
  assert.match(servers, /connect\.textContent = zh \? '连接主机' : 'Connect to host'/);
  assert.doesNotMatch(servers, /最近打开的文件夹|暂无记录/);
  assert.match(servers, /if \(folders\.length\) \{\s*var divider = document\.createElement\('div'\)/);
  assert.match(servers, /sendToExtension\(\{ cmd: 'listRemoteFolders', host: host \}\)/);
  assert.doesNotMatch(servers, /renderRemoteMenu\(\[\]\)/);
  assert.match(navigation, /data\.cmd === 'remoteFolders' && remoteMenuHost === data\.host\) showRemoteMenu\(data\.folders \|\| \[\]\)/);
  assert.match(servers, /terminal\.className = 'server-action server-terminal'/);
  assert.match(css, /\.server-action\s*\{[^}]*border:\s*0;/);
  assert.match(css, /\.server-folder-menu\s*\{[^}]*position:\s*fixed;/);
  assert.match(css, /\.server-folder-menu\s*\{[^}]*width:\s*max-content;[^}]*max-width:\s*min\(200px,/);
  assert.doesNotMatch(css, /\.server-folder-menu\s*\{[^}]*min-width:/);
  assert.doesNotMatch(navigation, /tab\.draggable = true|dataTransfer/);
  assert.match(navigation, /tab\.setPointerCapture\(event\.pointerId\)/);
  assert.match(navigation, /deviceStrip\.getBoundingClientRect\(\)/);
  assert.match(navigation, /sendToExtension\(\{ cmd: 'reorderDevices', tabs: reordered \}\)/);
});

test('update time follows the rendered card rows and available two-card width', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview.css'), 'utf8');
  assert.match(css, /\.compact-layout \.topbar-info \{ display: none; \}/);
  const script = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview-layout.js'), 'utf8');
  const helper = script.slice(0, script.indexOf('  var monitorLayoutObserver'));
  const page = { clientWidth: 328, get offsetWidth() { return this.clientWidth; }, getBoundingClientRect() { return { width: this.clientWidth }; } };
  const styles = {
    'tab-perf': { paddingLeft: '10px', paddingRight: '10px' },
    'cpu-card': { flexBasis: '150px' },
    'system-row': { columnGap: '8px' },
  };
  const bounds = {
    'cpu-card': { width: 0, top: 0 },
    'mem-card': { width: 0, top: 0 },
    'system-row': { width: 0 },
  };
  const elements = Object.fromEntries(['tab-perf', 'cpu-card', 'mem-card', 'system-row'].map((id) => [id, { id, getBoundingClientRect: () => bounds[id] }]));
  let compact;
  const context = {
    document: {
      querySelector: () => page, getElementById: (id) => elements[id],
      body: { classList: { toggle(name, enabled) { assert.equal(name, 'compact-layout'); compact = enabled; } } },
    },
    getComputedStyle: (element) => styles[element.id],
  };
  vm.runInNewContext(helper, context);
  context.updateResponsiveLayout();
  assert.equal(compact, false);
  page.clientWidth = 327;
  context.updateResponsiveLayout();
  assert.equal(compact, true);
  styles['tab-perf'].paddingLeft = styles['tab-perf'].paddingRight = '8px';
  page.clientWidth = 324;
  context.updateResponsiveLayout();
  assert.equal(compact, false);
  page.clientWidth = 323;
  context.updateResponsiveLayout();
  assert.equal(compact, true);

  // The rendered rows take precedence over a rounded viewport width.
  page.clientWidth = 328;
  bounds['cpu-card'] = { width: 307.75, top: 10 };
  bounds['mem-card'] = { width: 307.75, top: 130 };
  context.updateResponsiveLayout();
  assert.equal(compact, true);
  bounds['cpu-card'] = { width: 150, top: 10 };
  bounds['mem-card'] = { width: 150, top: 10 };
  context.updateResponsiveLayout();
  assert.equal(compact, false);
  bounds['mem-card'] = { width: 307.75, top: 130 };
  context.updateResponsiveLayout();
  assert.equal(compact, true);
});

test('the tab scrollbar overlays the strip, tracks scroll position, and supports dragging', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview.css'), 'utf8');
  assert.match(css, /\.device-strip \{[^}]*scrollbar-width: none;/);
  assert.match(css, /\.device-scrollbar \{ position: absolute;/);
  const script = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview-layout.js'), 'utf8');
  const handlers = {};
  const viewport = { clientWidth: 300, scrollWidth: 600, scrollLeft: 100, addEventListener() {} };
  const track = {
    style: {}, hidden: true, classList: { add() {}, remove() {} },
    addEventListener: (name, handler) => { handlers[name] = handler; },
    getBoundingClientRect: () => ({ left: 0, width: 300 }),
    setPointerCapture() {}, hasPointerCapture: () => false,
  };
  const thumb = {
    style: {}, offsetWidth: 150,
    getBoundingClientRect: () => ({ left: 50, width: 150 }),
  };
  const elements = { 'device-strip': viewport, 'device-scrollbar': track, 'device-scrollbar-thumb': thumb };
  const context = {
    document: { getElementById: (id) => elements[id] },
    ResizeObserver: class { observe() {} },
  };
  vm.runInNewContext(script.slice(script.indexOf('  var tabScrollViewport')), context);
  context.updateDeviceScrollbar();
  assert.equal(track.hidden, false);
  assert.equal(thumb.style.width, '150px');
  assert.equal(thumb.style.transform, 'translateX(50px)');
  handlers.pointerdown({ target: thumb, button: 0, clientX: 60, pointerId: 1, preventDefault() {} });
  handlers.pointermove({ clientX: 110, pointerId: 1 });
  assert.equal(viewport.scrollLeft, 200);
  assert.equal(thumb.style.transform, 'translateX(100px)');
  handlers.pointerup({ pointerId: 1 });
  handlers.pointermove({ clientX: 200, pointerId: 1 });
  assert.equal(viewport.scrollLeft, 200);
  viewport.scrollWidth = 300;
  context.updateDeviceScrollbar();
  assert.equal(track.hidden, true);
});

test('CPU and memory cards can be hidden independently', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src/view/webview-html.js'), 'utf8');
  const settings = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview-settings.js'), 'utf8');
  assert.match(html, /id="cpu-card"/);
  assert.match(html, /id="mem-card"/);
  assert.match(settings, /groupLabels = \{cpu:'CPU',memory:'RAM'/);
  const script = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview-performance.js'), 'utf8');
  const visibilityCode = script.slice(script.indexOf('  function applyGroupVisibility()'), script.indexOf('  function gpuStatsDescription('));
  const ids = ['cpu-card', 'mem-card', 'system-row', 'disk-card', 'network-row', 'free-gpu-card', 'gpu-body', 'gpu-capsules', 'capsule-actions'];
  const elements = Object.fromEntries(ids.map((id) => [id, { style: {} }]));
  const context = {
    document: { getElementById: (id) => elements[id], querySelector: () => ({ style: {} }), querySelectorAll: () => [] },
    displayCfg: { hiddenGroups: { cpu: true, memory: false } },
    lastGpuPayload: [], renderedDiskKeys: [], gpuInfoPopover: null, renderGpuUsers() {}, updateGpuStatsFit() {},
  };
  vm.runInNewContext(`${visibilityCode}\nthis.applyGroupVisibility = applyGroupVisibility;`, context);
  context.applyGroupVisibility();
  assert.equal(elements['cpu-card'].style.display, 'none');
  assert.equal(elements['mem-card'].style.display, '');
  assert.equal(elements['system-row'].style.display, '');
  context.displayCfg.hiddenGroups = { cpu: false, memory: true };
  context.applyGroupVisibility();
  assert.equal(elements['cpu-card'].style.display, '');
  assert.equal(elements['mem-card'].style.display, 'none');
  context.displayCfg.hiddenGroups.cpu = true;
  context.applyGroupVisibility();
  assert.equal(elements['system-row'].style.display, 'none');
});

test('Webview HTML loads split assets with a nonce and transports config without raw interpolation', async () => {
  const html = await getWebviewHtml({ initConfig: { unsafe: '\"><script>x</script>' }, nonce: 'test-nonce' });
  assert.match(html, /<style nonce="test-nonce">/);
  assert.match(html, /<script nonce="test-nonce">/);
  assert.match(html, /script-src 'nonce-test-nonce'/);
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /data-config="[A-Za-z0-9+/=]+"/);
  assert.match(html, /gpu-name-text-/);
  assert.match(html, /id="modal-scrollbar" aria-hidden="true" hidden/);
  assert.equal((html.match(/<script nonce="test-nonce">/g) || []).length, 1);
  assert.ok(html.indexOf('function applyGroupVisibility') < html.indexOf('function openModal'));
  assert.ok(html.indexOf('function openModal') < html.indexOf('function renderProcTable'));
  assert.doesNotThrow(() => new vm.Script(html.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/)[1]));
});

test('settings use content-sized controls and an overlay scrollbar', () => {
  const style = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview.css'), 'utf8');
  const script = readWebviewScript();
  const html = fs.readFileSync(path.join(__dirname, '..', 'src/view/webview-html.js'), 'utf8');
  assert.match(style, /\.setting-control\s*\{[^}]*flex:\s*0 0 auto;/);
  assert.match(style, /\.setting-control\.wide\s*\{[^}]*width:\s*55%;/);
  assert.match(style, /\.modal-body\s*\{[^}]*scrollbar-width:\s*none;/);
  assert.match(style, /\.modal-body::-webkit-scrollbar\s*\{[^}]*width:\s*0;/);
  assert.match(style, /\.modal-scrollbar\s*\{[^}]*position:\s*absolute;\s*right:\s*0;/);
  assert.match(style, /\.modal-scrollbar-thumb\s*\{[^}]*margin-right:\s*0;/);
  assert.doesNotMatch(style, /\.modal-body\s*\{[^}]*overscroll-behavior-y:/);
  assert.match(style, /\.sett-info-icon\s*\{[^}]*border:\s*0;/);
  assert.match(html, /id=\"sett-bar-info\"[^>]*>ⓘ<\/button>/);
  assert.match(script, /T\.diskExcludePath[^\n]*T\.diskExcludePathTip, true\)/);
  assert.match(script, /本地 Linux 窗口的状态栏显示本机；远程 Linux 窗口显示当前服务器/);
  assert.doesNotMatch(script, /今后连接 Remote-SSH/);

  const scrollbarCode = script.slice(script.indexOf("  var modalBody = document.getElementById('modal-body');"), script.indexOf('  function openModal()'));
  const body = { clientHeight: 100, scrollHeight: 400, scrollTop: 0, offsetTop: 30, addEventListener() {} };
  const handlers = {};
  const track = { hidden: true, style: {}, classList: { add() {}, remove() {} }, addEventListener(name, handler) { handlers[name] = handler; }, getBoundingClientRect: () => ({ top: 30, height: 100 }), setPointerCapture() {}, hasPointerCapture: () => false };
  const thumb = { style: {}, offsetHeight: 28, getBoundingClientRect: () => ({ top: 30, height: 28 }) };
  const elements = { 'modal-body': body, 'modal-scrollbar': track, 'modal-scrollbar-thumb': thumb };
  const context = { document: { getElementById: (id) => elements[id] }, window: { addEventListener() {} }, modalOpen: true };
  vm.runInNewContext(`${scrollbarCode}\nthis.updateModalScrollbar = updateModalScrollbar;`, context);
  context.updateModalScrollbar();
  assert.equal(track.hidden, false);
  assert.equal(track.style.top, '30px');
  assert.equal(track.style.height, '100px');
  assert.equal(thumb.style.height, '28px');
  body.scrollTop = 150;
  context.updateModalScrollbar();
  assert.equal(thumb.style.transform, 'translateY(36px)');
  handlers.pointerdown({ target: thumb, clientY: 35, pointerId: 1, preventDefault() {} });
  handlers.pointermove({ clientY: 71, pointerId: 1 });
  assert.equal(body.scrollTop, 150);
  handlers.pointerup({ pointerId: 1 });
  assert.doesNotMatch(scrollbarCode, /addEventListener\('wheel'|modalBounce|resetModalBounce/);
  body.scrollHeight = 100;
  context.updateModalScrollbar();
  assert.equal(track.hidden, true);
});

test('chart fill color follows the metric bar transition', () => {
  const style = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview.css'), 'utf8');
  const script = readWebviewScript();
  assert.match(style, /--metric-transition:\s*\.5s ease;/);
  assert.match(style, /\.spark-bg path\s*\{\s*transition:\s*fill var\(--metric-transition\);\s*\}/);
  assert.match(style, /\.fill\s*\{[^}]*transition:\s*width var\(--metric-transition\), background var\(--metric-transition\);/);
  assert.doesNotMatch(script, /spark-color-duration/);
});

test('GPU footer shows users with a compact info button or falls back to stats', () => {
  const style = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview.css'), 'utf8');
  const script = readWebviewScript();
  const footer = script.slice(script.indexOf('  function gpuStatsDescription('), script.indexOf('  var gpuInfoPopover ='));
  const line = { style: {}, dataset: {}, clientWidth: 180, scrollWidth: 100, children: [1], replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); } };
  const info = { style: {}, setAttribute(name, value) { this[name] = value; } };
  const stats = { style: {} };
  const elements = { 'gpu-users-0': line, 'gpu-info-0': info, 'gpu-stats-0': stats };
  const context = { document: { getElementById: (id) => elements[id], createElement: () => ({}) }, displayCfg: { showGpuUsers: true }, T: { tempLabel: '温度', pwLabel: '功耗' }, activeGpuInfoButton: null, activeDetailButton: null, hideGpuInfoPopover() {}, hideDetailPopover() {} };
  const colors = script.slice(script.indexOf('  function colorClass('), script.indexOf('  function setBar('));
  vm.runInNewContext(`${colors}\n${footer}\nthis.renderGpuUsers = renderGpuUsers; this.gpuStatsMarkup = gpuStatsMarkup;`, context);
  context.renderGpuUsers({ idx: 0, users: [] });
  assert.equal(line.style.display, 'none');
  assert.equal(info.style.display, 'none');
  assert.equal(stats.style.display, 'flex');
  assert.deepEqual(line.children, []);
  const gpu = { idx: 0, temp: 35, power: { draw: 100, limit: 250 }, users: [{ name: 'alice', usedStr: '5.0G', percent: 10 }] };
  context.renderGpuUsers(gpu);
  assert.equal(line.style.display, 'flex');
  assert.equal(info.style.display, 'inline-flex');
  assert.equal(stats.style.display, 'none');
  assert.equal(info['aria-label'], '温度 35°C · 功耗 100/250W');
  assert.equal(info.title, undefined);
  assert.equal(line.children[0].textContent, 'alice (5.0G)');
  context.renderGpuUsers({ ...gpu, users: [{ name: 'alice', usedStr: '71.8G', percent: 90 }] });
  assert.equal(line.children[0].className, 'gpu-user tag-danger');
  assert.match(context.gpuStatsMarkup({ ...gpu, temp: 36 }), /36°C/);
  assert.match(context.gpuStatsMarkup(gpu), /100\/250W/);
  const restoredChip = line.children[0];
  line.clientWidth = 0;
  context.renderGpuUsers(gpu);
  assert.equal(line.children[0], restoredChip);
  line.clientWidth = 180;
  context.displayCfg.showGpuUsers = false;
  context.renderGpuUsers(gpu);
  assert.equal(line.style.display, 'none');
  assert.equal(stats.style.display, 'flex');
  assert.match(style, /\.gpu-footer\s*\{[^}]*min-height:\s*18px;/);
  assert.match(style, /\.gpu-stats\s*\{[^}]*flex:\s*1 1 auto;[^}]*height:\s*18px;/);
  assert.match(style, /\.gpu-stats\s*\{[^}]*gap:\s*12px;/);
  assert.match(style, /\.gpu-users\s*\{[^}]*font-size:\s*9px;/);
  assert.match(style, /\.gpu-user\s*\{[^}]*height:\s*14px;/);
  assert.match(style, /\.gpu-info\s*\{[^}]*border:\s*0;[^}]*opacity:\s*\.55;/);
  assert.match(style, /\.gpu-info-popover\s*\{[^}]*position:\s*fixed;/);
  assert.match(script, /class="gpu-info"[^>]*>ⓘ<\/button>/);
  assert.doesNotMatch(script, /class="gpu-info"[^>]*title=/);
  assert.match(script, /button\.addEventListener\('mouseenter', function\(\) \{ showGpuInfoPopover\(button\); \}\)/);
  assert.ok(script.indexOf('class="gpu-users" id="gpu-users-') < script.indexOf('class="gpu-stats" id="gpu-stats-'));
  assert.ok(script.indexOf('class="gpu-stats" id="gpu-stats-') < script.indexOf('class="gpu-info"'));
  assert.match(script, /statsElement\.innerHTML = gpuStatsMarkup\(g\)/);
});

test('GPU cards share the CPU and RAM wrap basis and hide footer labels only on overflow', () => {
  const style = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview.css'), 'utf8');
  const script = readWebviewScript();
  assert.match(style, /--card-min-width: 150px;/);
  assert.match(style, /\.net-ssh-row > \.card \{ flex: 1 1 var\(--card-min-width\);/);
  assert.match(style, /\.gpu-mini \{ flex: 1 1 var\(--card-min-width\);/);
  assert.match(style, /\.gpu-stats\.compact \.gpu-stat-label \{ display: none; \}/);
  assert.match(script, /class="gpu-stat-label"/);
  assert.doesNotMatch(script, /updateGpuCardBasis/);
  const helper = script.slice(script.indexOf('  function updateGpuStatsFit('), script.indexOf('  function renderGpuUsers('));
  let available = 150, required = 140, compact = null;
  const stats = {
    style: { display: 'flex' }, innerHTML: '<span>温度 35°C</span><span>功耗 42/250W</span>',
    getBoundingClientRect: () => ({ width: available }),
    classList: { toggle(name, value) { assert.equal(name, 'compact'); compact = value; } },
  };
  const measure = {
    setAttribute() {}, getBoundingClientRect: () => ({ width: required }), remove() {},
  };
  const context = {
    document: { querySelectorAll: () => [stats], createElement: () => measure, body: { appendChild() {} } },
    window: { addEventListener() {} },
  };
  vm.runInNewContext(`${helper}\nthis.updateGpuStatsFit = updateGpuStatsFit;`, context);
  context.updateGpuStatsFit();
  assert.equal(compact, false);
  available = 130;
  context.updateGpuStatsFit();
  assert.equal(compact, true);
  available = 150;
  context.updateGpuStatsFit();
  assert.equal(compact, false);
});

test('GPU info appears immediately and refreshes while hovered', () => {
  const script = readWebviewScript();
  const popoverCode = script.slice(script.indexOf('  var gpuInfoPopover ='), script.indexOf("  window.addEventListener('resize'"));
  const popover = { style: {}, hidden: true, offsetWidth: 150, offsetHeight: 20 };
  const button = { dataset: { gpuInfo: '0' }, style: { display: 'inline-flex' }, isConnected: true, getClientRects: () => [{}], getBoundingClientRect: () => ({ right: 180, top: 100, bottom: 114 }) };
  const gpu = { idx: 0, temp: 35 };
  const context = {
    document: { createElement: () => popover, body: { appendChild() {} } },
    window: { innerWidth: 300 },
    lastGpuPayload: [gpu],
    gpuStatsDescription: (device) => `温度 ${device.temp}°C`,
  };
  vm.runInNewContext(`${popoverCode}\nthis.show = showGpuInfoPopover; this.hide = hideGpuInfoPopover; this.refresh = refreshGpuInfoPopover; this.popover = gpuInfoPopover;`, context);
  context.show(button);
  assert.equal(popover.hidden, false);
  assert.equal(popover.textContent, '温度 35°C');
  assert.equal(popover.style.left, '30px');
  assert.equal(popover.style.top, '74px');
  gpu.temp = 36;
  context.refresh();
  assert.equal(popover.textContent, '温度 36°C');
  context.hide(button);
  assert.equal(popover.hidden, true);
});

test('GPU overflow reveals hidden users as stacked threshold-colored capsules', () => {
  const script = readWebviewScript();
  const footer = script.slice(script.indexOf('  function gpuStatsDescription('), script.indexOf('  var gpuInfoPopover ='));
  const colors = script.slice(script.indexOf('  function colorClass('), script.indexOf('  function setBar('));
  const line = {
    dataset: {}, style: {}, clientWidth: 85, children: [],
    get scrollWidth() { return this.children.reduce((sum, child) => sum + child.textContent.length * 5, 0) + Math.max(0, this.children.length - 1) * 4; },
    replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); },
  };
  const info = { style: {}, setAttribute() {} };
  const stats = { style: {} };
  const elements = { 'gpu-users-0': line, 'gpu-info-0': info, 'gpu-stats-0': stats };
  let tooltipRefreshes = 0;
  const context = {
    document: { getElementById: (id) => elements[id], createElement: () => ({ dataset: {} }) },
    displayCfg: { showGpuUsers: true }, T: { tempLabel: 'Temp', pwLabel: 'Power' },
    activeDetailButton: null, bindDetailPopoverButton(button) { button.bound = true; }, hideDetailPopover() {}, refreshDetailPopover() { tooltipRefreshes++; },
  };
  vm.runInNewContext(`${colors}\n${footer}\nthis.renderGpuUsers = renderGpuUsers;`, context);
  context.renderGpuUsers({ idx: 0, users: [
    { name: 'alice', usedStr: '5.0G', percent: 6 },
    { name: 'bob', usedStr: '72.0G', percent: 90 },
  ] });
  assert.equal(line.children[0].className, 'gpu-user tag-accent');
  const more = line.children[1];
  assert.equal(more.textContent, '(+1)');
  assert.equal(more.dataset.gpuMoreStart, '1');
  assert.equal(more.bound, true);
  context.renderGpuUsers({ idx: 0, users: [
    { name: 'alice', usedStr: '5.0G', percent: 6 },
    { name: 'bob', usedStr: '72.0G', percent: 90 },
  ] });
  assert.equal(line.children[1], more);
  context.activeDetailButton = more;
  context.renderGpuUsers({ idx: 0, users: [
    { name: 'alice', usedStr: '5.0G', percent: 6 },
    { name: 'bob', usedStr: '72.1G', percent: 90 },
  ] });
  assert.equal(line.children[1], more);
  assert.equal(tooltipRefreshes, 1);

  const detailCode = script.slice(script.indexOf('  var detailPopover ='), script.indexOf('  function applyCharts()'));
  const popover = {
    style: {}, hidden: true, offsetWidth: 120, offsetHeight: 30, children: [],
    classList: { names: new Set(), add(name) { this.names.add(name); }, remove(name) { this.names.delete(name); } },
    replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); },
  };
  const handlers = {};
  const button = {
    dataset: { gpuMore: '0', gpuMoreStart: '1' }, style: {}, isConnected: true,
    getClientRects: () => [{}], getBoundingClientRect: () => ({ left: 166, width: 14, right: 180, top: 100, bottom: 114 }),
    addEventListener(name, handler) { handlers[name] = handler; },
  };
  const detailContext = {
    document: { createElement: (tag) => tag === 'div' ? popover : {}, body: { appendChild() {} } },
    window: { innerWidth: 300, innerHeight: 200, addEventListener() {} },
    lastGpuPayload: [{ idx: 0, users: [{ name: 'alice', usedStr: '5.0G', percent: 6 }, { name: 'bob', usedStr: '72.0G', percent: 90 }] }],
    lastDiskPayload: [], T: { diskReserved: '预留', used: '已用', avail: '可用', total: '总计' },
  };
  vm.runInNewContext(`${colors}\n${detailCode}\nthis.bind = bindDetailPopoverButton; this.refresh = refreshDetailPopover;`, detailContext);
  detailContext.bind(button);
  handlers.mouseenter();
  assert.equal(popover.hidden, false);
  assert.equal(popover.style.left, '113px');
  assert.equal(popover.children[0].textContent, 'bob (72.0G)');
  assert.equal(popover.children[0].className, 'gpu-user tag-danger');
  handlers.mouseleave();
  assert.equal(popover.hidden, true);

  detailContext.lastDiskPayload = [{ pct: 75, reservedStr: '5.0G', usedStr: '70.0G', availableStr: '25.0G', totalStr: '100.0G' }];
  button.dataset = { diskInfo: '0' };
  handlers.mouseenter();
  assert.equal(popover.hidden, false);
  assert.equal(popover.style.left, '60px');
  assert.equal(popover.classList.names.has('disk-breakdown'), true);
  assert.deepEqual(popover.children.map((child) => child.textContent), ['预留', '5.0G', '已用', '70.0G', '可用', '25.0G', '总计', '100.0G']);
  detailContext.lastDiskPayload[0].availableStr = '24.0G';
  detailContext.refresh();
  assert.equal(popover.children[5].textContent, '24.0G');
  detailContext.lastDiskPayload = [];
  detailContext.refresh();
  assert.equal(popover.hidden, true);
});

test('disk always shows a rightmost breakdown trigger and reserved-first segments', () => {
  const performanceScript = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview-performance.js'), 'utf8');
  const renderCode = performanceScript.slice(performanceScript.indexOf('  function diskBreakdownDescription('));
  const style = fs.readFileSync(path.join(__dirname, '..', 'src/view/assets/webview.css'), 'utf8');
  const card = { style: {} };
  const body = { innerHTML: '', querySelectorAll: () => [] };
  const segments = { 'disk-reserved-0': { style: {} }, 'disk-fill-0': { style: {} } };
  const context = {
    document: { getElementById: (id) => id === 'disk-card' ? card : id === 'disk-body' ? body : segments[id] },
    renderedDiskKeys: [], lastDiskPayload: [], renderGeneration: 0, T: { diskReserved: '预留', used: '已用', avail: '可用', total: '总计' },
    colorClass: (pct) => pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '',
    esc: (value) => value, bindDetailPopoverButton() {}, requestAnimationFrame(callback) { callback(); }, refreshDetailPopover() {},
  };
  vm.runInNewContext(`${renderCode}\nthis.renderDisk = renderDisk; this.updateDiskBar = updateDiskBar;`, context);
  context.renderDisk([{ mount: '/data', occupiedStr: '75.0G', reservedStr: '5.0G', usedStr: '70.0G', availableStr: '25.0G', totalStr: '100.0G', reservedPct: 5, occupiedPct: 75, pct: 75 }]);
  assert.match(body.innerHTML, /disk-mount[^>]*>\/data<\/span><button class="disk-alert disk-header-alert"[^>]*>ⓘ<\/button><span class="disk-info"><span class="disk-meta"[^>]*>75\.0G \/ 100\.0G<\/span><span class="disk-usage-wrap"><span class="disk-pct warn"[^>]*>75%<\/span><button class="disk-alert"/);
  assert.equal((body.innerHTML.match(/class="disk-alert(?: disk-header-alert)?"/g) || []).length, 2);
  assert.doesNotMatch(body.innerHTML, /style="display:none"/);
  assert.match(body.innerHTML, /disk-track"><div class="fill warn"[^>]*><\/div><div class="disk-reserved"/);
  assert.equal(segments['disk-reserved-0'].style.width, '5%');
  assert.equal(segments['disk-fill-0'].style.width, '75%');
  context.updateDiskBar({ reservedPct: 0.1, occupiedPct: 70.1, pct: 70 }, 0);
  assert.equal(segments['disk-reserved-0'].style.width, '0.1%');
  assert.equal(segments['disk-fill-0'].style.width, '70.1%');
  context.updateDiskBar({ reservedPct: 40, occupiedPct: 40.1, pct: 40 }, 0);
  assert.equal(segments['disk-reserved-0'].style.width, '40%');
  assert.equal(segments['disk-fill-0'].style.width, '40.1%');
  assert.match(style, /\.gpu-info-popover\s*\{[^}]*padding:\s*5px;/);
  assert.match(style, /\.disk-track\s*\{[^}]*position:\s*relative;/);
  assert.match(style, /\.disk-reserved\s*\{[^}]*position:\s*absolute;[^}]*background:\s*var\(--muted\);/);
  assert.match(style, /\.fill\s*\{[^}]*border-radius:\s*2px;/);
  assert.match(style, /\.detail-popover\.disk-breakdown\s*\{[^}]*display:\s*grid;/);
  assert.match(style, /\.disk-breakdown-value\s*\{[^}]*text-align:\s*right;/);
  assert.match(style, /\.disk-alert\s*\{[^}]*cursor:\s*default;/);
  assert.match(style.slice(style.indexOf('@container (max-width: 200px)'), style.indexOf('  .gpu-mini')), /\.disk-header-alert\s*\{\s*display:\s*inline-flex;/);
  assert.match(style, /\.gpu-user-more\s*\{[^}]*cursor:\s*default;/);
  context.renderDisk([{ mount: '/other', occupiedStr: '70.0G', reservedStr: '0.0K', usedStr: '70.0G', availableStr: '30.0G', totalStr: '100.0G', reservedPct: 0, occupiedPct: 70, pct: 70 }]);
  assert.match(body.innerHTML, /class="track disk-track"/);
});

test('returning to the performance tab redraws GPU user capsules', () => {
  const script = readWebviewScript();
  const switchTab = script.slice(script.indexOf('  function switchTab('), script.indexOf("  document.getElementById('tab-perf-btn').addEventListener"));
  const elements = { 'tab-perf': { classList: { add() {}, remove() {} } }, 'tab-proc': { classList: { add() {}, remove() {} } }, 'tab-perf-btn': { classList: { toggle() {} } }, 'tab-proc-btn': { classList: { toggle() {} } } };
  const rendered = [];
  let scheduled;
  const context = {
    document: { querySelectorAll: () => [elements['tab-perf'], elements['tab-proc']], getElementById: (id) => elements[id] },
    requestAnimationFrame: (callback) => { scheduled = callback; },
    lastGpuPayload: [{ idx: 0 }],
    renderGpuUsers: (gpu) => rendered.push(gpu.idx),
    updateResponsiveLayout() {},
  };
  vm.runInNewContext(`${switchTab}\nthis.switchTab = switchTab;`, context);
  context.switchTab('perf');
  assert.equal(typeof scheduled, 'function');
  scheduled();
  assert.deepEqual(rendered, [0]);
});
