import { state } from './state.mjs';
import { copyText, element, sendToExtension, storedViewState, storeViewState, tagColorClass, tr } from './ui.mjs';
import { TO_EXTENSION } from './protocol.mjs';
import { LOCAL_DEVICE_ID } from './device-id.mjs';
import { closeMenu, createTooltip, isMenuOpen, openMenu } from './popover.mjs';

const PROCESS_ROW_LIMIT = 100;
const PROCESS_DISPLAY_MODES = { cpu: ['core', 'whole', 'both'], ram: ['size', 'percent', 'both'] };
const PROCESS_SORTS = ['cpu', 'mem', 'gpu'];
const PROCESS_MENU = 'process';

const freshTable = () => ({ revision: null, stale: false, processes: [], visible: [], pending: null });

let table = freshTable();
let display = normalizeProcessDisplay();
let sort = 'cpu';
let search = '';
let gpuProcessesEnabled;
let renderedHeader = null;
let hintDismissed = false;
let hintShown = false;
let footnoteTooltip;
// Table updates wait while a session tag is hovered or focused, or while the context menu is open.
const hold = { tagHover: false, tagFocus: false, menuReopening: false };
let processPage, processCount, processTable, footnote, footnoteText, footnoteInfo, filterInput, filterWrap;

function normalizeProcessDisplay(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    cpu: PROCESS_DISPLAY_MODES.cpu.includes(source.cpu) ? source.cpu : 'core',
    ram: PROCESS_DISPLAY_MODES.ram.includes(source.ram) ? source.ram : 'size',
    expandName: source.expandName === true,
    expandCmd: source.expandCmd === true,
  };
}

function storeProcessView() {
  storeViewState({ processView: { search: filterInput.value, sort } });
}

function setFilter(text, query) {
  filterInput.value = text;
  search = query;
  filterWrap.classList.toggle('has-text', text.length > 0);
}

function restoreProcessView() {
  const saved = storedViewState().processView || {};
  if (PROCESS_SORTS.includes(saved.sort)) sort = saved.sort;
  if (typeof saved.search === 'string' && saved.search) setFilter(saved.search, saved.search.toLowerCase());
}

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sessionLabel(session, expanded) {
  return expanded ? session.type + ': ' + session.name : session.type;
}

function processNameTitle(process) {
  return 'PID ' + process.pid + (process.session ? '  ' + sessionLabel(process.session, true) : '') + '\n' + (process.cmd || process.name);
}

function procSearchStr(process) {
  let text = process.name.toLowerCase() + ' ' + process.user.toLowerCase() + ' ' + (process.cmd || '').toLowerCase() + ' ' + process.pid;
  for (const gpu of process.gpus || []) text += ' gpu' + gpu.idx + ' gpu ' + gpu.idx + ' #' + gpu.idx;
  if (process.session) text += ' ' + sessionLabel(process.session, true).toLowerCase();
  return text;
}

// The top rows by the sort column, plus programs running in the user's tmux/screen sessions,
// which stay listed even when they rank below the limit.
export function selectProcessRows(processes, sortKey, query = '') {
  const filtered = query ? processes.filter((process) => procSearchStr(process).includes(query)) : processes;
  const metric = sortKey === 'cpu' ? 'cpu' : sortKey === 'mem' ? 'mem' : 'vram';
  const sorted = filtered.slice().sort((a, b) => (b[metric] || 0) - (a[metric] || 0) || a.pid - b.pid);
  const pinned = sorted.slice(PROCESS_ROW_LIMIT).filter((process) => process.session?.pinned);
  const rows = sorted.filter((process, index) => index < PROCESS_ROW_LIMIT || pinned.includes(process));
  return { rows, matchedCount: filtered.length, pinnedCount: pinned.length };
}

function processFootnote({ total, candidates, matched, searching, sessions = 0 }, translate = tr) {
  const incomplete = candidates < total;
  if (!searching) return total > PROCESS_ROW_LIMIT ? { text: translate('processListLimited', { limit: PROCESS_ROW_LIMIT, sessions }), incomplete } : null;
  return { text: translate('processSearchSummary', { candidates, matched, limit: PROCESS_ROW_LIMIT, truncated: matched > PROCESS_ROW_LIMIT, sessions, incomplete }), incomplete };
}

function dualValue(first, second) {
  return '<span class="dual-value"><span>' + first + '</span><span>' + second + '</span></span>';
}

function cpuText(process, mode) {
  const core = process.cpu.toFixed(1) + '%';
  const whole = (process.cpuWhole || 0).toFixed(1) + '%';
  if (mode.cpu === 'both') return { html: dualValue(core, whole), copy: tr('coreMode') + ' ' + core + ' / ' + tr('wholeMode') + ' ' + whole };
  const single = mode.cpu === 'whole' ? whole : core;
  return { html: single, copy: single };
}

function ramText(process, mode) {
  const size = process.memStr || '—';
  const percent = process.memPct.toFixed(1) + '%';
  if (mode.ram === 'both') return { html: dualValue(esc(size), percent), copy: tr('sizeMode') + ' ' + size + ' / ' + tr('percentMode') + ' ' + percent };
  const single = mode.ram === 'percent' ? percent : size;
  return { html: esc(single), copy: single };
}

function gpuTags(process) {
  return (process.gpus || []).map((usage) => {
    const percent = usage.pct;
    const colorClass = usage.mappingStatus === 'unmatched' ? ' tag-unknown' : ' ' + tagColorClass(percent);
    const text = '#' + usage.idx + ' ' + (usage.vramStr || '—') + '/' + (usage.memTotalStr || '—') + ' ' + (Number.isFinite(percent) ? percent + '%' : '—');
    return { className: 'gpu-tag' + colorClass, text };
  });
}

function processCopyValues(process, mode, gpuEnabled) {
  const tags = gpuTags(process);
  return [String(process.pid), process.name, process.user, cpuText(process, mode).copy, ramText(process, mode).copy,
    ...(gpuEnabled ? [tags.length ? tags.map((tag) => tag.text).join(' ') : tr('pnoGpu')] : []),
    process.cmd || process.name];
}

function processRowHtml(process, index, mode, gpuEnabled) {
  const tags = gpuTags(process);
  const gpuCell = tags.length
    ? tags.map((tag) => '<span class="' + tag.className + '">' + esc(tag.text) + '</span>').join(' ')
    : '<span class="pmuted">' + tr('pnoGpu') + '</span>';
  const session = process.session ? '<button type="button" class="session-tag">' + esc(sessionLabel(process.session, mode.expandName)) + '</button>' : '';
  const command = process.cmd || process.name;
  return '<tr data-index="' + index + '">'
    + '<td class="r">' + process.pid + '</td>'
    + '<td class="expandable' + (mode.expandName ? ' expanded' : '') + '" title="' + esc(processNameTitle(process)).replace(/\n/g, '&#10;') + '">' + session + esc(process.name) + '</td>'
    + '<td>' + esc(process.user) + '</td>'
    + '<td>' + cpuText(process, mode).html + '</td>'
    + '<td>' + ramText(process, mode).html + '</td>'
    + (gpuEnabled ? '<td class="gpu-cell">' + gpuCell + '</td>' : '')
    + '<td class="expandable' + (mode.expandCmd ? ' expanded' : '') + '" title="' + esc(command) + '">' + esc(command) + '</td>'
    + '</tr>';
}

function headerButton(key, label, title) {
  return '<button type="button" class="hdr-btn" data-hdr="' + key + '"' + (title ? ' title="' + title + '"' : '') + '>' + label + '</button>';
}

function renderProcHeader(mode, gpuEnabled) {
  const key = [mode.cpu, mode.ram, mode.expandName, mode.expandCmd, gpuEnabled].join(':');
  if (key === renderedHeader) return;
  renderedHeader = key;
  const cpuMode = mode.cpu === 'whole' ? tr('wholeMode') : mode.cpu === 'both' ? tr('cpuBothMode') : tr('coreMode');
  const ramMode = mode.ram === 'percent' ? tr('percentMode') : mode.ram === 'both' ? tr('ramBothMode') : tr('sizeMode');
  const expandLabel = (expanded) => (expanded ? tr('collapse') : tr('expand'));
  document.getElementById('proc-hdr').innerHTML = '<th class="r">PID</th>'
    + '<th><span class="hdr-label">' + tr('pname') + headerButton('name', expandLabel(mode.expandName)) + '</span></th>'
    + '<th>' + tr('puser') + '</th>'
    + '<th><span class="hdr-label">CPU' + headerButton('cpu', cpuMode, cpuMode) + '</span></th>'
    + '<th><span class="hdr-label">RAM' + headerButton('ram', ramMode, ramMode) + '</span></th>'
    + (gpuEnabled ? '<th>GPU</th>' : '')
    + '<th><span class="hdr-label">' + tr('pcmd') + headerButton('cmd', expandLabel(mode.expandCmd)) + '</span></th>';
}

function renderProcToolbar() {
  const toolbar = document.getElementById('proc-toolbar');
  const sortButton = (key, label) => '<button class="sb' + (sort === key ? ' on' : '') + '" data-s="' + key + '">' + label + '</button>';
  toolbar.innerHTML = sortButton('cpu', 'CPU') + sortButton('mem', 'RAM') + (gpuProcessesEnabled === false ? '' : sortButton('gpu', 'GPU'));
  toolbar.querySelectorAll('.sb').forEach((button) => {
    button.addEventListener('click', () => {
      sort = button.dataset.s;
      storeProcessView();
      renderProcToolbar();
      renderProcTable();
    });
  });
}

function renderFootnote(note) {
  footnote.hidden = !note;
  footnoteText.textContent = note ? note.text : '';
  footnoteText.title = note ? note.text : '';
  footnoteInfo.hidden = !note || !note.incomplete;
  footnoteTooltip.refresh();
}

function focusedSessionPid() {
  const active = document.activeElement;
  if (!active || !active.classList || !active.classList.contains('session-tag') || !processTable.contains(active)) return null;
  const row = active.closest('tr');
  const process = row ? table.visible[Number(row.dataset.index)] : null;
  return process ? process.pid : null;
}

function restoreSessionFocus(pid) {
  if (pid === null) return;
  const index = table.visible.findIndex((process) => process.pid === pid && process.session);
  if (index < 0) return;
  const button = processTable.querySelector('tr[data-index="' + index + '"] .session-tag');
  if (button) button.focus();
}

function renderProcTable() {
  table.stale = false;
  const gpuEnabled = gpuProcessesEnabled !== false;
  const ready = state.data.status?.processesReady !== false;
  const { rows, matchedCount, pinnedCount } = selectProcessRows(table.processes, sort, search);
  const total = state.data.viewModel?.processTotalCount ?? 0;
  processCount.textContent = ready ? tr('processCount', { count: total }) : '--';
  renderProcHeader(display, gpuEnabled);
  const focusedPid = focusedSessionPid();
  table.visible = rows;
  processTable.innerHTML = rows.map((process, index) => processRowHtml(process, index, display, gpuEnabled)).join('');
  restoreSessionFocus(focusedPid);
  renderFootnote(ready ? processFootnote({ total, candidates: table.processes.length, matched: matchedCount, searching: !!search, sessions: pinnedCount }) : null);
}

function refreshProcTable() {
  if (processPage.classList.contains('active')) renderProcTable();
  else table.stale = true;
}

function holdingUpdates() {
  return hold.tagHover || hold.tagFocus || isMenuOpen(PROCESS_MENU);
}

function applyPendingProcesses() {
  if (!table.pending || holdingUpdates()) return;
  table.processes = table.pending;
  table.pending = null;
  refreshProcTable();
}

function openSessionTerminal(process) {
  sendToExtension(TO_EXTENSION.openSessionTerminal, { deviceId: state.ui.deviceId || LOCAL_DEVICE_ID, pid: process.pid });
}

function menuItem(label, action) {
  const item = element('button', 'popup-menu-item ctx-menu-item', label);
  item.type = 'button';
  item.setAttribute('role', 'menuitem');
  item.addEventListener('click', (event) => {
    event.stopPropagation();
    action(item);
  });
  return item;
}

function copyMenuItem(label, text) {
  return menuItem(label, (item) => {
    copyText(text).then((copied) => {
      if (copied) closeMenu(PROCESS_MENU);
      else item.textContent = tr('copyFailed');
    });
  });
}

function showContextMenu(event, process, cellIndex) {
  hold.menuReopening = true;
  closeMenu(PROCESS_MENU);
  hold.menuReopening = false;
  const values = processCopyValues(process, display, gpuProcessesEnabled !== false);
  const menu = element('div', 'popup-menu ctx-menu');
  menu.setAttribute('role', 'menu');
  menu.append(copyMenuItem(tr('copyCell'), values[cellIndex] ?? ''), copyMenuItem(tr('copyPID'), String(process.pid)), copyMenuItem(tr('copyRow'), values.join('\t')));
  if (process.session) {
    menu.append(menuItem(tr('openSessionInTerminal', { type: process.session.type }), () => {
      closeMenu(PROCESS_MENU);
      openSessionTerminal(process);
    }));
  }
  openMenu({ owner: PROCESS_MENU, content: menu, point: { x: event.clientX, y: event.clientY }, focusFirst: true,
    closeOnScroll: document, onClose: () => { if (!hold.menuReopening) applyPendingProcesses(); } });
}

function rowProcess(target) {
  const row = target.closest('tr[data-index]');
  return row ? table.visible[Number(row.dataset.index)] : null;
}

function toggleHeaderMode(key) {
  if (key === 'name' || key === 'cmd') {
    const expandKey = key === 'name' ? 'expandName' : 'expandCmd';
    display[expandKey] = !display[expandKey];
    sendToExtension(TO_EXTENSION.setProcessDisplay, { key: expandKey, value: display[expandKey] });
  } else {
    const modes = PROCESS_DISPLAY_MODES[key];
    display[key] = modes[(modes.indexOf(display[key]) + 1) % modes.length];
    sendToExtension(TO_EXTENSION.setProcessDisplay, { key, value: display[key] });
  }
  renderProcTable();
}

export function renderProcessSnapshot(viewModel) {
  const gpuEnabled = viewModel.sources?.accelerators?.state !== 'disabled';
  if (gpuProcessesEnabled !== gpuEnabled) {
    gpuProcessesEnabled = gpuEnabled;
    if (!gpuEnabled && sort === 'gpu') sort = 'cpu';
    renderProcToolbar();
  }
  const revision = [state.ui.deviceId, viewModel.processRevision, gpuEnabled, state.data.status?.processesReady].join(':');
  if (viewModel.processRevision !== undefined && revision === table.revision) return;
  table.revision = revision;
  if (holdingUpdates()) {
    table.pending = viewModel.processes || [];
    return;
  }
  table.processes = viewModel.processes || [];
  refreshProcTable();
}

export function setProcessDisplay(value) {
  display = normalizeProcessDisplay(value);
  refreshProcTable();
}

export function focusGpuProcesses(index) {
  sort = 'gpu';
  setFilter('GPU' + index, 'gpu' + index);
  storeProcessView();
  renderProcToolbar();
  refreshProcTable();
}

export function showProcessPage() {
  if (table.stale) renderProcTable();
}

export function resetProcessView() {
  table.pending = null;
  hold.tagHover = false;
  hold.tagFocus = false;
  closeMenu(PROCESS_MENU);
  table = freshTable();
  processTable.replaceChildren();
  processCount.textContent = '--';
  renderFootnote(null);
}

export function initializeProcesses() {
  display = normalizeProcessDisplay(state.initial.processDisplay);
  processPage = document.getElementById('tab-proc');
  processCount = document.getElementById('proc-count');
  processTable = document.getElementById('proc-tbody');
  footnote = document.getElementById('proc-footnote');
  footnoteText = document.getElementById('proc-footnote-text');
  footnoteInfo = document.getElementById('proc-footnote-info');
  filterInput = document.getElementById('proc-filter');
  filterWrap = document.getElementById('filter-wrap');
  footnoteTooltip = createTooltip('tooltip-wrap', { align: 'end', side: 'above', gap: 6 });
  footnoteTooltip.bind(footnoteInfo, (node, button) => {
    node.textContent = button.getAttribute('aria-label');
  });
  restoreProcessView();
  filterInput.addEventListener('input', () => {
    setFilter(filterInput.value, filterInput.value.toLowerCase());
    storeProcessView();
    renderProcTable();
  });
  hintDismissed = !!storedViewState().hintDismissed;
  const hint = document.getElementById('filter-hint');
  filterInput.addEventListener('focus', () => {
    if (hintDismissed || hintShown) return;
    hintShown = true;
    hint.classList.add('show');
  });
  document.getElementById('hint-close').addEventListener('click', () => {
    hint.classList.remove('show');
    hintDismissed = true;
    storeViewState({ hintDismissed: true });
  });
  document.getElementById('filter-clear').addEventListener('click', () => {
    setFilter('', '');
    storeProcessView();
    renderProcTable();
    filterInput.focus();
  });
  document.getElementById('proc-hdr').addEventListener('click', (event) => {
    const button = event.target.closest('[data-hdr]');
    if (button) toggleHeaderMode(button.dataset.hdr);
  });
  renderProcToolbar();
  processTable.addEventListener('click', (event) => {
    if (!event.target.closest('.session-tag')) return;
    const process = rowProcess(event.target);
    if (process?.session) openSessionTerminal(process);
  });
  const isSessionTag = (node) => !!(node && node.closest && node.closest('.session-tag'));
  const setHold = (key, value) => {
    if (hold[key] === value) return;
    hold[key] = value;
    applyPendingProcesses();
  };
  processTable.addEventListener('mouseover', (event) => setHold('tagHover', isSessionTag(event.target)));
  processTable.addEventListener('mouseout', (event) => {
    if (!processTable.contains(event.relatedTarget)) setHold('tagHover', false);
  });
  processTable.addEventListener('focusin', (event) => setHold('tagFocus', isSessionTag(event.target)));
  processTable.addEventListener('focusout', (event) => {
    if (!isSessionTag(event.relatedTarget)) setHold('tagFocus', false);
  });
  processTable.addEventListener('contextmenu', (event) => {
    const cell = event.target.closest('td');
    const process = cell && rowProcess(cell);
    if (!process) return;
    event.preventDefault();
    showContextMenu(event, process, cell.cellIndex);
  });
}

export { esc, procSearchStr, normalizeProcessDisplay, refreshProcTable, sessionLabel, processNameTitle, processFootnote, processCopyValues, gpuTags };
