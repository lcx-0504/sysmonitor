  // ── 性能卡片 ──
  function applyGroupVisibility() {
    var hidden = displayCfg.hiddenGroups || {};
    var pickerVisible = displayCfg.showGpuPicker !== false && lastGpuPayload.length > 0;
    document.getElementById('system-row').style.display = hidden.system ? 'none' : '';
    document.getElementById('disk-card').style.display = hidden.disk || !renderedDiskKeys || !renderedDiskKeys.length ? 'none' : '';
    document.getElementById('network-row').style.display = hidden.network ? 'none' : '';
    document.getElementById('free-gpu-card').style.display = hidden.gpuSummary ? 'none' : '';
    document.querySelector('#free-gpu-card .card-head').style.marginBottom = pickerVisible ? '' : '0';
    document.getElementById('gpu-body').style.display = hidden.gpuCards || !lastGpuPayload.length ? 'none' : '';
    document.getElementById('gpu-capsules').style.display = pickerVisible ? '' : 'none';
    document.getElementById('capsule-actions').style.display = pickerVisible ? '' : 'none';
    document.querySelectorAll('.gpu-mini').forEach(function(card) { card.classList.toggle('my-gpu', displayCfg.highlightMyGpus !== false && card.dataset.mine === '1'); });
    if (!hidden.gpuCards) lastGpuPayload.forEach(renderGpuUsers);
    if (gpuInfoPopover) refreshGpuInfoPopover();
  }
  function gpuStatsDescription(gpu) {
    var details = T.tempLabel + ' ' + (gpu.temp || 0) + '°C';
    if (gpu.power) details += ' · ' + T.pwLabel + ' ' + gpu.power.draw + '/' + gpu.power.limit + 'W';
    return details;
  }
  function gpuStatsMarkup(gpu) {
    var temp = (gpu.temp || 0) + '°C';
    var html = '<span>' + T.tempLabel + ' <b>' + temp + '</b></span>';
    if (gpu.power) {
      var power = gpu.power.draw + '/' + gpu.power.limit + 'W';
      html += '<span>' + T.pwLabel + ' <b>' + power + '</b></span>';
    }
    return html;
  }
  function renderGpuUsers(gpu) {
    var line = document.getElementById('gpu-users-' + gpu.idx);
    if (!line) return;
    var users = gpu.users || [];
    var showUsers = displayCfg.showGpuUsers !== false && users.length > 0;
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
  var gpuInfoPopover = document.createElement('div');
  gpuInfoPopover.className = 'gpu-info-popover';
  gpuInfoPopover.hidden = true;
  document.body.appendChild(gpuInfoPopover);
  var activeGpuInfoButton = null;
  function hideGpuInfoPopover(button) {
    if (button && activeGpuInfoButton !== button) return;
    activeGpuInfoButton = null;
    gpuInfoPopover.hidden = true;
  }
  function refreshGpuInfoPopover() {
    var button = activeGpuInfoButton;
    if (!button) return;
    if (!button.isConnected || button.style.display === 'none' || !button.getClientRects().length) { hideGpuInfoPopover(); return; }
    var gpu = lastGpuPayload.find(function(device) { return String(device.idx) === button.dataset.gpuInfo; });
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
  window.addEventListener('resize', function() { lastGpuPayload.forEach(renderGpuUsers); refreshGpuInfoPopover(); });
  window.addEventListener('blur', function() { hideGpuInfoPopover(); });

  var detailPopover = document.createElement('div');
  detailPopover.className = 'gpu-info-popover detail-popover';
  detailPopover.hidden = true;
  document.body.appendChild(detailPopover);
  var activeDetailButton = null;
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
      var gpu = lastGpuPayload.find(function(device) { return String(device.idx) === button.dataset.gpuMore; });
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
      var disk = lastDiskPayload[Number(button.dataset.diskInfo)];
      if (!disk) { hideDetailPopover(); return; }
      detailPopover.classList.remove('stacked');
      detailPopover.classList.add('disk-breakdown');
      detailPopover.replaceChildren();
      [[T.diskReserved, disk.reservedStr], [T.used, disk.usedStr], [T.avail, disk.availableStr], [T.total, disk.totalStr]].forEach(function(row) {
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
    var left = button.dataset.diskInfo !== undefined ? bounds.right - detailPopover.offsetWidth : centeredLeft;
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
  window.addEventListener('resize', refreshDetailPopover);
  window.addEventListener('scroll', refreshDetailPopover, true);
  window.addEventListener('blur', function() { hideDetailPopover(); });

  function applyCharts() {
    var vis = displayCfg.charts !== false ? '' : 'none';
    document.querySelectorAll('.spark-bg').forEach(function(el) { el.style.display = vis; });
  }
  applyCharts();

  function applyTabularNums() {
    document.body.style.fontVariantNumeric = displayCfg.tabularNums !== false ? 'tabular-nums' : '';
  }
  applyTabularNums();

  // ── 磁盘渲染 ──
  var renderedDiskKeys = [], renderedAcceleratorKeys = [], lastDiskPayload = [];
  function diskBreakdownDescription(disk) {
    return T.diskReserved + ' ' + disk.reservedStr + ' · ' + T.used + ' ' + disk.usedStr + ' · ' + T.avail + ' ' + disk.availableStr + ' · ' + T.total + ' ' + disk.totalStr;
  }
  function updateDiskBar(disk, index) {
    var reserved = document.getElementById('disk-reserved-' + index);
    var fill = document.getElementById('disk-fill-' + index);
    if (reserved) reserved.style.width = disk.reservedPct + '%';
    if (fill) { fill.style.width = disk.occupiedPct + '%'; fill.className = 'fill ' + colorClass(disk.pct); }
  }
  function renderDisk(disks) {
    var card = document.getElementById('disk-card');
    var el = document.getElementById('disk-body');
    lastDiskPayload = disks || [];
    if (!disks || !disks.length) { card.style.display = 'none'; renderedDiskKeys = []; hideDetailPopover(); return; }
    card.style.display = '';
    var keys = disks.map(function(d) { return d.mount; });
    var same = keys.length === renderedDiskKeys.length && keys.every(function(k, i) { return k === renderedDiskKeys[i]; });
    if (!same) {
      renderedDiskKeys = keys;
      var h = '';
      disks.forEach(function(d, i) {
        var cls = colorClass(d.pct);
        h += '<div class="disk-item">'
          + '<div class="disk-header"><span class="disk-mount" title="' + esc(d.mount) + '">' + esc(d.mount) + '</span><button class="disk-alert disk-header-alert" data-disk-info="' + i + '" type="button" aria-label="' + esc(diskBreakdownDescription(d)) + '">ⓘ</button>'
          + '<span class="disk-info"><span class="disk-meta" id="disk-meta-' + i + '">' + d.occupiedStr + ' / ' + d.totalStr + '</span><span class="disk-usage-wrap"><span class="disk-pct ' + cls + '" id="disk-pct-' + i + '">' + d.pct + '%</span><button class="disk-alert" data-disk-info="' + i + '" type="button" aria-label="' + esc(diskBreakdownDescription(d)) + '">ⓘ</button></span></span></div>'
          + '<div class="track disk-track"><div class="fill ' + cls + '" id="disk-fill-' + i + '"></div><div class="disk-reserved" id="disk-reserved-' + i + '"></div></div>'
          + '<div class="disk-footer"><span class="disk-meta" id="disk-fmeta-' + i + '">' + d.occupiedStr + ' / ' + d.totalStr + '</span><span class="disk-pct ' + cls + '" id="disk-fpct-' + i + '">' + d.pct + '%</span></div>'
          + '</div>';
      });
      el.innerHTML = h;
      el.querySelectorAll('.disk-alert').forEach(bindDetailPopoverButton);
      requestAnimationFrame(function() {
        disks.forEach(updateDiskBar);
      });
    } else {
      disks.forEach(function(d, i) {
        var cls = colorClass(d.pct);
        updateDiskBar(d, i);
        el.querySelectorAll('[data-disk-info="' + i + '"]').forEach(function(alert) {
          alert.setAttribute('aria-label', diskBreakdownDescription(d));
        });
        var meta = document.getElementById('disk-meta-' + i);
        if (meta) meta.textContent = d.occupiedStr + ' / ' + d.totalStr;
        var pct = document.getElementById('disk-pct-' + i);
        if (pct) { pct.textContent = d.pct + '%'; pct.className = 'disk-pct ' + cls; }
        var fmeta = document.getElementById('disk-fmeta-' + i);
        if (fmeta) fmeta.textContent = d.occupiedStr + ' / ' + d.totalStr;
        var fpct = document.getElementById('disk-fpct-' + i);
        if (fpct) { fpct.textContent = d.pct + '%'; fpct.className = 'disk-pct ' + cls; }
      });
    }
    refreshDetailPopover();
  }
