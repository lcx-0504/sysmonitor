import { state } from "./state.mjs";
import { renderRatePair, renderSpark, renderGpuSpark, sparkColor } from "./charts.mjs";
import { colorClass, setBar, tagColorClass, tr } from "./ui.mjs";
import { esc, focusGpuProcesses, renderProcessSnapshot, resetProcessView } from "./processes.mjs";
import { updateTopbarLayout } from "./layout.mjs";

let renderGeneration, gpuRenderGeneration, renderedSources, renderedTime, gpuInfoPopover, activeGpuInfoButton, detailPopover, activeDetailButton, copyButton;
let diskRows;

export function resetMonitorView() {
  renderedSources = {};
  renderedTime = null;
  renderGeneration++;
  gpuRenderGeneration++;
  hideGpuInfoPopover();
  if (detailPopover) detailPopover.hidden = true;
  activeDetailButton = null;
  diskRows = new Map();
  state.data.diskIo = null;
  document.getElementById('disk-body').replaceChildren();
  resetProcessView();
}

function renderMonitorSnapshot(viewModel, instant, sampleTime) {
    const generation = ++renderGeneration;
    document.body.classList.toggle('instant-metrics', !!instant);
    const performance = viewModel.performance;
    state.data.gpus = performance.gpus || [];
    renderProcessSnapshot(viewModel);
    function changed(keys, extra = '') {
      const key = keys.join(':');
      const revision = [state.ui.deviceId, state.locale.language, extra, ...keys.map(name => viewModel.sources?.[name]?.revision)].join(':');
      if (!viewModel.sources || renderedSources[key] !== revision) { renderedSources[key] = revision; return true; }
      return false;
    }
    if (changed(['cpu'])) renderCpu(performance);
    if (changed(['memory'])) renderMemory(performance);
    if (changed(['diskTopology', 'diskIo'], performance.disks.map(disk => disk.mount).join('\0'))) {
      const topologyRevision = [state.ui.deviceId, state.locale.language, viewModel.sources?.diskTopology?.revision].join(':');
      const mountsChanged = state.ui.renderedDiskKeys.join('\0') !== performance.disks.map(disk => disk.mount).join('\0');
      const projectionOnly = mountsChanged && !!viewModel.sources && renderedSources.diskTopology === topologyRevision;
      renderedSources.diskTopology = topologyRevision;
      renderStorage(performance, instant || projectionOnly, viewModel.sources?.diskTopology);
    }
    if (changed(['network', 'sshTraffic'])) renderNetwork(performance);
    if (changed(['accelerators'], viewModel.processRevision)) {
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

    // disk I/O
    if (performance.diskIo) {
      var dioEl = document.getElementById('disk-io-val');
      if (dioEl) {
        dioEl.textContent = performance.diskIo.totalText;
        dioEl.removeAttribute('title');
      }
      document.getElementById('disk-io-info').setAttribute('aria-label', tr('diskIoDetails'));
      renderRatePair(state.charts.diskRead, state.charts.diskWrite, 'disk-spark-r-area', 'disk-spark-w-area', 'var(--warn)', 'var(--accent)');
    }

  }

function renderNetwork(performance) {
    var sshCard = document.getElementById('ssh-card');
    var netTitle = document.getElementById('net-title');
    if (performance.sshTraffic && performance.sshTraffic.isSsh) {
      netTitle.textContent = state.locale.messages.srvNet;
      sshCard.style.display = '';
      document.getElementById('ssh-label').textContent = state.locale.messages.localSSH;
      document.getElementById('ssh-tx').textContent = performance.sshTraffic.uploadText;
      document.getElementById('ssh-rx').textContent = performance.sshTraffic.downloadText;
      document.getElementById('ssh-latency').textContent = performance.sshTraffic.latencyText;
      document.getElementById('ssh-latency').title = state.locale.messages.latency + ' · TCP RTT';
      renderRatePair(state.charts.sshTx, state.charts.sshRx, 'ssh-spark-tx-area', 'ssh-spark-rx-area', 'var(--warn)', 'var(--accent)');
      document.getElementById('net-up-label').textContent = state.locale.messages.up;
      document.getElementById('net-down-label').textContent = state.locale.messages.down;
      document.getElementById('ssh-up-label').textContent = state.locale.messages.up;
      document.getElementById('ssh-down-label').textContent = state.locale.messages.down;
    } else {
      netTitle.textContent = state.locale.messages.net;
      sshCard.style.display = 'none';
      document.getElementById('net-up-label').textContent = state.locale.messages.up;
      document.getElementById('net-down-label').textContent = state.locale.messages.down;
    }

    document.getElementById('net-tx').textContent = performance.network.transmitText;
    document.getElementById('net-rx').textContent = performance.network.receiveText;
    renderRatePair(state.charts.netTx, state.charts.netRx, 'net-spark-tx-area', 'net-spark-rx-area', 'var(--warn)', 'var(--accent)');

  }

function renderAccelerators(performance, instant, source) {
    const generation = ++gpuRenderGeneration;
    var gpuBody = document.getElementById('gpu-body');
    var nextGpuCount = performance.gpus ? performance.gpus.length : 0;
    state.data.gpuCount = nextGpuCount;
    if (performance.gpus && performance.gpus.length) {
      var gpuIdentityKeys = performance.gpus.map(function(g) { return JSON.stringify([g.idx, g.deviceKey || String(g.idx)]); });
      Object.keys(state.ui.selectedGpus).forEach(function(index) { if (!performance.gpus.some(function(gpu) { return gpu.idx === parseInt(index) && gpu.isIdle === true; })) delete state.ui.selectedGpus[index]; });
      var gpuSame = gpuIdentityKeys.length === state.ui.renderedAcceleratorKeys.length && gpuIdentityKeys.every(function(k, i) { return k === state.ui.renderedAcceleratorKeys[i]; });
      if (!gpuSame) {
        state.ui.renderedAcceleratorKeys = gpuIdentityKeys;
        var ghtml = '';
        performance.gpus.forEach(function(g) {
          var util = parseInt(g.util) || 0;
          var memPct = g.memPct;
          ghtml += '<div class="gpu-mini" id="gpu-card-' + g.idx + '" data-mine="' + (g.isMine ? '1' : '0') + '">'
            + '<svg class="spark-bg" id="gpu-spark-' + g.idx + '" viewBox="0 0 100 100" preserveAspectRatio="none"><path id="gpu-spark-area-' + g.idx + '" /></svg>'
            + '<div class="gpu-title"><span class="gpu-name">GPU ' + g.idx + '</span><span class="gpu-sub" title="' + esc(g.name) + '"><bdo dir="ltr" id="gpu-name-text-' + g.idx + '">' + esc(g.displayName || g.name) + '</bdo></span></div>'
            + '<div class="bar-label"><span>' + state.locale.messages.utilLabel + '</span><span id="gpu-util-text-' + g.idx + '"><b>' + (Number.isFinite(g.util) ? util + '%' : '--') + '</b> <span class="gpu-link" data-gpu-link="' + g.idx + '">&nearr; ' + state.locale.messages.viewProcs + '</span></span></div>'
            + '<div class="track"><div class="fill ' + colorClass(util) + '" id="gpu-util-' + g.idx + '"></div></div>'
            + '<div class="bar-label"><span>' + state.locale.messages.memLabel + '</span><span class="gpu-mem-wrap"><span class="ltr-ellipsis" id="gpu-mem-text-' + g.idx + '" title="' + esc(g.memPairStr) + '"><bdo dir="ltr">' + esc(g.memPairStr) + '</bdo></span><span class="gpu-pct" id="gpu-mem-pct-' + g.idx + '">' + (Number.isFinite(memPct) ? memPct + '%' : '--') + '</span></span></div>'
            + '<div class="track"><div class="fill ' + colorClass(memPct) + '" id="gpu-mem-' + g.idx + '"></div></div>'
            + '<div class="gpu-footer"><div class="gpu-users" id="gpu-users-' + g.idx + '"></div>'
            + '<div class="gpu-stats" id="gpu-stats-' + g.idx + '">' + gpuStatsMarkup(g) + '</div>'
            + '<button class="gpu-info" id="gpu-info-' + g.idx + '" data-gpu-info="' + g.idx + '" type="button" aria-label="">ⓘ</button></div></div>';
        });
        gpuBody.innerHTML = ghtml;
        performance.gpus.forEach(function(g) { renderGpuUsers(g); });
        applyCharts();
        gpuBody.querySelectorAll('.gpu-info').forEach(function(button) {
          button.addEventListener('mouseenter', function() { showGpuInfoPopover(button); });
          button.addEventListener('mouseleave', function() { hideGpuInfoPopover(button); });
          button.addEventListener('focus', function() { showGpuInfoPopover(button); });
          button.addEventListener('blur', function() { hideGpuInfoPopover(button); });
        });
        gpuBody.querySelectorAll('.gpu-link').forEach(function(el) {
          el.addEventListener('click', function() {
            focusGpuProcesses(this.dataset.gpuLink);
          });
        });
        var updateGpuBars = function() {
          if (generation !== gpuRenderGeneration) return;
          performance.gpus.forEach(function(g) {
            var util = parseInt(g.util) || 0;
            var memPct = g.memPct;
            var ub = document.getElementById('gpu-util-' + g.idx);
            var mb = document.getElementById('gpu-mem-' + g.idx);
            if (ub) ub.style.width = util + '%';
            if (mb) mb.style.width = memPct + '%';
            renderGpuSpark(g);
          });
        };
        if (instant) updateGpuBars(); else requestAnimationFrame(updateGpuBars);
      } else {
        performance.gpus.forEach(function(g) {
          var util = parseInt(g.util) || 0;
          var memPct = g.memPct;
          var ub = document.getElementById('gpu-util-' + g.idx);
          var mb = document.getElementById('gpu-mem-' + g.idx);
          if (ub) { ub.style.width = util + '%'; ub.className = 'fill ' + colorClass(util); }
          if (mb) { mb.style.width = (Number.isFinite(memPct) ? memPct : 0) + '%'; mb.className = 'fill ' + colorClass(memPct); }
          var ut = document.getElementById('gpu-util-text-' + g.idx);
          if (ut) { var b = ut.querySelector('b'); var utilText = Number.isFinite(g.util) ? util + '%' : '--'; if (b) { b.textContent = utilText; } else { var link = ut.querySelector('.gpu-link'); ut.textContent = utilText + ' '; if (link) ut.appendChild(link); } }
          var memoryTextElement = document.getElementById('gpu-mem-text-' + g.idx);
          if (memoryTextElement) { var bdo = memoryTextElement.querySelector('bdo'); if (bdo) bdo.textContent = g.memPairStr; else memoryTextElement.textContent = g.memPairStr; memoryTextElement.title = g.memPairStr; }
          var nameElement = document.getElementById('gpu-name-text-' + g.idx);
          if (nameElement) { nameElement.textContent = g.displayName || g.name; nameElement.parentElement.title = g.name; }
          var mp = document.getElementById('gpu-mem-pct-' + g.idx);
          if (mp) { mp.textContent = Number.isFinite(memPct) ? memPct + '%' : '--'; }
          var statsElement = document.getElementById('gpu-stats-' + g.idx);
          if (statsElement) statsElement.innerHTML = gpuStatsMarkup(g);
          renderGpuSpark(g);
          var card = document.getElementById('gpu-card-' + g.idx);
          if (card) card.dataset.mine = g.isMine ? '1' : '0';
          renderGpuUsers(g);
        });
      }
    } else {
      gpuBody.innerHTML = '';
      state.ui.renderedAcceleratorKeys = [];
      state.ui.selectedGpus = {};
      state.data.idleIds = [];
    }
    refreshGpuInfoPopover();

    var freeCard = document.getElementById('free-gpu-card');
    var capsElem = document.getElementById('gpu-capsules');
    var actElem = document.getElementById('capsule-actions');
    if (performance.gpus && performance.gpus.length) {
      freeCard.style.display = '';
      freeCard.querySelector('.card-head').style.marginBottom = '';
      capsElem.style.display = '';
      actElem.style.display = '';
      gpuBody.style.display = '';
      var caps = document.getElementById('gpu-capsules');
      var freeCount = 0;
      var capsHtml = '';
      performance.gpus.forEach(function(g) {
        var isFree = g.isIdle === true;
        if (isFree) freeCount++;
        var cls = isFree ? (state.ui.selectedGpus[g.idx] ? 'cap sel' : 'cap') : 'cap busy';
        const title = g.availability === 'unknown' ? ' title="' + esc(tr('gpuOccupancyUnavailable')) + '"' : '';
        capsHtml += '<button class="' + cls + '" data-idx="' + g.idx + '" data-free="' + (isFree?1:0) + '"' + title + '>' + g.idx + '</button>';
      });
      caps.innerHTML = capsHtml;
      document.getElementById('gpu-summary').textContent = tr("freeGPUs", { freeCount: performance.gpus.some(g => g.availability === 'unknown') ? '--' : freeCount, performance });
      updateCopyBtn();
      state.data.idleIds = performance.gpus.filter(function(g) { return g.isIdle === true; }).map(function(g){ return g.idx; });
    } else {
      freeCard.style.display = '';
      freeCard.querySelector('.card-head').style.marginBottom = '0';
      document.getElementById('gpu-summary').textContent = source?.state === 'loading' ? '--' : source && source.state !== 'ready' ? tr('collectionFailed') : tr('noGPU');
      capsElem.style.display = 'none';
      actElem.style.display = 'none';
      gpuBody.style.display = 'none';
    }

  }

function applyGroupVisibility() {
    var hidden = state.config.display.hiddenGroups || {};
    var pickerVisible = state.config.display.showGpuPicker !== false && state.data.gpus.length > 0;
    document.getElementById('cpu-card').style.display = hidden.cpu ? 'none' : '';
    document.getElementById('mem-card').style.display = hidden.memory ? 'none' : '';
    document.getElementById('system-row').style.display = hidden.cpu && hidden.memory ? 'none' : '';
    document.getElementById('disk-card').style.display = hidden.disk ? 'none' : '';
    document.getElementById('network-row').style.display = hidden.network ? 'none' : '';
    document.getElementById('free-gpu-card').style.display = hidden.gpuSummary ? 'none' : '';
    document.querySelector('#free-gpu-card .card-head').style.marginBottom = pickerVisible ? '' : '0';
    document.getElementById('gpu-body').style.display = hidden.gpuCards || !state.data.gpus.length ? 'none' : '';
    document.getElementById('gpu-capsules').style.display = pickerVisible ? '' : 'none';
    document.getElementById('capsule-actions').style.display = pickerVisible ? '' : 'none';
    document.querySelectorAll('.gpu-mini').forEach(function(card) { card.classList.toggle('my-gpu', state.config.display.highlightMyGpus !== false && card.dataset.mine === '1'); });
    if (!hidden.gpuCards) state.data.gpus.forEach(renderGpuUsers);
    updateGpuStatsFit();
    if (gpuInfoPopover) refreshGpuInfoPopover();
  }

function gpuStatsDescription(gpu) {
    var details = state.locale.messages.tempLabel + ' ' + (Number.isFinite(gpu.temp) ? gpu.temp + '°C' : '--');
    if (gpu.power) details += ' · ' + state.locale.messages.pwLabel + ' ' + gpu.power.draw + '/' + gpu.power.limit + 'W';
    return details;
  }

function gpuStatsMarkup(gpu) {
    var temp = Number.isFinite(gpu.temp) ? gpu.temp + '°C' : '--';
    var html = '<span><span class="gpu-stat-label">' + state.locale.messages.tempLabel + ' </span><b>' + temp + '</b></span>';
    if (gpu.power) {
      var power = gpu.power.draw + '/' + gpu.power.limit + 'W';
      html += '<span><span class="gpu-stat-label">' + state.locale.messages.pwLabel + ' </span><b>' + power + '</b></span>';
    }
    return html;
  }

function updateGpuStatsFit() {
    var rows = document.querySelectorAll('.gpu-mini .gpu-stats');
    if (!rows.length) return;
    var measure = document.createElement('div');
    measure.className = 'gpu-stats-measure';
    measure.setAttribute('aria-hidden', 'true');
    document.body.appendChild(measure);
    rows.forEach(function(stats) {
      if (stats.style.display === 'none') return;
      var available = stats.getBoundingClientRect().width;
      if (!available) return;
      measure.innerHTML = stats.innerHTML;
      stats.classList.toggle('compact', measure.getBoundingClientRect().width > available);
    });
    measure.remove();
  }

function renderGpuUsers(gpu) {
    var line = document.getElementById('gpu-users-' + gpu.idx);
    if (!line) return;
    var users = gpu.users || [];
    var showUsers = state.config.display.showGpuUsers !== false && users.length > 0;
    var stats = document.getElementById('gpu-stats-' + gpu.idx);
    var info = document.getElementById('gpu-info-' + gpu.idx);
    line.style.display = showUsers ? 'flex' : 'none';
    if (stats) stats.style.display = showUsers ? 'none' : 'flex';
    if (info) {
      info.style.display = showUsers ? 'inline-flex' : 'none';
      info.setAttribute('aria-label', gpuStatsDescription(gpu));
      if (!showUsers && activeGpuInfoButton === info) hideGpuInfoPopover(info);
    }
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

function hideGpuInfoPopover(button) {
    if (button && activeGpuInfoButton !== button) return;
    activeGpuInfoButton = null;
    if (gpuInfoPopover) gpuInfoPopover.hidden = true;
  }

function refreshGpuInfoPopover() {
    var button = activeGpuInfoButton;
    if (!button) return;
    if (!button.isConnected || button.style.display === 'none' || !button.getClientRects().length) { hideGpuInfoPopover(); return; }
    var gpu = state.data.gpus.find(function(device) { return String(device.idx) === button.dataset.gpuInfo; });
    if (!gpu) { hideGpuInfoPopover(); return; }
    gpuInfoPopover.textContent = gpuStatsDescription(gpu);
    gpuInfoPopover.hidden = false;
    var bounds = button.getBoundingClientRect();
    gpuInfoPopover.style.left = Math.max(4, Math.min(bounds.right - gpuInfoPopover.offsetWidth, window.innerWidth - gpuInfoPopover.offsetWidth - 4)) + 'px';
    var above = bounds.top - gpuInfoPopover.offsetHeight - 6;
    gpuInfoPopover.style.top = (above >= 4 ? above : bounds.bottom + 6) + 'px';
  }

function showGpuInfoPopover(button) {
    activeGpuInfoButton = button;
    refreshGpuInfoPopover();
  }

function hideDetailPopover(button) {
    if (button && activeDetailButton !== button) return;
    activeDetailButton = null;
    detailPopover.hidden = true;
  }

function refreshDetailPopover() {
    var button = activeDetailButton;
    if (!button) return;
    if (!button.isConnected || button.style.display === 'none' || !button.getClientRects().length) { hideDetailPopover(); return; }
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
        var label = document.createElement('span');
        label.className = 'disk-breakdown-label';
        label.textContent = row[0];
        var value = document.createElement('span');
        value.className = 'disk-breakdown-value';
        value.textContent = row[1];
        detailPopover.appendChild(label);
        detailPopover.appendChild(value);
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
    var vis = state.config.display.charts !== false ? '' : 'none';
    document.querySelectorAll('.spark-bg').forEach(function(el) { el.style.display = vis; });
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
    const make = (tag, className, text) => {
      const node = document.createElement(tag); node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const node = make('div', 'disk-item'); node.dataset.mount = mount;
    const header = make('div', 'disk-header'), name = make('span', 'disk-mount', mount); name.title = mount;
    const headerAlert = make('button', 'disk-alert disk-header-alert', 'ⓘ');
    const info = make('span', 'disk-info'), meta = make('span', 'disk-meta');
    const usage = make('span', 'disk-usage-wrap'), percent = make('span', 'disk-pct');
    const alert = make('button', 'disk-alert', 'ⓘ');
    usage.append(percent, alert); info.append(meta, usage); header.append(name, headerAlert, info);
    const track = make('div', 'track disk-track'), fill = make('div', 'fill'), reserved = make('div', 'disk-reserved');
    fill.style.width = '0%'; reserved.style.width = '0%'; track.append(fill, reserved);
    const footer = make('div', 'disk-footer'), footerMeta = make('span', 'disk-meta'), footerPercent = make('span', 'disk-pct');
    footer.append(footerMeta, footerPercent); node.append(header, track, footer);
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
      row.fill.id = 'disk-fill-' + index; row.reserved.id = 'disk-reserved-' + index;
      row.meta.id = 'disk-meta-' + index; row.footerMeta.id = 'disk-fmeta-' + index;
      row.percent.id = 'disk-pct-' + index; row.footerPercent.id = 'disk-fpct-' + index;
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

function updateCopyBtn() { document.getElementById('copy-btn').disabled = Object.keys(state.ui.selectedGpus).length === 0; }

export function initializePerformance() {
  renderGeneration = 0;
  gpuRenderGeneration = 0;
  renderedSources = {};
  renderedTime = null;
  diskRows = new Map();
  gpuInfoPopover = document.createElement('div');
  gpuInfoPopover.className = 'gpu-info-popover';
  gpuInfoPopover.hidden = true;
  document.body.appendChild(gpuInfoPopover);
  activeGpuInfoButton = null;
  window.addEventListener('resize', function() { state.data.gpus.forEach(renderGpuUsers); updateGpuStatsFit(); refreshGpuInfoPopover(); });
  window.addEventListener('blur', function() { hideGpuInfoPopover(); });
  detailPopover = document.createElement('div');
  detailPopover.className = 'gpu-info-popover detail-popover';
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
  document.getElementById('gpu-capsules').addEventListener('click', function(e) {
      var btn = e.target;
      if (!btn.dataset || !btn.dataset.idx || btn.dataset.free === '0') return;
      var idx = parseInt(btn.dataset.idx);
      if (state.ui.selectedGpus[idx]) { delete state.ui.selectedGpus[idx]; btn.classList.remove('sel'); }
      else { state.ui.selectedGpus[idx] = true; btn.classList.add('sel'); }
      updateCopyBtn();
    });
  document.getElementById('select-all-btn').addEventListener('click', function() {
      state.data.idleIds.forEach(function(i){ state.ui.selectedGpus[i] = true; });
      document.querySelectorAll('.cap:not(.busy)').forEach(function(b){ b.classList.add('sel'); });
      updateCopyBtn();
    });
  document.getElementById('clear-btn').addEventListener('click', function() {
      state.ui.selectedGpus = {};
      document.querySelectorAll('.cap.sel').forEach(function(b){ b.classList.remove('sel'); });
      updateCopyBtn();
    });
  copyButton = document.getElementById('copy-btn');
  copyButton.addEventListener('click', function() {
      if (this.disabled) return;
      var ids = Object.keys(state.ui.selectedGpus).map(Number).sort(function(a,b){return a-b;}).join(',');
      var ta = document.createElement('textarea'); ta.value = 'CUDA_VISIBLE_DEVICES=' + ids;
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    });
}

export { renderMonitorSnapshot, applyGroupVisibility, gpuStatsDescription, gpuStatsMarkup, updateGpuStatsFit, renderGpuUsers, hideGpuInfoPopover, refreshGpuInfoPopover, showGpuInfoPopover, hideDetailPopover, refreshDetailPopover, bindDetailPopoverButton, applyCharts, applyTabularNums, diskBreakdownDescription, updateDiskBar, renderDisk, updateCopyBtn };
