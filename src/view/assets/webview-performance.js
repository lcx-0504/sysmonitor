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
    if (!showUsers) { line.replaceChildren(); return; }
    if (!line.clientWidth) return;
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
        var more = document.createElement('span');
        more.className = 'gpu-user-more';
        more.textContent = '(+' + (users.length - visible) + ')';
        line.appendChild(more);
      }
      if (line.scrollWidth <= line.clientWidth + 1) break;
    }
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
  var renderedDiskKeys = [], renderedAcceleratorKeys = [];
  function renderDisk(disks) {
    var card = document.getElementById('disk-card');
    var el = document.getElementById('disk-body');
    if (!disks || !disks.length) { card.style.display = 'none'; renderedDiskKeys = []; return; }
    card.style.display = '';
    var keys = disks.map(function(d) { return d.mount; });
    var same = keys.length === renderedDiskKeys.length && keys.every(function(k, i) { return k === renderedDiskKeys[i]; });
    if (!same) {
      renderedDiskKeys = keys;
      var h = '';
      disks.forEach(function(d, i) {
        var cls = colorClass(d.pct);
        h += '<div class="disk-item">'
          + '<div class="disk-header"><span class="disk-mount" title="' + esc(d.mount) + '">' + esc(d.mount) + '</span>'
          + '<span class="disk-info"><span class="disk-meta" id="disk-meta-' + i + '">' + d.usedStr + ' / ' + d.totalStr + '</span><span class="disk-pct ' + cls + '" id="disk-pct-' + i + '">' + d.pct + '%</span></span></div>'
          + '<div class="track"><div class="fill ' + cls + '" id="disk-fill-' + i + '"></div></div>'
          + '<div class="disk-footer"><span class="disk-meta" id="disk-fmeta-' + i + '">' + d.usedStr + ' / ' + d.totalStr + '</span><span class="disk-pct ' + cls + '" id="disk-fpct-' + i + '">' + d.pct + '%</span></div>'
          + '</div>';
      });
      el.innerHTML = h;
      requestAnimationFrame(function() {
        disks.forEach(function(d, i) {
          var fill = document.getElementById('disk-fill-' + i);
          if (fill) fill.style.width = d.pct + '%';
        });
      });
    } else {
      disks.forEach(function(d, i) {
        var cls = colorClass(d.pct);
        var fill = document.getElementById('disk-fill-' + i);
        if (fill) { fill.style.width = d.pct + '%'; fill.className = 'fill ' + cls; }
        var meta = document.getElementById('disk-meta-' + i);
        if (meta) meta.textContent = d.usedStr + ' / ' + d.totalStr;
        var pct = document.getElementById('disk-pct-' + i);
        if (pct) { pct.textContent = d.pct + '%'; pct.className = 'disk-pct ' + cls; }
        var fmeta = document.getElementById('disk-fmeta-' + i);
        if (fmeta) fmeta.textContent = d.usedStr + ' / ' + d.totalStr;
        var fpct = document.getElementById('disk-fpct-' + i);
        if (fpct) { fpct.textContent = d.pct + '%'; fpct.className = 'disk-pct ' + cls; }
      });
    }
  }
