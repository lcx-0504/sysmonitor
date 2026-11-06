import { state } from "./state.mjs";
import { renderRatePair, renderSpark, renderGpuSpark, sparkColor, setChartActivity, updateSparkAnimation } from "./charts.mjs";
import { initializeChartState } from "./chart-state.mjs";
import { colorClass, copyText, setBar, tagColorClass, tr } from "./ui.mjs";
import { focusGpuProcesses, renderProcessSnapshot, resetProcessView } from "./processes.mjs";
import { updateTopbarLayout } from "./layout.mjs";

const SVG_NS = 'http://www.w3.org/2000/svg';

let renderGeneration, gpuRenderGeneration, renderedSources, renderedTime, infoPopover, activeInfoButton, detailPopover, activeDetailButton, copyButton;
let diskRows, gpuCards;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function setClass(node, className) {
  if (node.className !== className) node.className = className;
}

export function resetMonitorView() {
  renderedSources = {};
  renderedTime = null;
  renderGeneration++;
  gpuRenderGeneration++;
  hideInfoPopover();
  hideDetailPopover();
  initializeChartState();
  setChartActivity(state.ui.paused, false);
  state.data.status = null;
  state.data.viewModel = null;
  state.data.diskIo = null;
  state.data.disks = [];
  state.data.gpus = [];
  state.data.idleIds = [];
  state.ui.renderedDiskKeys = [];
  state.ui.renderedAcceleratorKeys = [];
  diskRows = new Map();
  gpuCards = new Map();
  restoreGpuSelection();
  ['cpu-val', 'mem-val', 'mem-used', 'mem-avail', 'mem-total', 'load-1', 'load-5', 'load-15', 'net-tx', 'net-rx', 'ssh-tx', 'ssh-rx', 'ssh-latency', 'disk-io-val', 'gpu-summary', 'updated'].forEach(function(id) {
    document.getElementById(id).textContent = '--';
  });
  setBar('cpu-bar', null);
  setBar('mem-bar', null);
  document.getElementById('net-title').textContent = tr('net');
  document.getElementById('ssh-card').hidden = true;
  document.getElementById('disk-body').replaceChildren();
  document.getElementById('disk-card').classList.add('disk-empty');
  document.getElementById('gpu-body').replaceChildren();
  document.getElementById('gpu-capsules').replaceChildren();
  document.querySelectorAll('.spark-bg path').forEach(function(path) { path.removeAttribute('d'); });
  resetCopyButton();
  resetProcessView();
  applyGroupVisibility();
}

function renderMonitorSnapshot(viewModel, instant, sampleTime) {
    const generation = ++renderGeneration;
    document.body.classList.toggle('instant-metrics', !!instant);
    const performance = viewModel.performance;
    state.data.gpus = performance.gpus || [];
    renderProcessSnapshot(viewModel);
    function changed(keys, extra = '') {
      const key = keys.join(':');
      const revision = [state.ui.deviceId, extra, ...keys.map(name => viewModel.sources?.[name]?.revision)].join(':');
      if (!viewModel.sources || renderedSources[key] !== revision) { renderedSources[key] = revision; return true; }
      return false;
    }
    if (changed(['cpu'])) renderCpu(performance);
    if (changed(['memory'])) renderMemory(performance);
    if (changed(['diskTopology', 'diskIo'], performance.disks.map(disk => disk.mount).join('\0'))) {
      const topologyRevision = [state.ui.deviceId, viewModel.sources?.diskTopology?.revision].join(':');
      const mountsChanged = state.ui.renderedDiskKeys.join('\0') !== performance.disks.map(disk => disk.mount).join('\0');
      const projectionOnly = mountsChanged && !!viewModel.sources && renderedSources.diskTopology === topologyRevision;
      renderedSources.diskTopology = topologyRevision;
      renderStorage(performance, instant || projectionOnly, viewModel.sources?.diskTopology);
    }
    if (changed(['network', 'sshTraffic'])) renderNetwork(performance);
    if (changed(['accelerators'], JSON.stringify(state.data.gpus.map(gpu => gpu.users)))) {
      renderAccelerators(performance, instant, viewModel.sources?.accelerators);
      applyGroupVisibility();
    }
    const timeText = state.locale.messages.updAt + new Date(typeof sampleTime === 'number' ? sampleTime : Date.now()).toLocaleTimeString(state.locale.language);
    if (renderedTime !== timeText) {
      renderedTime = timeText;
      document.getElementById('updated').textContent = timeText;
      updateTopbarLayout();
    }
    if (instant) requestAnimationFrame(() => requestAnimationFrame(() => {
      if (generation === renderGeneration) document.body.classList.remove('instant-metrics');
    }));
  }

function renderCpu(performance) {
    document.getElementById('cpu-val').textContent = Number.isFinite(performance.cpu.usagePercent) ? performance.cpu.usagePercent + '%' : '--';
    setBar('cpu-bar', performance.cpu.usagePercent);
    document.getElementById('load-1').textContent = performance.cpu.available === false ? '--' : performance.cpu.loadAverage.oneMinute + ' / ' + performance.cpu.coreCount + state.locale.messages.cores;
    document.getElementById('load-5').textContent = performance.cpu.available === false ? '--' : performance.cpu.loadAverage.fiveMinutes + ' / ' + performance.cpu.coreCount + state.locale.messages.cores;
    document.getElementById('load-15').textContent = performance.cpu.available === false ? '--' : performance.cpu.loadAverage.fifteenMinutes + ' / ' + performance.cpu.coreCount + state.locale.messages.cores;
    renderSpark(document.getElementById('cpu-spark-area'), state.charts.cpu, 100, sparkColor(performance.cpu.usagePercent));

  }

function renderMemory(performance) {
    document.getElementById('mem-val').textContent = Number.isFinite(performance.memory.usagePercent) ? performance.memory.usagePercent + '%' : '--';
    setBar('mem-bar', performance.memory.usagePercent);
    document.getElementById('mem-used').textContent = performance.memory.usedText;
    document.getElementById('mem-avail').textContent = performance.memory.availableText;
    document.getElementById('mem-total').textContent = performance.memory.totalText;
    renderSpark(document.getElementById('ram-spark-area'), state.charts.memory, 100, sparkColor(performance.memory.usagePercent));

  }

function renderStorage(performance, instant, source) {
    state.data.diskIo = performance.diskIo || null;
    renderDisk(performance.disks, instant);
    const diskStatusVisible = !performance.disks.length && source && source.state !== 'ready';
    if (diskStatusVisible) {
      document.getElementById('disk-body').textContent = source.state === 'loading' ? tr('loading') : tr('collectionFailed');
    }
    document.getElementById('disk-card').classList.toggle('disk-empty', !performance.disks.length && !diskStatusVisible);
    if (performance.diskIo) {
      document.getElementById('disk-io-val').textContent = performance.diskIo.totalText;
      renderRatePair(state.charts.diskRead, state.charts.diskWrite, 'disk-spark-r-area', 'disk-spark-w-area', 'var(--warn)', 'var(--accent)');
    }
  }

function renderNetwork(performance) {
    const ssh = !!(performance.sshTraffic && performance.sshTraffic.isSsh);
    setText(document.getElementById('net-title'), ssh ? tr('srvNet') : tr('net'));
    document.getElementById('ssh-card').hidden = !ssh;
    if (ssh) {
      document.getElementById('ssh-tx').textContent = performance.sshTraffic.uploadText;
      document.getElementById('ssh-rx').textContent = performance.sshTraffic.downloadText;
      document.getElementById('ssh-latency').textContent = performance.sshTraffic.latencyText;
      renderRatePair(state.charts.sshTx, state.charts.sshRx, 'ssh-spark-tx-area', 'ssh-spark-rx-area', 'var(--warn)', 'var(--accent)');
    }
    document.getElementById('net-tx').textContent = performance.network.transmitText;
    document.getElementById('net-rx').textContent = performance.network.receiveText;
    renderRatePair(state.charts.netTx, state.charts.netRx, 'net-spark-tx-area', 'net-spark-rx-area', 'var(--warn)', 'var(--accent)');
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
    link.addEventListener('click', function() { focusGpuProcesses(gpu.idx); });
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
    bindInfoButton(info);
    footer.append(users, stats, info);
    node.append(spark, title, utilRow, utilTrack, memoryRow, memoryTrack, footer);
    return { node, name, nameWrap, utilText, utilFill, memoryText, memoryTextWrap, memoryPercent, memoryFill, users, stats, temperature, power, powerItem, info };
  }

function updateGpuCard(card, g) {
    var util = parseInt(g.util) || 0;
    var memPct = g.memPct;
    var stats = gpuStatsValues(g);
    setText(card.name, g.displayName || g.name);
    card.nameWrap.title = g.name;
    setText(card.utilText, Number.isFinite(g.util) ? util + '%' : '--');
    setText(card.memoryText, g.memPairStr);
    card.memoryTextWrap.title = g.memPairStr;
    setText(card.memoryPercent, Number.isFinite(memPct) ? memPct + '%' : '--');
    setClass(card.utilFill, 'fill ' + colorClass(util));
    setClass(card.memoryFill, 'fill ' + colorClass(memPct));
    setText(card.temperature, stats.temperature);
    setText(card.power, stats.power || '');
    card.powerItem.hidden = stats.power === null;
    card.node.dataset.mine = g.isMine ? '1' : '0';
  }

function updateGpuBars(card, g) {
    card.utilFill.style.width = (parseInt(g.util) || 0) + '%';
    card.memoryFill.style.width = (Number.isFinite(g.memPct) ? g.memPct : 0) + '%';
  }

function renderGpuCapsules(gpus) {
    const capsules = document.getElementById('gpu-capsules');
    const buttons = capsules.children;
    if (buttons.length !== gpus.length || gpus.some(function(g, index) { return buttons[index].dataset.idx !== String(g.idx); })) {
      capsules.replaceChildren(...gpus.map(function(g) {
        const button = element('button', 'cap', String(g.idx));
        button.type = 'button';
        button.dataset.idx = String(g.idx);
        return button;
      }));
    }
    gpus.forEach(function(g, index) {
      const button = buttons[index];
      const isFree = g.isIdle === true;
      setClass(button, isFree ? (state.ui.selectedGpus[g.idx] ? 'cap sel' : 'cap') : 'cap busy');
      button.dataset.free = isFree ? '1' : '0';
      if (g.availability === 'unknown') button.title = tr('gpuOccupancyUnavailable');
      else button.removeAttribute('title');
    });
  }

function renderAccelerators(performance, instant, source) {
    const generation = ++gpuRenderGeneration;
    const gpus = performance.gpus || [];
    Object.keys(state.ui.selectedGpus).forEach(function(index) { if (!gpus.some(function(gpu) { return gpu.idx === parseInt(index) && gpu.isIdle === true; })) delete state.ui.selectedGpus[index]; });
    const identityKeys = gpus.map(function(g) { return JSON.stringify([g.idx, g.deviceKey || String(g.idx)]); });
    const created = identityKeys.join('\n') !== state.ui.renderedAcceleratorKeys.join('\n');
    if (created) {
      state.ui.renderedAcceleratorKeys = identityKeys;
      gpuCards = new Map(gpus.map(function(g) { return [String(g.idx), createGpuCard(g)]; }));
      document.getElementById('gpu-body').replaceChildren(...[...gpuCards.values()].map(function(card) { return card.node; }));
    }
    gpus.forEach(function(g) {
      const card = gpuCards.get(String(g.idx));
      updateGpuCard(card, g);
      if (!created || instant) updateGpuBars(card, g);
      renderGpuSpark(g);
      renderGpuUsers(g);
    });
    if (created && !instant && gpus.length) requestAnimationFrame(function() {
      if (generation !== gpuRenderGeneration) return;
      gpus.forEach(function(g) { updateGpuBars(gpuCards.get(String(g.idx)), g); });
    });
    refreshInfoPopover();
    renderGpuCapsules(gpus);
    const freeCount = gpus.filter(function(g) { return g.isIdle === true; }).length;
    document.getElementById('gpu-summary').textContent = gpus.length
      ? tr('freeGPUs', { freeCount: gpus.some(g => g.availability === 'unknown') ? '--' : freeCount, performance })
      : source?.state === 'loading' ? '--' : source && source.state !== 'ready' ? tr('collectionFailed') : tr('noGpu');
    state.data.idleIds = gpus.filter(function(g) { return g.isIdle === true; }).map(function(g) { return g.idx; });
    updateCopyBtn();
  }

function applyGroupVisibility() {
    var hidden = state.config.display.hiddenGroups || {};
    var pickerVisible = state.config.display.showGpuPicker !== false && state.data.gpus.length > 0;
    document.getElementById('cpu-card').hidden = !!hidden.cpu;
    document.getElementById('mem-card').hidden = !!hidden.memory;
    document.getElementById('system-row').hidden = !!(hidden.cpu && hidden.memory);
    document.getElementById('disk-card').hidden = !!hidden.disk;
    document.getElementById('network-row').hidden = !!hidden.network;
    document.getElementById('free-gpu-card').hidden = !!hidden.gpuSummary;
    document.getElementById('free-gpu-card').classList.toggle('no-picker', !pickerVisible);
    document.getElementById('gpu-body').hidden = !!hidden.gpuCards || !state.data.gpus.length;
    document.getElementById('gpu-capsules').hidden = !pickerVisible;
    document.getElementById('capsule-actions').hidden = !pickerVisible;
    gpuCards.forEach(function(card) { card.node.classList.toggle('my-gpu', state.config.display.highlightMyGpus !== false && card.node.dataset.mine === '1'); });
    if (!hidden.gpuCards) state.data.gpus.forEach(renderGpuUsers);
    updateGpuStatsFit();
    refreshInfoPopover();
  }

function gpuStatsValues(gpu) {
    return {
      temperature: Number.isFinite(gpu.temp) ? gpu.temp + '°C' : '--',
      power: gpu.power ? gpu.power.draw + '/' + gpu.power.limit + 'W' : null,
    };
  }

function gpuStatsDescription(gpu) {
    var values = gpuStatsValues(gpu);
    var details = state.locale.messages.tempLabel + ' ' + values.temperature;
    if (values.power) details += ' · ' + state.locale.messages.pwLabel + ' ' + values.power;
    return details;
  }

function updateGpuStatsFit() {
    if (!gpuCards.size) return;
    var measure = element('div', 'gpu-stats-measure');
    measure.setAttribute('aria-hidden', 'true');
    document.body.appendChild(measure);
    gpuCards.forEach(function(card) {
      var stats = card.stats;
      if (stats.hidden) return;
      var available = stats.getBoundingClientRect().width;
      if (!available) return;
      measure.replaceChildren(...Array.from(stats.children).filter(function(item) { return !item.hidden; }).map(function(item) { return item.cloneNode(true); }));
      stats.classList.toggle('compact', measure.getBoundingClientRect().width > available);
    });
    measure.remove();
  }

function renderGpuUsers(gpu) {
    var card = gpuCards.get(String(gpu.idx));
    if (!card) return;
    var line = card.users;
    var users = gpu.users || [];
    var showUsers = state.config.display.showGpuUsers !== false && users.length > 0;
    line.hidden = !showUsers;
    card.stats.hidden = showUsers;
    card.info.hidden = !showUsers;
    card.info.setAttribute('aria-label', gpuStatsDescription(gpu));
    if (!showUsers && activeInfoButton === card.info) hideInfoPopover(card.info);
    if (!showUsers) {
      if (activeDetailButton && activeDetailButton.dataset.gpuMore === String(gpu.idx)) hideDetailPopover();
      line.replaceChildren(); delete line.dataset.userRenderKey; return;
    }
    if (!line.clientWidth) return;
    var renderKey = JSON.stringify(users.map(function(user) { return [user.name, user.usedStr, user.percent]; }));
    if (line.dataset.userRenderKey === renderKey && line.dataset.userRenderWidth === String(line.clientWidth)) return;
    if (activeDetailButton && activeDetailButton.dataset.gpuMore === String(gpu.idx)) {
      var hiddenFrom = Number(activeDetailButton.dataset.gpuMoreStart);
      if (users.length > hiddenFrom && line.dataset.userRenderWidth === String(line.clientWidth)) {
        activeDetailButton.textContent = '(+' + (users.length - hiddenFrom) + ')';
        refreshDetailPopover();
        return;
      }
      hideDetailPopover();
    }
    for (var visible = users.length; visible >= 0; visible--) {
      line.replaceChildren();
      users.slice(0, visible).forEach(function(user) {
        var chip = document.createElement('span');
        chip.className = 'gpu-user ' + tagColorClass(user.percent);
        chip.textContent = user.name + ' (' + user.usedStr + ')';
        chip.title = chip.textContent;
        line.appendChild(chip);
      });
      if (visible < users.length) {
        var more = document.createElement('button');
        more.className = 'gpu-user-more';
        more.type = 'button';
        more.textContent = '(+' + (users.length - visible) + ')';
        more.dataset.gpuMore = String(gpu.idx);
        more.dataset.gpuMoreStart = String(visible);
        bindDetailPopoverButton(more);
        line.appendChild(more);
      }
      if (line.scrollWidth <= line.clientWidth + 1) break;
    }
    line.dataset.userRenderKey = renderKey;
    line.dataset.userRenderWidth = String(line.clientWidth);
  }

function hideInfoPopover(button) {
    if (button && activeInfoButton !== button) return;
    activeInfoButton = null;
    if (infoPopover) infoPopover.hidden = true;
  }

function infoPopoverText(button) {
    if (button.dataset.gpuInfo === undefined) return button.getAttribute('aria-label');
    var gpu = state.data.gpus.find(function(device) { return String(device.idx) === button.dataset.gpuInfo; });
    return gpu ? gpuStatsDescription(gpu) : null;
  }

function refreshInfoPopover() {
    var button = activeInfoButton;
    if (!button) return;
    if (!button.isConnected || !button.getClientRects().length) { hideInfoPopover(); return; }
    var text = infoPopoverText(button);
    if (!text) { hideInfoPopover(); return; }
    infoPopover.textContent = text;
    infoPopover.classList.toggle('wrap', button.dataset.gpuInfo === undefined);
    infoPopover.hidden = false;
    var bounds = button.getBoundingClientRect();
    infoPopover.style.left = Math.max(4, Math.min(bounds.right - infoPopover.offsetWidth, window.innerWidth - infoPopover.offsetWidth - 4)) + 'px';
    var above = bounds.top - infoPopover.offsetHeight - 6;
    infoPopover.style.top = (above >= 4 ? above : bounds.bottom + 6) + 'px';
  }

function showInfoPopover(button) {
    activeInfoButton = button;
    refreshInfoPopover();
  }

function bindInfoButton(button) {
    button.addEventListener('mouseenter', function() { showInfoPopover(button); });
    button.addEventListener('mouseleave', function() { hideInfoPopover(button); });
    button.addEventListener('focus', function() { showInfoPopover(button); });
    button.addEventListener('blur', function() { hideInfoPopover(button); });
  }

function hideDetailPopover(button) {
    if (button && activeDetailButton !== button) return;
    activeDetailButton = null;
    if (detailPopover) detailPopover.hidden = true;
  }

function refreshDetailPopover() {
    var button = activeDetailButton;
    if (!button) return;
    if (!button.isConnected || !button.getClientRects().length) { hideDetailPopover(); return; }
    if (button.dataset.gpuMore !== undefined) {
      var gpu = state.data.gpus.find(function(device) { return String(device.idx) === button.dataset.gpuMore; });
      if (!gpu) { hideDetailPopover(); return; }
      detailPopover.classList.add('stacked');
      detailPopover.classList.remove('disk-breakdown');
      detailPopover.replaceChildren();
      gpu.users.slice(Number(button.dataset.gpuMoreStart)).forEach(function(user) {
        var chip = document.createElement('span');
        chip.className = 'gpu-user ' + tagColorClass(user.percent);
        chip.textContent = user.name + ' (' + user.usedStr + ')';
        detailPopover.appendChild(chip);
      });
    } else {
      var disk = state.data.disks[Number(button.dataset.diskInfo)];
      var isDiskIo = button.dataset.diskIoInfo !== undefined;
      var io = isDiskIo ? state.data.diskIo : null;
      if (!disk && !isDiskIo) { hideDetailPopover(); return; }
      detailPopover.classList.remove('stacked');
      detailPopover.classList.add('disk-breakdown');
      detailPopover.replaceChildren();
      var details = isDiskIo ? [[tr('diskRead'), io?.readText ?? '--'], [tr('diskWrite'), io?.writeText ?? '--']]
        : [[state.locale.messages.diskReserved, disk.reservedStr], [state.locale.messages.used, disk.usedStr], [state.locale.messages.avail, disk.availableStr], [state.locale.messages.total, disk.totalStr]];
      details.forEach(function(row) {
        detailPopover.appendChild(element('span', 'disk-breakdown-label', row[0]));
        detailPopover.appendChild(element('span', 'disk-breakdown-value', row[1]));
      });
    }
    detailPopover.hidden = false;
    var bounds = button.getBoundingClientRect();
    var centeredLeft = bounds.left + bounds.width / 2 - detailPopover.offsetWidth / 2;
    var left = button.dataset.diskInfo !== undefined || button.dataset.diskIoInfo !== undefined ? bounds.right - detailPopover.offsetWidth : centeredLeft;
    detailPopover.style.left = Math.max(4, Math.min(left, window.innerWidth - detailPopover.offsetWidth - 4)) + 'px';
    var above = bounds.top - detailPopover.offsetHeight - 6;
    detailPopover.style.top = (above >= 4 ? above : Math.min(bounds.bottom + 6, window.innerHeight - detailPopover.offsetHeight - 4)) + 'px';
  }

function bindDetailPopoverButton(button) {
    button.addEventListener('mouseenter', function() { activeDetailButton = button; refreshDetailPopover(); });
    button.addEventListener('mouseleave', function() { hideDetailPopover(button); });
    button.addEventListener('focus', function() { activeDetailButton = button; refreshDetailPopover(); });
    button.addEventListener('blur', function() { hideDetailPopover(button); });
  }

function applyCharts() {
    document.body.classList.toggle('charts-off', state.config.display.charts === false);
    updateSparkAnimation();
  }

function applyTabularNums() {
    document.body.style.fontVariantNumeric = state.config.display.tabularNums !== false ? 'tabular-nums' : '';
  }

function diskBreakdownDescription(disk) {
    return state.locale.messages.diskReserved + ' ' + disk.reservedStr + ' · ' + state.locale.messages.used + ' ' + disk.usedStr + ' · ' + state.locale.messages.avail + ' ' + disk.availableStr + ' · ' + state.locale.messages.total + ' ' + disk.totalStr;
  }

function updateDiskBar(disk) {
    const row = diskRows.get(disk.mount);
    if (!row) return;
    row.reserved.style.width = disk.reservedPct + '%';
    row.fill.style.width = disk.occupiedPct + '%';
    row.fill.className = 'fill ' + colorClass(disk.pct);
  }

function createDiskRow(mount) {
    const node = element('div', 'disk-item');
    node.dataset.mount = mount;
    const header = element('div', 'disk-header'), name = element('span', 'disk-mount', mount);
    name.title = mount;
    const headerAlert = element('button', 'disk-alert disk-header-alert', 'ⓘ');
    const info = element('span', 'disk-info'), meta = element('span', 'disk-meta');
    const usage = element('span', 'disk-usage-wrap'), percent = element('span', 'disk-pct');
    const alert = element('button', 'disk-alert', 'ⓘ');
    usage.append(percent, alert);
    info.append(meta, usage);
    header.append(name, headerAlert, info);
    const track = element('div', 'track disk-track'), fill = element('div', 'fill'), reserved = element('div', 'disk-reserved');
    fill.style.width = '0%';
    reserved.style.width = '0%';
    track.append(fill, reserved);
    const footer = element('div', 'disk-footer'), footerMeta = element('span', 'disk-meta'), footerPercent = element('span', 'disk-pct');
    footer.append(footerMeta, footerPercent);
    node.append(header, track, footer);
    const alerts = [headerAlert, alert];
    alerts.forEach(button => { button.type = 'button'; bindDetailPopoverButton(button); });
    return { node, fill, reserved, meta, percent, footerMeta, footerPercent, alerts, pending: true, disk: null };
  }

function renderDisk(disks, instant) {
    var el = document.getElementById('disk-body');
    state.data.disks = disks || [];
    const keys = new Set(state.data.disks.map(disk => disk.mount));
    for (const [mount, row] of diskRows) if (!keys.has(mount)) {
      if (activeDetailButton && row.node.contains(activeDetailButton)) hideDetailPopover();
      row.node.remove(); diskRows.delete(mount);
    }
    if (!diskRows.size) el.replaceChildren();
    state.ui.renderedDiskKeys = state.data.disks.map(disk => disk.mount);
    state.data.disks.forEach((disk, index) => {
      let row = diskRows.get(disk.mount);
      const created = !row;
      if (!row) { row = createDiskRow(disk.mount); diskRows.set(disk.mount, row); }
      row.disk = disk;
      row.meta.textContent = row.footerMeta.textContent = disk.occupiedStr + ' / ' + disk.totalStr;
      row.percent.textContent = row.footerPercent.textContent = disk.pct + '%';
      row.percent.className = row.footerPercent.className = 'disk-pct ' + colorClass(disk.pct);
      row.alerts.forEach(button => { button.dataset.diskInfo = String(index); button.setAttribute('aria-label', diskBreakdownDescription(disk)); });
      if (el.children[index] !== row.node) el.insertBefore(row.node, el.children[index] || null);
      if (instant || !row.pending) { row.pending = false; updateDiskBar(disk); }
      else if (created) requestAnimationFrame(() => {
        if (diskRows.get(disk.mount) !== row) return;
        row.pending = false; updateDiskBar(row.disk);
      });
    });
    refreshDetailPopover();
  }

function updateCopyBtn() { copyButton.disabled = Object.keys(state.ui.selectedGpus).length === 0; }

function resetCopyButton() {
    copyButton.textContent = tr('copyEnv');
    updateCopyBtn();
  }

function gpuSelectionKey() {
    return state.ui.deviceId || 'local';
  }

function storeGpuSelection() {
    const saved = state.bridge.getState() || {};
    const selections = Object.assign({}, saved.gpuSelection);
    const selected = Object.keys(state.ui.selectedGpus).map(Number);
    if (selected.length) selections[gpuSelectionKey()] = selected;
    else delete selections[gpuSelectionKey()];
    state.bridge.setState(Object.assign({}, saved, { gpuSelection: selections }));
  }

function restoreGpuSelection() {
    const saved = (state.bridge.getState() || {}).gpuSelection;
    const selected = saved && Array.isArray(saved[gpuSelectionKey()]) ? saved[gpuSelectionKey()] : [];
    state.ui.selectedGpus = Object.fromEntries(selected.filter(Number.isInteger).map(function(index) { return [index, true]; }));
  }

function gpuSelectionChanged() {
    document.querySelectorAll('#gpu-capsules .cap').forEach(function(button) {
      button.classList.toggle('sel', button.dataset.free === '1' && !!state.ui.selectedGpus[button.dataset.idx]);
    });
    resetCopyButton();
    storeGpuSelection();
  }

export function initializePerformance() {
  renderGeneration = 0;
  gpuRenderGeneration = 0;
  renderedSources = {};
  renderedTime = null;
  diskRows = new Map();
  gpuCards = new Map();
  infoPopover = element('div', 'gpu-info-popover');
  infoPopover.hidden = true;
  document.body.appendChild(infoPopover);
  activeInfoButton = null;
  window.addEventListener('resize', function() { state.data.gpus.forEach(renderGpuUsers); updateGpuStatsFit(); refreshInfoPopover(); });
  window.addEventListener('blur', function() { hideInfoPopover(); });
  detailPopover = element('div', 'gpu-info-popover detail-popover');
  detailPopover.hidden = true;
  document.body.appendChild(detailPopover);
  activeDetailButton = null;
  state.data.diskIo = null;
  bindDetailPopoverButton(document.getElementById('disk-io-info'));
  window.addEventListener('resize', refreshDetailPopover);
  window.addEventListener('scroll', refreshDetailPopover, true);
  window.addEventListener('blur', function() { hideDetailPopover(); });
  applyCharts();
  applyTabularNums();
  state.ui.renderedDiskKeys = [];
  state.ui.renderedAcceleratorKeys = [];
  state.data.disks = [];
  state.ui.selectedGpus = {};
  state.data.idleIds = [];
  copyButton = document.getElementById('copy-btn');
  document.getElementById('gpu-capsules').addEventListener('click', function(event) {
      var button = event.target.closest('.cap');
      if (!button || button.dataset.free !== '1') return;
      var index = parseInt(button.dataset.idx);
      if (state.ui.selectedGpus[index]) delete state.ui.selectedGpus[index];
      else state.ui.selectedGpus[index] = true;
      gpuSelectionChanged();
    });
  document.getElementById('select-all-btn').addEventListener('click', function() {
      state.data.idleIds.forEach(function(index) { state.ui.selectedGpus[index] = true; });
      gpuSelectionChanged();
    });
  document.getElementById('clear-btn').addEventListener('click', function() {
      state.ui.selectedGpus = {};
      gpuSelectionChanged();
    });
  copyButton.addEventListener('click', function() {
      if (copyButton.disabled) return;
      var ids = Object.keys(state.ui.selectedGpus).map(Number).sort(function(a, b) { return a - b; }).join(',');
      copyText('CUDA_VISIBLE_DEVICES=' + ids).then(function(copied) { copyButton.textContent = copied ? tr('copyEnv') : tr('copyFailed'); });
    });
}

export { renderMonitorSnapshot, applyGroupVisibility, gpuStatsValues, renderGpuUsers, hideInfoPopover, refreshInfoPopover, bindInfoButton, applyCharts, applyTabularNums, restoreGpuSelection };
