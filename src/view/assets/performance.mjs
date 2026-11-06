import { state, currentGpus } from './state.mjs';
import { renderGpuSpark, renderPercentSpark, renderRatePair, updateSparkAnimation } from './charts.mjs';
import { barWidth, colorClass, copyText, element, percentText, setBar, setClass, setText, storedViewState, storeViewState, tagColorClass, tr } from './ui.mjs';
import { LOCAL_DEVICE_ID } from './device-id.mjs';
import { updateTopbarLayout } from './layout.mjs';
import { createTooltip } from './popover.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RESET_TEXT_IDS = ['cpu-val', 'mem-val', 'mem-used', 'mem-avail', 'mem-total', 'load-1', 'load-5', 'load-15', 'net-tx', 'net-rx', 'ssh-tx', 'ssh-rx', 'ssh-latency', 'disk-io-val', 'gpu-summary', 'updated'];
const TOOLTIP_PLACEMENT = { side: 'above', gap: 6 };
// Rounding can leave a fitted user line this much wider than its box.
const USER_LINE_OVERFLOW_TOLERANCE_PX = 1;

const freshView = () => ({
  renderedSources: {},
  renderedTime: null,
  diskRows: new Map(),
  diskKeys: [],
  disks: [],
  diskIo: null,
  gpuCards: new Map(),
  renderedAcceleratorKeys: [],
  idleIds: [],
});

let view = freshView();
let renderGeneration = 0;
let gpuRenderGeneration = 0;
let selectedGpus = {};
let onViewGpuProcesses = () => {};
let infoTooltip, detailTooltip, copyButton;

function hiddenGroups() {
  return state.config.display.hiddenGroups || {};
}

function renderCpu(metrics) {
  const cpu = metrics.cpu;
  document.getElementById('cpu-val').textContent = percentText(cpu.usagePercent);
  setBar('cpu-bar', cpu.usagePercent);
  const load = (period) => (cpu.available === false ? '--' : cpu.loadAverage[period] + ' / ' + tr('coreCount', { count: cpu.coreCount }));
  document.getElementById('load-1').textContent = load('oneMinute');
  document.getElementById('load-5').textContent = load('fiveMinutes');
  document.getElementById('load-15').textContent = load('fifteenMinutes');
  renderPercentSpark('cpu-spark-area', state.charts.cpu, cpu.usagePercent);
}

function renderMemory(metrics) {
  const memory = metrics.memory;
  document.getElementById('mem-val').textContent = percentText(memory.usagePercent);
  setBar('mem-bar', memory.usagePercent);
  document.getElementById('mem-used').textContent = memory.usedText;
  document.getElementById('mem-avail').textContent = memory.availableText;
  document.getElementById('mem-total').textContent = memory.totalText;
  renderPercentSpark('ram-spark-area', state.charts.memory, memory.usagePercent);
}

function renderStorage(metrics, instant, source) {
  view.diskIo = metrics.diskIo || null;
  renderDisk(metrics.disks, instant);
  const diskStatusVisible = !metrics.disks.length && source && source.state !== 'ready';
  if (diskStatusVisible) document.getElementById('disk-body').textContent = source.state === 'loading' ? tr('loading') : tr('collectionFailed');
  document.getElementById('disk-card').classList.toggle('disk-empty', !metrics.disks.length && !diskStatusVisible);
  if (!metrics.diskIo) return;
  document.getElementById('disk-io-val').textContent = metrics.diskIo.totalText;
  renderRatePair(state.charts.diskRead, state.charts.diskWrite, 'disk-spark-r-area', 'disk-spark-w-area');
}

function renderNetwork(metrics) {
  const ssh = !!metrics.sshTraffic?.isSsh;
  setText(document.getElementById('net-title'), ssh ? tr('srvNet') : tr('net'));
  document.getElementById('ssh-card').hidden = !ssh;
  if (ssh) {
    document.getElementById('ssh-tx').textContent = metrics.sshTraffic.uploadText;
    document.getElementById('ssh-rx').textContent = metrics.sshTraffic.downloadText;
    document.getElementById('ssh-latency').textContent = metrics.sshTraffic.latencyText;
    renderRatePair(state.charts.sshTx, state.charts.sshRx, 'ssh-spark-tx-area', 'ssh-spark-rx-area');
  }
  document.getElementById('net-tx').textContent = metrics.network.transmitText;
  document.getElementById('net-rx').textContent = metrics.network.receiveText;
  renderRatePair(state.charts.netTx, state.charts.netRx, 'net-spark-tx-area', 'net-spark-rx-area');
}

// Percentages shared by the GPU card text, bar widths and color classes.
function gpuPercents(gpu) {
  return {
    util: Number.isFinite(gpu.util) ? Math.trunc(gpu.util) : null,
    memory: Number.isFinite(gpu.memPct) ? gpu.memPct : null,
  };
}

function gpuStatsValues(gpu) {
  return {
    temperature: Number.isFinite(gpu.temp) ? gpu.temp + '°C' : '--',
    power: gpu.power ? gpu.power.draw + '/' + gpu.power.limit + 'W' : null,
  };
}

function gpuStatsDescription(gpu) {
  const values = gpuStatsValues(gpu);
  return tr('tempLabel') + ' ' + values.temperature + (values.power ? ' · ' + tr('pwLabel') + ' ' + values.power : '');
}

function renderGpuInfo(tooltip, button) {
  const gpu = currentGpus().find((device) => String(device.idx) === button.dataset.gpuInfo);
  if (!gpu) return false;
  tooltip.textContent = gpuStatsDescription(gpu);
  return true;
}

function createGpuCard(gpu) {
  const node = element('div', 'gpu-mini');
  const spark = document.createElementNS(SVG_NS, 'svg');
  spark.setAttribute('class', 'spark-bg');
  spark.setAttribute('viewBox', '0 0 100 100');
  spark.setAttribute('preserveAspectRatio', 'none');
  const area = document.createElementNS(SVG_NS, 'path');
  area.id = 'gpu-spark-area-' + gpu.idx;
  spark.append(area);
  const title = element('div', 'gpu-title');
  const nameWrap = element('span', 'gpu-sub');
  const name = element('bdo');
  name.dir = 'ltr';
  nameWrap.append(name);
  title.append(element('span', 'gpu-name', 'GPU ' + gpu.idx), nameWrap);
  const utilRow = element('div', 'bar-label');
  const utilValue = element('span');
  const utilText = element('b');
  const link = element('button', 'gpu-link', '↗ ' + tr('viewProcs'));
  link.type = 'button';
  link.addEventListener('click', () => onViewGpuProcesses(gpu.idx));
  utilValue.append(utilText, ' ', link);
  utilRow.append(element('span', '', tr('utilLabel')), utilValue);
  const utilTrack = element('div', 'track');
  const utilFill = element('div', 'fill');
  utilTrack.append(utilFill);
  const memoryRow = element('div', 'bar-label');
  const memoryWrap = element('span', 'gpu-mem-wrap');
  const memoryTextWrap = element('span', 'ltr-ellipsis');
  const memoryText = element('bdo');
  memoryText.dir = 'ltr';
  memoryTextWrap.append(memoryText);
  const memoryPercent = element('span', 'gpu-pct');
  memoryWrap.append(memoryTextWrap, memoryPercent);
  memoryRow.append(element('span', '', tr('memLabel')), memoryWrap);
  const memoryTrack = element('div', 'track');
  const memoryFill = element('div', 'fill');
  memoryTrack.append(memoryFill);
  const footer = element('div', 'gpu-footer');
  const users = element('div', 'gpu-users');
  const stats = element('div', 'gpu-stats');
  const temperatureItem = element('span');
  const temperature = element('b');
  temperatureItem.append(element('span', 'gpu-stat-label', tr('tempLabel') + ' '), temperature);
  const powerItem = element('span');
  const power = element('b');
  powerItem.append(element('span', 'gpu-stat-label', tr('pwLabel') + ' '), power);
  stats.append(temperatureItem, powerItem);
  const info = element('button', 'gpu-info', 'ⓘ');
  info.type = 'button';
  info.dataset.gpuInfo = String(gpu.idx);
  infoTooltip.bind(info, renderGpuInfo);
  footer.append(users, stats, info);
  node.append(spark, title, utilRow, utilTrack, memoryRow, memoryTrack, footer);
  return { node, name, nameWrap, utilText, utilFill, memoryText, memoryTextWrap, memoryPercent, memoryFill, users, stats, temperature, power, powerItem, info, mine: false };
}

function updateGpuCard(card, gpu) {
  const percents = gpuPercents(gpu);
  const stats = gpuStatsValues(gpu);
  setText(card.name, gpu.displayName || gpu.name);
  card.nameWrap.title = gpu.name;
  setText(card.utilText, percentText(percents.util));
  setText(card.memoryText, gpu.memPairStr);
  card.memoryTextWrap.title = gpu.memPairStr;
  setText(card.memoryPercent, percentText(percents.memory));
  setClass(card.utilFill, 'fill ' + colorClass(percents.util));
  setClass(card.memoryFill, 'fill ' + colorClass(percents.memory));
  setText(card.temperature, stats.temperature);
  setText(card.power, stats.power || '');
  card.powerItem.hidden = stats.power === null;
  card.mine = !!gpu.isMine;
}

function updateGpuBars(card, gpu) {
  const percents = gpuPercents(gpu);
  card.utilFill.style.width = barWidth(percents.util);
  card.memoryFill.style.width = barWidth(percents.memory);
}

function renderGpuCapsules(gpus) {
  const capsules = document.getElementById('gpu-capsules');
  const buttons = capsules.children;
  if (buttons.length !== gpus.length || gpus.some((gpu, index) => buttons[index].dataset.idx !== String(gpu.idx))) {
    capsules.replaceChildren(...gpus.map((gpu) => {
      const button = element('button', 'cap', String(gpu.idx));
      button.type = 'button';
      button.dataset.idx = String(gpu.idx);
      return button;
    }));
  }
  gpus.forEach((gpu, index) => {
    const button = buttons[index];
    const isFree = gpu.isIdle === true;
    setClass(button, isFree ? (selectedGpus[gpu.idx] ? 'cap sel' : 'cap') : 'cap busy');
    button.dataset.free = isFree ? '1' : '0';
    if (gpu.availability === 'unknown') button.title = tr('gpuOccupancyUnavailable');
    else button.removeAttribute('title');
  });
}

function gpuSummaryText(gpus, source) {
  if (gpus.length) {
    const free = gpus.some((gpu) => gpu.availability === 'unknown') ? '--' : gpus.filter((gpu) => gpu.isIdle === true).length;
    return tr('freeGPUs', { free, total: gpus.length });
  }
  if (source?.state === 'loading') return '--';
  return source && source.state !== 'ready' ? tr('collectionFailed') : tr('noGpu');
}

function renderAccelerators(gpus, instant, source) {
  const generation = ++gpuRenderGeneration;
  for (const index of Object.keys(selectedGpus)) {
    if (!gpus.some((gpu) => gpu.idx === parseInt(index) && gpu.isIdle === true)) delete selectedGpus[index];
  }
  const identityKeys = gpus.map((gpu) => JSON.stringify([gpu.idx, gpu.deviceKey || String(gpu.idx)]));
  const created = identityKeys.join('\n') !== view.renderedAcceleratorKeys.join('\n');
  if (created) {
    view.renderedAcceleratorKeys = identityKeys;
    view.gpuCards = new Map(gpus.map((gpu) => [String(gpu.idx), createGpuCard(gpu)]));
    document.getElementById('gpu-body').replaceChildren(...[...view.gpuCards.values()].map((card) => card.node));
  }
  for (const gpu of gpus) {
    const card = view.gpuCards.get(String(gpu.idx));
    updateGpuCard(card, gpu);
    if (!created || instant) updateGpuBars(card, gpu);
    renderGpuSpark(gpu);
  }
  if (created && !instant && gpus.length) {
    requestAnimationFrame(() => {
      if (generation !== gpuRenderGeneration) return;
      for (const gpu of gpus) updateGpuBars(view.gpuCards.get(String(gpu.idx)), gpu);
    });
  }
  renderGpuCapsules(gpus);
  document.getElementById('gpu-summary').textContent = gpuSummaryText(gpus, source);
  view.idleIds = gpus.filter((gpu) => gpu.isIdle === true).map((gpu) => gpu.idx);
  updateCopyButton();
  updateGpuSection();
}

// The single place that decides which parts of the GPU area are visible.
function updateGpuSection() {
  const hidden = hiddenGroups();
  const display = state.config.display;
  const gpus = currentGpus();
  const pickerVisible = display.showGpuPicker !== false && gpus.length > 0;
  const freeCard = document.getElementById('free-gpu-card');
  freeCard.hidden = !!hidden.gpuSummary;
  freeCard.classList.toggle('no-picker', !pickerVisible);
  document.getElementById('gpu-capsules').hidden = !pickerVisible;
  document.getElementById('capsule-actions').hidden = !pickerVisible;
  document.getElementById('gpu-body').hidden = !!hidden.gpuCards || !gpus.length;
  view.gpuCards.forEach((card) => card.node.classList.toggle('my-gpu', display.highlightMyGpus !== false && card.mine));
  gpus.forEach(renderGpuUsers);
  updateGpuStatsFit();
  infoTooltip.refresh();
}

function applyGroupVisibility() {
  const hidden = hiddenGroups();
  document.getElementById('cpu-card').hidden = !!hidden.cpu;
  document.getElementById('mem-card').hidden = !!hidden.memory;
  document.getElementById('system-row').hidden = !!(hidden.cpu && hidden.memory);
  document.getElementById('disk-card').hidden = !!hidden.disk;
  document.getElementById('network-row').hidden = !!hidden.network;
  updateGpuSection();
}

function updateGpuStatsFit() {
  if (!view.gpuCards.size) return;
  const measure = element('div', 'gpu-stats-measure');
  measure.setAttribute('aria-hidden', 'true');
  document.body.append(measure);
  view.gpuCards.forEach(({ stats }) => {
    if (stats.hidden) return;
    const available = stats.getBoundingClientRect().width;
    if (!available) return;
    measure.replaceChildren(...Array.from(stats.children).filter((item) => !item.hidden).map((item) => item.cloneNode(true)));
    stats.classList.toggle('compact', measure.getBoundingClientRect().width > available);
  });
  measure.remove();
}

function userChip(user) {
  return element('span', 'gpu-user ' + tagColorClass(user.percent), user.name + ' (' + user.usedStr + ')');
}

function renderGpuUserDetails(tooltip, button) {
  const gpu = currentGpus().find((device) => String(device.idx) === button.dataset.gpuMore);
  if (!gpu) return false;
  tooltip.className = 'tooltip detail-tooltip stacked';
  tooltip.replaceChildren(...gpu.users.slice(Number(button.dataset.gpuMoreStart)).map(userChip));
  return true;
}

function fitGpuUsers(line, gpu, users) {
  for (let visible = users.length; visible >= 0; visible--) {
    line.replaceChildren(...users.slice(0, visible).map((user) => {
      const chip = userChip(user);
      chip.title = chip.textContent;
      return chip;
    }));
    if (visible < users.length) {
      const more = element('button', 'gpu-user-more', '(+' + (users.length - visible) + ')');
      more.type = 'button';
      more.dataset.gpuMore = String(gpu.idx);
      more.dataset.gpuMoreStart = String(visible);
      detailTooltip.bind(more, renderGpuUserDetails);
      line.append(more);
    }
    if (line.scrollWidth <= line.clientWidth + USER_LINE_OVERFLOW_TOLERANCE_PX) return;
  }
}

function renderGpuUsers(gpu) {
  const card = view.gpuCards.get(String(gpu.idx));
  if (!card) return;
  const line = card.users;
  const users = gpu.users || [];
  const showUsers = state.config.display.showGpuUsers !== false && users.length > 0;
  const detailButton = detailTooltip.anchor;
  const detailShown = detailButton?.dataset.gpuMore === String(gpu.idx);
  line.hidden = !showUsers;
  card.stats.hidden = showUsers;
  card.info.hidden = !showUsers;
  card.info.setAttribute('aria-label', gpuStatsDescription(gpu));
  if (!showUsers) {
    infoTooltip.hide(card.info);
    if (detailShown) detailTooltip.hide();
    line.replaceChildren();
    delete line.dataset.userRenderKey;
    return;
  }
  if (!line.clientWidth) return;
  const renderKey = JSON.stringify(users.map((user) => [user.name, user.usedStr, user.percent]));
  const width = String(line.clientWidth);
  if (line.dataset.userRenderKey === renderKey && line.dataset.userRenderWidth === width) return;
  if (detailShown) {
    const hiddenFrom = Number(detailButton.dataset.gpuMoreStart);
    if (users.length > hiddenFrom && line.dataset.userRenderWidth === width) {
      detailButton.textContent = '(+' + (users.length - hiddenFrom) + ')';
      detailTooltip.refresh();
      return;
    }
    detailTooltip.hide();
  }
  fitGpuUsers(line, gpu, users);
  line.dataset.userRenderKey = renderKey;
  line.dataset.userRenderWidth = String(line.clientWidth);
}

function refreshGpuUsers() {
  currentGpus().forEach(renderGpuUsers);
}

function renderDiskDetails(tooltip, button) {
  const isDiskIo = button.dataset.diskIoInfo !== undefined;
  const disk = view.disks[Number(button.dataset.diskInfo)];
  if (!disk && !isDiskIo) return false;
  const rows = isDiskIo
    ? [[tr('diskRead'), view.diskIo?.readText ?? '--'], [tr('diskWrite'), view.diskIo?.writeText ?? '--']]
    : [[tr('diskReserved'), disk.reservedStr], [tr('used'), disk.usedStr], [tr('avail'), disk.availableStr], [tr('total'), disk.totalStr]];
  tooltip.className = 'tooltip detail-tooltip disk-breakdown';
  tooltip.replaceChildren(...rows.flatMap(([label, value]) => [element('span', 'disk-breakdown-label', label), element('span', 'disk-breakdown-value', value)]));
  return true;
}

function detailPlacement(button) {
  return { ...TOOLTIP_PLACEMENT, align: button.dataset.gpuMore !== undefined ? 'center' : 'end' };
}

function applyCharts() {
  document.body.classList.toggle('charts-off', state.config.display.charts === false);
  updateSparkAnimation();
}

function applyTabularNums() {
  document.body.style.fontVariantNumeric = state.config.display.tabularNums !== false ? 'tabular-nums' : '';
}

function diskBreakdownDescription(disk) {
  return tr('diskReserved') + ' ' + disk.reservedStr + ' · ' + tr('used') + ' ' + disk.usedStr + ' · ' + tr('avail') + ' ' + disk.availableStr + ' · ' + tr('total') + ' ' + disk.totalStr;
}

function updateDiskBar(disk) {
  const row = view.diskRows.get(disk.mount);
  if (!row) return;
  row.reserved.style.width = barWidth(disk.reservedPct);
  row.fill.style.width = barWidth(disk.occupiedPct);
  row.fill.className = 'fill ' + colorClass(disk.pct);
}

function createDiskRow(mount) {
  const node = element('div', 'disk-item');
  node.dataset.mount = mount;
  const header = element('div', 'disk-header');
  const name = element('span', 'disk-mount', mount);
  name.title = mount;
  const headerAlert = element('button', 'disk-alert disk-header-alert', 'ⓘ');
  const info = element('span', 'disk-info');
  const meta = element('span', 'disk-meta');
  const usage = element('span', 'disk-usage-wrap');
  const percent = element('span', 'disk-pct');
  const alert = element('button', 'disk-alert', 'ⓘ');
  usage.append(percent, alert);
  info.append(meta, usage);
  header.append(name, headerAlert, info);
  const track = element('div', 'track disk-track');
  const fill = element('div', 'fill');
  const reserved = element('div', 'disk-reserved');
  fill.style.width = '0%';
  reserved.style.width = '0%';
  track.append(fill, reserved);
  const footer = element('div', 'disk-footer');
  const footerMeta = element('span', 'disk-meta');
  const footerPercent = element('span', 'disk-pct');
  footer.append(footerMeta, footerPercent);
  node.append(header, track, footer);
  const alerts = [headerAlert, alert];
  for (const button of alerts) {
    button.type = 'button';
    detailTooltip.bind(button, renderDiskDetails);
  }
  return { node, fill, reserved, meta, percent, footerMeta, footerPercent, alerts, pending: true, disk: null };
}

function renderDisk(disks, instant) {
  const body = document.getElementById('disk-body');
  view.disks = disks || [];
  const mounts = new Set(view.disks.map((disk) => disk.mount));
  for (const [mount, row] of view.diskRows) {
    if (mounts.has(mount)) continue;
    if (row.node.contains(detailTooltip.anchor)) detailTooltip.hide();
    row.node.remove();
    view.diskRows.delete(mount);
  }
  if (!view.diskRows.size) body.replaceChildren();
  view.diskKeys = view.disks.map((disk) => disk.mount);
  view.disks.forEach((disk, index) => {
    let row = view.diskRows.get(disk.mount);
    const created = !row;
    if (!row) {
      row = createDiskRow(disk.mount);
      view.diskRows.set(disk.mount, row);
    }
    row.disk = disk;
    row.meta.textContent = row.footerMeta.textContent = disk.occupiedStr + ' / ' + disk.totalStr;
    row.percent.textContent = row.footerPercent.textContent = percentText(disk.pct);
    row.percent.className = row.footerPercent.className = 'disk-pct ' + colorClass(disk.pct);
    for (const button of row.alerts) {
      button.dataset.diskInfo = String(index);
      button.setAttribute('aria-label', diskBreakdownDescription(disk));
    }
    if (body.children[index] !== row.node) body.insertBefore(row.node, body.children[index] || null);
    if (instant || !row.pending) {
      row.pending = false;
      updateDiskBar(disk);
    } else if (created) {
      requestAnimationFrame(() => {
        if (view.diskRows.get(disk.mount) !== row) return;
        row.pending = false;
        updateDiskBar(row.disk);
      });
    }
  });
  detailTooltip.refresh();
}

function updateCopyButton() {
  copyButton.disabled = Object.keys(selectedGpus).length === 0;
}

function resetCopyButton() {
  copyButton.textContent = tr('copyEnv');
  updateCopyButton();
}

function gpuSelectionKey() {
  return state.ui.deviceId || LOCAL_DEVICE_ID;
}

function storeGpuSelection() {
  const selections = { ...storedViewState().gpuSelection };
  const selected = Object.keys(selectedGpus).map(Number);
  if (selected.length) selections[gpuSelectionKey()] = selected;
  else delete selections[gpuSelectionKey()];
  storeViewState({ gpuSelection: selections });
}

function restoreGpuSelection() {
  const saved = storedViewState().gpuSelection;
  const selected = Array.isArray(saved?.[gpuSelectionKey()]) ? saved[gpuSelectionKey()] : [];
  selectedGpus = Object.fromEntries(selected.filter(Number.isInteger).map((index) => [index, true]));
}

function gpuSelectionChanged() {
  document.querySelectorAll('#gpu-capsules .cap').forEach((button) => {
    button.classList.toggle('sel', button.dataset.free === '1' && !!selectedGpus[button.dataset.idx]);
  });
  resetCopyButton();
  storeGpuSelection();
}

function sourcesChanged(viewModel, keys, extra = '') {
  const key = keys.join(':');
  const revision = [state.ui.deviceId, extra, ...keys.map((name) => viewModel.sources?.[name]?.revision)].join(':');
  if (viewModel.sources && view.renderedSources[key] === revision) return false;
  view.renderedSources[key] = revision;
  return true;
}

export function renderMonitorSnapshot(viewModel, instant, sampleTime) {
  const generation = ++renderGeneration;
  document.body.classList.toggle('instant-metrics', !!instant);
  const metrics = viewModel.performance;
  const gpus = metrics.gpus || [];
  if (sourcesChanged(viewModel, ['cpu'])) renderCpu(metrics);
  if (sourcesChanged(viewModel, ['memory'])) renderMemory(metrics);
  const mounts = metrics.disks.map((disk) => disk.mount).join('\0');
  if (sourcesChanged(viewModel, ['diskTopology', 'diskIo'], mounts)) {
    const topologyRevision = [state.ui.deviceId, viewModel.sources?.diskTopology?.revision].join(':');
    const mountsChanged = view.diskKeys.join('\0') !== mounts;
    const projectionOnly = mountsChanged && !!viewModel.sources && view.renderedSources.diskTopology === topologyRevision;
    view.renderedSources.diskTopology = topologyRevision;
    renderStorage(metrics, instant || projectionOnly, viewModel.sources?.diskTopology);
  }
  if (sourcesChanged(viewModel, ['network', 'sshTraffic'])) renderNetwork(metrics);
  if (sourcesChanged(viewModel, ['accelerators'], JSON.stringify(gpus.map((gpu) => gpu.users)))) {
    renderAccelerators(gpus, instant, viewModel.sources?.accelerators);
  }
  const time = new Date(typeof sampleTime === 'number' ? sampleTime : Date.now()).toLocaleTimeString(state.locale.language);
  const timeText = tr('updatedAt', { time });
  if (view.renderedTime !== timeText) {
    view.renderedTime = timeText;
    document.getElementById('updated').textContent = timeText;
    updateTopbarLayout();
  }
  if (instant) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (generation === renderGeneration) document.body.classList.remove('instant-metrics');
    }));
  }
}

export function resetPerformanceView() {
  view = freshView();
  renderGeneration++;
  gpuRenderGeneration++;
  infoTooltip.hide();
  detailTooltip.hide();
  restoreGpuSelection();
  for (const id of RESET_TEXT_IDS) document.getElementById(id).textContent = '--';
  setBar('cpu-bar', null);
  setBar('mem-bar', null);
  document.getElementById('net-title').textContent = tr('net');
  document.getElementById('ssh-card').hidden = true;
  document.getElementById('disk-body').replaceChildren();
  document.getElementById('disk-card').classList.add('disk-empty');
  document.getElementById('gpu-body').replaceChildren();
  document.getElementById('gpu-capsules').replaceChildren();
  resetCopyButton();
  applyGroupVisibility();
}

// viewGpuProcesses shows the process page filtered to one GPU; page switching is orchestrated by app.mjs,
// which imports this module, so it is passed in rather than imported.
export function initializePerformance({ viewGpuProcesses }) {
  onViewGpuProcesses = viewGpuProcesses;
  infoTooltip = createTooltip('', { ...TOOLTIP_PLACEMENT, align: 'end' });
  detailTooltip = createTooltip('detail-tooltip', detailPlacement);
  detailTooltip.bind(document.getElementById('disk-io-info'), renderDiskDetails);
  window.addEventListener('resize', () => {
    refreshGpuUsers();
    updateGpuStatsFit();
    infoTooltip.refresh();
  });
  applyCharts();
  applyTabularNums();
  restoreGpuSelection();
  copyButton = document.getElementById('copy-btn');
  document.getElementById('gpu-capsules').addEventListener('click', (event) => {
    const button = event.target.closest('.cap');
    if (!button || button.dataset.free !== '1') return;
    const index = parseInt(button.dataset.idx);
    if (selectedGpus[index]) delete selectedGpus[index];
    else selectedGpus[index] = true;
    gpuSelectionChanged();
  });
  document.getElementById('select-all-btn').addEventListener('click', () => {
    for (const index of view.idleIds) selectedGpus[index] = true;
    gpuSelectionChanged();
  });
  document.getElementById('clear-btn').addEventListener('click', () => {
    selectedGpus = {};
    gpuSelectionChanged();
  });
  copyButton.addEventListener('click', () => {
    if (copyButton.disabled) return;
    const ids = Object.keys(selectedGpus).map(Number).sort((a, b) => a - b).join(',');
    copyText('CUDA_VISIBLE_DEVICES=' + ids).then((copied) => {
      copyButton.textContent = copied ? tr('copyEnv') : tr('copyFailed');
    });
  });
}

export { applyGroupVisibility, gpuStatsValues, refreshGpuUsers, applyCharts, applyTabularNums };
