import { state } from "./state.mjs";
import { copyText, sendToExtension, tagColorClass, tr } from "./ui.mjs";
import { TO_EXTENSION } from "./protocol.mjs";
import { LOCAL_DEVICE_ID } from "./device-id.mjs";

const PROCESS_ROW_LIMIT = 100;
const PROCESS_DISPLAY_MODES = { cpu: ['core', 'whole', 'both'], ram: ['size', 'percent', 'both'] };
const PROCESS_SORTS = ['cpu', 'mem', 'gpu'];

let switchPage, bindInfoButton, refreshInfoPopover, renderedRevision, renderedHeader, hintDismissed, hintShown, tableStale;
let processPage, processCount, processTable, footnote, footnoteText, footnoteInfo;

function normalizeProcessDisplay(display) {
  const source = display && typeof display === 'object' ? display : {};
  return {
    cpu: PROCESS_DISPLAY_MODES.cpu.includes(source.cpu) ? source.cpu : 'core',
    ram: PROCESS_DISPLAY_MODES.ram.includes(source.ram) ? source.ram : 'size',
    expandName: source.expandName === true,
    expandCmd: source.expandCmd === true,
  };
}

export function resetProcessView() {
  renderedRevision = null;
  tableStale = false;
  state.ui.processMenu?.remove();
  state.ui.processMenu = null;
  state.ui.pendingProcesses = null;
  state.data.processes = [];
  state.ui.visibleProcesses = [];
  processTable.replaceChildren();
  processCount.textContent = '--';
  renderFootnote(null);
}

export function renderProcessSnapshot(viewModel) {
  const gpuEnabled = viewModel.sources?.accelerators?.state !== 'disabled';
  if (state.ui.gpuProcessesEnabled !== gpuEnabled) {
    state.ui.gpuProcessesEnabled = gpuEnabled;
    if (!gpuEnabled && state.ui.sort === 'gpu') state.ui.sort = 'cpu';
    renderProcToolbar();
  }
  const revision = [state.ui.deviceId, viewModel.processRevision, gpuEnabled, state.data.status?.processesReady].join(':');
  if (viewModel.processRevision !== undefined && revision === renderedRevision) return;
  renderedRevision = revision;
  if (state.ui.processMenu) {
    state.ui.pendingProcesses = viewModel.processes || [];
    return;
  }
  state.data.processes = viewModel.processes || [];
  refreshProcTable();
}

export function focusGpuProcesses(index) {
  state.ui.sort = 'gpu';
  state.ui.search = 'gpu' + index;
  state.elements.filterInput.value = 'GPU' + index;
  state.elements.filterWrap.classList.add('has-text');
  storeProcessView();
  switchPage('proc');
  renderProcToolbar();
  renderProcTable();
}

export function showProcessPage() {
  if (tableStale) renderProcTable();
}

function refreshProcTable() {
  if (processPage.classList.contains('active')) renderProcTable();
  else tableStale = true;
}

function storeProcessView() {
  state.bridge.setState(Object.assign({}, state.bridge.getState() || {}, { processView: { search: state.elements.filterInput.value, sort: state.ui.sort } }));
}

function restoreProcessView() {
  const saved = (state.bridge.getState() || {}).processView || {};
  if (PROCESS_SORTS.includes(saved.sort)) state.ui.sort = saved.sort;
  if (typeof saved.search === 'string' && saved.search) {
    state.elements.filterInput.value = saved.search;
    state.ui.search = saved.search.toLowerCase();
    state.elements.filterWrap.classList.add('has-text');
  }
}

function renderProcToolbar() {
    var tb = document.getElementById('proc-toolbar');
    tb.innerHTML = '<button class="sb'+(state.ui.sort==='cpu'?' on':'')+'" data-s="cpu">CPU</button>'
      +'<button class="sb'+(state.ui.sort==='mem'?' on':'')+'" data-s="mem">RAM</button>'
      +(state.ui.gpuProcessesEnabled === false ? '' : '<button class="sb'+(state.ui.sort==='gpu'?' on':'')+'" data-s="gpu">GPU</button>');
    tb.querySelectorAll('.sb').forEach(function(b){
      b.addEventListener('click',function(){
        state.ui.sort=this.dataset.s;
        storeProcessView();
        renderProcToolbar();
        renderProcTable();
      });
    });
  }

function esc(s){return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}

function sessionLabel(session, expanded) {
  return expanded ? session.type + ': ' + session.name : session.type;
}

function processNameTitle(p) {
  return 'PID ' + p.pid + (p.session ? '  ' + sessionLabel(p.session, true) : '') + '\n' + (p.cmd || p.name);
}

function procSearchStr(p) {
    var s = p.name.toLowerCase() + ' ' + p.user.toLowerCase() + ' ' + (p.cmd||'').toLowerCase() + ' ' + p.pid;
    if (p.gpus && p.gpus.length) {
      p.gpus.forEach(function(g){ s += ' gpu'+g.idx + ' gpu '+g.idx + ' #'+g.idx; });
    }
    if (p.session) s += ' ' + sessionLabel(p.session, true).toLowerCase();
    return s;
  }

export function selectProcessRows(processes, sort, search = '') {
    const filtered = search ? processes.filter(process => procSearchStr(process).includes(search)) : processes;
    const metric = sort === 'cpu' ? 'cpu' : sort === 'mem' ? 'mem' : 'vram';
    const sorted = filtered.slice().sort((a, b) => (b[metric] || 0) - (a[metric] || 0) || a.pid - b.pid);
    return { rows: sorted.slice(0, PROCESS_ROW_LIMIT), matchedCount: filtered.length };
}

function processFootnote({ total, candidates, matched, searching }, translate = tr) {
  const incomplete = candidates < total;
  if (!searching) return total > PROCESS_ROW_LIMIT ? { text: translate('processListLimited', { limit: PROCESS_ROW_LIMIT }), incomplete } : null;
  return { text: translate('processSearchSummary', { candidates, matched, limit: PROCESS_ROW_LIMIT, truncated: matched > PROCESS_ROW_LIMIT, incomplete }), incomplete };
}

function cpuText(p, display) {
  var coreDisplay = p.cpu.toFixed(1) + '%';
  var wholeDisplay = (p.cpuWhole || 0).toFixed(1) + '%';
  if (display.cpu === 'both') return { html: '<span class="dual-value"><span>'+coreDisplay+'</span><span>'+wholeDisplay+'</span></span>', copy: tr('coreMode')+' '+coreDisplay+' / '+tr('wholeMode')+' '+wholeDisplay };
  var single = display.cpu === 'whole' ? wholeDisplay : coreDisplay;
  return { html: single, copy: single };
}

function ramText(p, display) {
  var ramSize = p.memStr || '—';
  var ramPercent = p.memPct.toFixed(1) + '%';
  if (display.ram === 'both') return { html: '<span class="dual-value"><span>'+esc(ramSize)+'</span><span>'+ramPercent+'</span></span>', copy: tr('sizeMode')+' '+ramSize+' / '+tr('percentMode')+' '+ramPercent };
  var single = display.ram === 'percent' ? ramPercent : ramSize;
  return { html: esc(single), copy: single };
}

function gpuTags(p) {
  return (p.gpus || []).map(function(g) {
    var vTxt = g.vramStr || '—';
    var tTxt = g.memTotalStr || '—';
    var pct = g.pct;
    var cls = g.mappingStatus === 'unmatched' ? ' tag-unknown' : ' ' + tagColorClass(pct);
    return { className: 'gpu-tag' + cls, text: '#' + g.idx + ' ' + vTxt + '/' + tTxt + ' ' + (Number.isFinite(pct) ? pct + '%' : '—') };
  });
}

function processCopyValues(p, display, gpuEnabled) {
  const tags = gpuTags(p);
  return [String(p.pid), p.name, p.user, cpuText(p, display).copy, ramText(p, display).copy,
    ...(gpuEnabled ? [tags.length ? tags.map(tag => tag.text).join(' ') : tr('pnoGpu')] : []),
    p.cmd || p.name];
}

function processRowHtml(p, index, display, gpuEnabled) {
  var tags = gpuTags(p);
  var gpuCell = tags.length ? tags.map(function(tag) { return '<span class="'+tag.className+'">'+esc(tag.text)+'</span>'; }).join(' ') : '<span class="pmuted">'+tr('pnoGpu')+'</span>';
  var session = p.session ? '<button type="button" class="session-tag">'+esc(sessionLabel(p.session, display.expandName))+'</button>' : '';
  var cmdFull = p.cmd || p.name;
  return '<tr data-index="'+index+'">'
    +'<td class="r">'+p.pid+'</td>'
    +'<td class="expandable'+(display.expandName?' expanded':'')+'" title="'+esc(processNameTitle(p)).replace(/\n/g, '&#10;')+'">'+session+esc(p.name)+'</td>'
    +'<td>'+esc(p.user)+'</td>'
    +'<td>'+cpuText(p, display).html+'</td>'
    +'<td>'+ramText(p, display).html+'</td>'
    +(gpuEnabled ? '<td class="gpu-cell">'+gpuCell+'</td>' : '')
    +'<td class="expandable'+(display.expandCmd?' expanded':'')+'" title="'+esc(cmdFull)+'">'+esc(cmdFull)+'</td>'
    +'</tr>';
}

function renderProcHeader(display, gpuEnabled) {
  const key = [display.cpu, display.ram, display.expandName, display.expandCmd, gpuEnabled].join(':');
  if (key === renderedHeader) return;
  renderedHeader = key;
  var cpuModeLabel = display.cpu === 'whole' ? tr('wholeMode') : display.cpu === 'both' ? tr('cpuBothMode') : tr('coreMode');
  var ramModeLabel = display.ram === 'percent' ? tr('percentMode') : display.ram === 'both' ? tr('ramBothMode') : tr('sizeMode');
  document.getElementById('proc-hdr').innerHTML =
    '<th class="r">PID</th>'
    + '<th><span class="hdr-label">'+tr('pname')+'<button type="button" class="hdr-btn" data-hdr="name">'+(display.expandName?tr('collapse'):tr('expand'))+'</button></span></th>'
    + '<th>'+tr('puser')+'</th>'
    + '<th><span class="hdr-label">CPU<button type="button" class="hdr-btn" data-hdr="cpu" title="'+cpuModeLabel+'">'+cpuModeLabel+'</button></span></th>'
    + '<th><span class="hdr-label">RAM<button type="button" class="hdr-btn" data-hdr="ram" title="'+ramModeLabel+'">'+ramModeLabel+'</button></span></th>'
    + (gpuEnabled ? '<th>GPU</th>' : '')
    + '<th><span class="hdr-label">'+tr('pcmd')+'<button type="button" class="hdr-btn" data-hdr="cmd">'+(display.expandCmd?tr('collapse'):tr('expand'))+'</button></span></th>';
}

function renderFootnote(note) {
  footnote.hidden = !note;
  footnoteText.textContent = note ? note.text : '';
  footnoteText.title = note ? note.text : '';
  footnoteInfo.hidden = !note || !note.incomplete;
  refreshInfoPopover();
}

function renderProcTable() {
  tableStale = false;
  const display = state.ui.processDisplay;
  const gpuEnabled = state.ui.gpuProcessesEnabled !== false;
  const ready = !(state.data.status && state.data.status.processesReady === false);
  const { rows, matchedCount } = selectProcessRows(state.data.processes, state.ui.sort, state.ui.search);
  const total = state.data.viewModel?.processTotalCount ?? 0;
  processCount.textContent = ready ? state.locale.messages.pcount.replace('{n}', total) : '--';
  renderProcHeader(display, gpuEnabled);
  state.ui.visibleProcesses = rows;
  processTable.innerHTML = rows.map(function(p, index) { return processRowHtml(p, index, display, gpuEnabled); }).join('');
  renderFootnote(ready ? processFootnote({ total, candidates: state.data.processes.length, matched: matchedCount, searching: !!state.ui.search }) : null);
}

function removeCtxMenu() {
    if (state.ui.processMenu) { state.ui.processMenu.remove(); state.ui.processMenu = null; }
    if (state.ui.pendingProcesses) { state.data.processes = state.ui.pendingProcesses; state.ui.pendingProcesses = null; refreshProcTable(); }
  }

function openSessionTerminal(p) {
  sendToExtension(TO_EXTENSION.openSessionTerminal, { deviceId: state.ui.deviceId || LOCAL_DEVICE_ID, pid: p.pid });
}

function menuItem(menu, label, action) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'ctx-menu-item';
  item.setAttribute('role', 'menuitem');
  item.textContent = label;
  item.addEventListener('click', function(event) {
    event.stopPropagation();
    action(item);
  });
  menu.appendChild(item);
}

function copyMenuItem(menu, label, text) {
  menuItem(menu, label, function(item) {
    copyText(text).then(function(copied) {
      if (copied) removeCtxMenu();
      else item.textContent = tr('copyFailed');
    });
  });
}

function showContextMenu(event, p, cellIndex) {
  removeCtxMenu();
  const values = processCopyValues(p, state.ui.processDisplay, state.ui.gpuProcessesEnabled !== false);
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  copyMenuItem(menu, tr('copyCell'), values[cellIndex] ?? '');
  copyMenuItem(menu, tr('copyPID'), String(p.pid));
  copyMenuItem(menu, tr('copyRow'), values.join('\t'));
  if (p.session) menuItem(menu, tr('openSessionInTerminal', { type: p.session.type }), function() {
    removeCtxMenu();
    openSessionTerminal(p);
  });
  menu.style.left = event.clientX + 'px';
  menu.style.top = event.clientY + 'px';
  document.body.appendChild(menu);
  state.ui.processMenu = menu;
  var rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 4) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 4) + 'px';
  menu.querySelector('button').focus();
}

function rowProcess(target) {
  const row = target.closest('tr[data-index]');
  return row ? state.ui.visibleProcesses[Number(row.dataset.index)] : null;
}

export function initializeProcesses({ switchPage: navigate, bindInfoButton: bindInfo, refreshInfoPopover: refreshInfo }) {
  switchPage = navigate;
  bindInfoButton = bindInfo;
  refreshInfoPopover = refreshInfo;
  renderedRevision = null;
  renderedHeader = null;
  tableStale = false;
  processPage = document.getElementById('tab-proc');
  processCount = document.getElementById('proc-count');
  processTable = document.getElementById('proc-tbody');
  footnote = document.getElementById('proc-footnote');
  footnoteText = document.getElementById('proc-footnote-text');
  footnoteInfo = document.getElementById('proc-footnote-info');
  bindInfoButton(footnoteInfo);
  state.ui.sort = 'cpu';
  state.data.processes = [];
  state.ui.visibleProcesses = [];
  state.ui.search = '';
  state.elements.filterInput = document.getElementById('proc-filter');
  state.elements.filterWrap = document.getElementById('filter-wrap');
  restoreProcessView();
  state.elements.filterInput.addEventListener('input',function(){
      state.ui.search = this.value.toLowerCase();
      state.elements.filterWrap.classList.toggle('has-text', this.value.length > 0);
      storeProcessView();
      renderProcTable();
    });
  hintDismissed = !!(state.bridge.getState() || {}).hintDismissed;
  hintShown = false;
  state.elements.filterInput.addEventListener('focus', function() {
      if (hintDismissed || hintShown) return;
      hintShown = true;
      var hint = document.getElementById('filter-hint');
      hint.innerHTML = tr("timesSearchByNameUserPIDCommandGPU");
      hint.classList.add('show');
      document.getElementById('hint-close').addEventListener('click', function() {
        hint.classList.remove('show');
        hintDismissed = true;
        state.bridge.setState(Object.assign({}, state.bridge.getState() || {}, { hintDismissed: true }));
      });
    });
  document.getElementById('filter-clear').addEventListener('click',function(){
      state.elements.filterInput.value = '';
      state.ui.search = '';
      state.elements.filterWrap.classList.remove('has-text');
      storeProcessView();
      renderProcTable();
      state.elements.filterInput.focus();
    });
  document.getElementById('proc-hdr').addEventListener('click', function(event) {
      var button = event.target.closest('[data-hdr]');
      if (!button) return;
      var key = button.dataset.hdr;
      var display = state.ui.processDisplay;
      if (key === 'name' || key === 'cmd') {
        var expandKey = key === 'name' ? 'expandName' : 'expandCmd';
        display[expandKey] = !display[expandKey];
        sendToExtension(TO_EXTENSION.setProcessDisplay, { key: expandKey, value: display[expandKey] });
      } else {
        var modes = PROCESS_DISPLAY_MODES[key];
        display[key] = modes[(modes.indexOf(display[key]) + 1) % modes.length];
        sendToExtension(TO_EXTENSION.setProcessDisplay, { key, value: display[key] });
      }
      renderProcTable();
    });
  renderProcToolbar();
  state.ui.processMenu = null;
  state.ui.pendingProcesses = null;
  document.addEventListener('click', removeCtxMenu);
  document.addEventListener('scroll', removeCtxMenu, true);
  document.addEventListener('keydown', function(event) { if (event.key === 'Escape' && state.ui.processMenu) removeCtxMenu(); });
  processTable.addEventListener('click', function(event) {
      if (!event.target.closest('.session-tag')) return;
      var p = rowProcess(event.target);
      if (p && p.session) openSessionTerminal(p);
    });
  processTable.addEventListener('contextmenu', function(event) {
      var cell = event.target.closest('td');
      var p = cell && rowProcess(cell);
      if (!p) return;
      event.preventDefault();
      showContextMenu(event, p, cell.cellIndex);
    });
}

export { esc, procSearchStr, normalizeProcessDisplay, refreshProcTable, sessionLabel, processNameTitle, processFootnote, processCopyValues };
