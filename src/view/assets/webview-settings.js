  // ── 设置模态 ──
  var modalBody = document.getElementById('modal-body');
  var modalScrollbar = document.getElementById('modal-scrollbar');
  var modalScrollbarThumb = document.getElementById('modal-scrollbar-thumb');
  var modalDragOffset = null;
  function updateModalScrollbar() {
    if (!modalOpen) return;
    var viewport = modalBody.clientHeight;
    var overflow = modalBody.scrollHeight - viewport;
    modalScrollbar.hidden = overflow <= 1;
    if (modalScrollbar.hidden) return;
    modalScrollbar.style.top = modalBody.offsetTop + 'px';
    modalScrollbar.style.height = viewport + 'px';
    var thumbHeight = Math.min(viewport, Math.max(28, Math.round(viewport * viewport / modalBody.scrollHeight)));
    modalScrollbarThumb.style.height = thumbHeight + 'px';
    modalScrollbarThumb.style.transform = 'translateY(' + Math.round((viewport - thumbHeight) * modalBody.scrollTop / overflow) + 'px)';
  }
  function scrollModalFromPointer(event) {
    var bounds = modalScrollbar.getBoundingClientRect();
    var travel = bounds.height - modalScrollbarThumb.offsetHeight;
    if (travel <= 0) return;
    var progress = Math.max(0, Math.min(1, (event.clientY - bounds.top - modalDragOffset) / travel));
    modalBody.scrollTop = progress * (modalBody.scrollHeight - modalBody.clientHeight);
  }
  modalScrollbar.addEventListener('pointerdown', function(event) {
    if (modalScrollbar.hidden) return;
    event.preventDefault();
    var thumbBounds = modalScrollbarThumb.getBoundingClientRect();
    modalDragOffset = event.target === modalScrollbarThumb ? event.clientY - thumbBounds.top : thumbBounds.height / 2;
    modalScrollbar.classList.add('dragging');
    modalScrollbar.setPointerCapture(event.pointerId);
    scrollModalFromPointer(event);
  });
  modalScrollbar.addEventListener('pointermove', function(event) {
    if (modalDragOffset !== null) scrollModalFromPointer(event);
  });
  function endModalScrollbarDrag(event) {
    modalDragOffset = null;
    modalScrollbar.classList.remove('dragging');
    if (modalScrollbar.hasPointerCapture(event.pointerId)) modalScrollbar.releasePointerCapture(event.pointerId);
  }
  modalScrollbar.addEventListener('pointerup', endModalScrollbarDrag);
  modalScrollbar.addEventListener('pointercancel', endModalScrollbarDrag);
  modalBody.addEventListener('scroll', updateModalScrollbar);
  window.addEventListener('resize', updateModalScrollbar);

  function openModal() {
    modalOpen = true;
    document.getElementById('modal-mask').classList.add('open');
    document.getElementById('modal-title-text').textContent = T.settTitle;
    document.getElementById('sett-interval-label').textContent = T.interval;
    document.getElementById('sett-bar-label').textContent = T.statusBar;
    document.getElementById('sett-disk-label').textContent = T.diskLabel;
    document.getElementById('sett-display-label').textContent = T.displayLabel;
    renderIntervalRow();
    renderSettingsBody();
    requestAnimationFrame(updateModalScrollbar);
  }
  function closeModal() { closeSettingMenu(); modalOpen = false; modalScrollbar.hidden = true; document.getElementById('modal-mask').classList.remove('open'); }
  document.getElementById('settings-btn').addEventListener('click', openModal);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-mask').addEventListener('click', function(e){ if (e.target===this) closeModal(); });
  document.getElementById('open-vsc-settings').addEventListener('click', function(){ sendToExtension({cmd:'openSettings'}); });
  document.addEventListener('click', function(e) {
    var a = e.target.closest('a[href]');
    if (a && a.href) { e.preventDefault(); sendToExtension({cmd:'openLink', url:a.href}); }
  });

  function renderIntervalRow() {
    var row = document.getElementById('interval-row');
    row.innerHTML = '';
    [1,2,5,10].forEach(function(s) {
      var b = document.createElement('button');
      b.className = 'tb' + (curInterval===s?' on':'');
      b.textContent = s+(zh?'秒':'s');
      b.addEventListener('click', function(){ curInterval=s; renderIntervalRow(); sendToExtension({cmd:'setConfig',key:'refreshInterval',value:s}); });
      row.appendChild(b);
    });
    var custom = document.createElement('input');
    custom.className = 'sett-input';
    custom.type = 'number';
    custom.min = '1'; custom.max = '30'; custom.value = curInterval;
    custom.title = zh ? '自定义秒数（1–30）' : 'Custom seconds (1–30)';
    custom.addEventListener('change', function() {
      var value = Math.max(1, Math.min(30, parseInt(this.value) || 2));
      curInterval = value;
      sendToExtension({cmd:'setConfig',key:'refreshInterval',value:value});
      renderIntervalRow();
    });
    row.appendChild(custom);
  }
  function getCfg() { return barCfg; }
  var configPushTimer = null;
  function pushCfg() {
    if (configPushTimer) clearTimeout(configPushTimer);
    configPushTimer = setTimeout(function() {
      configPushTimer = null;
      sendToExtension({cmd:'setConfig',key:'statusBar',value:barCfg});
    }, 300);
  }

  function settingRow(label, control, hint, wideControl) {
    return '<div class="setting-row"><span class="setting-info"><span class="setting-title"' + (hint ? ' title="' + esc(hint) + '"' : '') + '>' + label + '</span>' + (hint ? '<small>' + esc(hint) + '</small>' : '') + '</span><span class="setting-control' + (wideControl ? ' wide' : '') + '">' + control + '</span></div>';
  }
  function switchButton(action, enabled, key, disabled) {
    return '<button type="button" class="setting-switch' + (enabled ? ' on' : '') + '" role="switch" aria-checked="' + enabled + '" data-act="' + action + '"' + (key ? ' data-key="' + key + '"' : '') + (disabled ? ' disabled' : '') + '><span></span></button>';
  }
  function selectControl(action, current, options, key) {
    var selected = options.find(function(option) { return option[0] === current; }) || options[0];
    return '<span class="setting-select-wrap"><span class="setting-select-sizer" aria-hidden="true">' + options.map(function(option) { return '<span>' + esc(option[1]) + '</span>'; }).join('') + '</span><button type="button" class="setting-select" data-act="' + action + '" data-value="' + esc(current) + '"' + (key ? ' data-key="' + key + '"' : '') + ' aria-haspopup="listbox" aria-expanded="false"><span>' + esc(selected[1]) + '</span><span aria-hidden="true">⌄</span></button><span class="setting-select-options" hidden>' + options.map(function(option) { return '<button type="button" data-value="' + esc(option[0]) + '"' + (current === option[0] ? ' class="selected"' : '') + '>' + esc(option[1]) + '</button>'; }).join('') + '</span></span>';
  }

  var settingMenu = null, settingMenuTrigger = null;
  function closeSettingMenu() {
    if (settingMenu) settingMenu.remove();
    if (settingMenuTrigger) settingMenuTrigger.setAttribute('aria-expanded', 'false');
    settingMenu = null; settingMenuTrigger = null;
  }
  function openSettingMenu(trigger, onSelect) {
    if (settingMenuTrigger === trigger) { closeSettingMenu(); return; }
    closeSettingMenu();
    var options = trigger.parentElement.querySelectorAll('.setting-select-options button');
    var menu = document.createElement('div');
    menu.className = 'setting-menu';
    menu.setAttribute('role', 'listbox');
    options.forEach(function(option) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'setting-menu-item' + (option.classList.contains('selected') ? ' selected' : '');
      item.textContent = option.textContent;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', option.classList.contains('selected') ? 'true' : 'false');
      item.addEventListener('click', function(event) { event.stopPropagation(); var value = option.dataset.value; closeSettingMenu(); onSelect(value); });
      menu.appendChild(item);
    });
    document.body.appendChild(menu);
    var rect = trigger.getBoundingClientRect();
    menu.style.minWidth = rect.width + 'px';
    menu.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 4)) + 'px';
    menu.style.top = (window.innerHeight - rect.bottom >= menu.offsetHeight + 4 ? rect.bottom + 3 : Math.max(4, rect.top - menu.offsetHeight - 3)) + 'px';
    trigger.setAttribute('aria-expanded', 'true');
    settingMenu = menu; settingMenuTrigger = trigger;
  }
  document.addEventListener('click', function(event) { if (settingMenu && !settingMenu.contains(event.target)) closeSettingMenu(); });
  document.getElementById('modal-body').addEventListener('scroll', closeSettingMenu);
  window.addEventListener('resize', closeSettingMenu);
  document.addEventListener('keydown', function(event) { if (event.key === 'Escape') closeSettingMenu(); });

  function animateSwitch(button, enabled, rerender) {
    button.classList.toggle('on', enabled);
    button.setAttribute('aria-checked', String(enabled));
    if (rerender) setTimeout(function() { if (modalOpen) renderSettingsBody(); }, 190);
  }

  function renderSettingsBody() {
    var cfg = getCfg();
    var gpu = cfg.gpu || {};
    var body = document.getElementById('sett-body');
    var h = '';

    var barOn = cfg.barEnabled !== false;
    h += settingRow(T.barToggle, switchButton('bar-toggle', barOn));
    if (barOn) {
    var curAlign = cfg.alignment || 'left';
    h += settingRow(T.barAlign, '<span class="setting-segment"><button class="'+(curAlign==='left'?'on':'')+'" data-act="radio" data-key="alignment" data-val="left">'+(zh?'左':'Left')+'</button><button class="'+(curAlign==='right'?'on':'')+'" data-act="radio" data-key="alignment" data-val="right">'+(zh?'右':'Right')+'</button></span>');
    var curPri = typeof cfg.priority === 'number' ? cfg.priority : 10;
    h += settingRow(T.barPriority, '<input class="sett-input" id="bar-priority-input" type="number" min="0" max="10000" value="'+curPri+'" />', T.barPriorityTip);
    h += settingRow('CPU', switchButton('bool', !!cfg.cpu, 'cpu'));
    h += settingRow('RAM', switchButton('bool', !!cfg.ram, 'ram'));
    h += settingRow(T.diskUsage, switchButton('bool', !!cfg.disk, 'disk'));
    h += settingRow(T.diskIO, selectControl('select', cfg.diskIO || 'off', [['off',T.scopeOff],['read',T.diskIORead],['write',T.diskIOWrite],['both',T.netAll],['combined',T.netMerge]], 'diskIO'));
    h += settingRow(T.netLabel, selectControl('select', cfg.net || 'off', [['off',T.scopeOff],['up',T.netUp],['down',T.netDown],['both',T.netAll],['combined',T.netMerge]], 'net'));
    h += settingRow(T.sshLabel, switchButton('bool', !!cfg.ssh, 'ssh'));
    h += settingRow(T.gpuSummary, switchButton('gpu-summary', !!gpu.summary));
    if (gpu.summary) {
      h += settingRow(T.gpuIdleIds, switchButton('gpu-idle-ids', !!gpu.showIdleIds));
    }

    var gpuMode = gpu.mode || 'off';
    h += settingRow(T.gpuPerf, selectControl('gpu-mode', gpuMode, [['off',T.scopeOff],['all',T.gpuAll],['first',T.gpuFirst],['specify',T.gpuSpecify],['my',T.scopeMy]]));

    if (gpuMode === 'first') {
      var fv = gpu.firstN || 2;
      h += settingRow(T.gpuFirst, '<input class="sett-input" id="gpu-first-input" type="number" min="1" max="1024" value="'+fv+'" />');
    }

    if (gpuMode === 'specify') {
      var val = (gpu.cards||[]).join(',');
      h += settingRow(T.gpuSpecify, '<input class="sett-input" id="gpu-cards-input" value="'+esc(val)+'" placeholder="0,1,3" /><span class="sett-err" id="gpu-cards-err"></span>');
    }

    if (gpuMode !== 'off') {
      var met = gpu.metric || 'both';
      h += settingRow(T.gpuMetric, selectControl('gpu-metric', met, [['util',T.metUtil],['vram',T.metVram],['both',T.metBoth]]));
      h += settingRow(T.gpuSkipIdle, switchButton('gpu-skip-idle', !!gpu.skipIdle));
    }
    }

    body.innerHTML = h;
    bindSettingsEvents(body, cfg);

    var diskBody = document.getElementById('sett-disk-body');
    var curFilter = diskCfg.mountFilter || 'default';
    var dh = settingRow(T.diskFilter, selectControl('disk-filter', curFilter, [['default',T.diskDefault],['more',T.diskMore],['all',T.diskAll],['custom',T.diskCustom]]));
    var isCustom = curFilter === 'custom';
    var presetVals = {default:{fs:'vfat',paths:'/proc,/sys,/run,/snap,/usr,/etc,/dev,/init',vfs:false},more:{fs:'',paths:'',vfs:false},all:{fs:'',paths:'',vfs:true}};
    var showFs, showPaths, showVfs;
    if (isCustom) {
      showFs = diskCfg.customFsExclude || '';
      showPaths = diskCfg.customPathExclude || '';
      showVfs = diskCfg.showVirtualFs;
    } else {
      var pv = presetVals[curFilter] || presetVals['default'];
      showFs = pv.fs; showPaths = pv.paths; showVfs = pv.vfs;
    }
    dh += '<div class="custom-group' + (isCustom ? '' : ' dim') + '">';
    dh += settingRow(T.diskShowVirtual, switchButton('disk-show-virtual', !showVfs, null, !isCustom), T.diskShowVirtualTip);
    dh += settingRow(T.diskExcludeFs, '<input class="sett-input wide" id="disk-fs-input" type="text" value="' + esc(showFs) + '"' + (isCustom ? '' : ' readonly') + ' />', T.diskExcludeFsTip, true);
    dh += settingRow(T.diskExcludePath, '<input class="sett-input wide" id="disk-path-input" type="text" value="' + esc(showPaths) + '"' + (isCustom ? '' : ' readonly') + ' />', T.diskExcludePathTip, true);
    dh += '</div>';
    dh += settingRow(T.diskHideParent, switchButton('disk-hide-parent', diskCfg.hideParentMounts !== false), T.diskHideParentTip);
    diskBody.innerHTML = dh;
    diskBody.querySelector('[data-act="disk-filter"]').addEventListener('click', function(event) {
      event.stopPropagation();
      openSettingMenu(this, function(val) {
        if (val === 'custom' && curFilter !== 'custom') {
          var existFs = diskCfg.customFsExclude || '';
          var existPaths = diskCfg.customPathExclude || '';
          var existVfs = !!diskCfg.showVirtualFs;
          var presets = [
            {fs:'vfat',paths:'/proc,/sys,/run,/snap,/usr,/etc,/dev,/init',vfs:false},
            {fs:'',paths:'',vfs:false},
            {fs:'',paths:'',vfs:true}
          ];
          var matchesPreset = presets.some(function(p){ return existFs===p.fs && existPaths===p.paths && existVfs===p.vfs; });
          if (matchesPreset) {
            diskCfg.customFsExclude = showFs;
            diskCfg.customPathExclude = showPaths;
            diskCfg.showVirtualFs = showVfs;
          }
        }
        diskCfg.mountFilter = val;
        sendToExtension({cmd:'setConfig',key:'disk',value:diskCfg});
        renderSettingsBody();
      });
    });
    if (curFilter === 'custom') {
      var vfsBtn = diskBody.querySelector('[data-act="disk-show-virtual"]');
      if (vfsBtn) vfsBtn.addEventListener('click', function() {
        diskCfg.showVirtualFs = !diskCfg.showVirtualFs;
        sendToExtension({cmd:'setConfig',key:'disk',value:diskCfg});
        animateSwitch(this, !diskCfg.showVirtualFs);
      });
      var diskConfigTimer = null;
      function onDiskCustomInput() {
        if (diskConfigTimer) clearTimeout(diskConfigTimer);
        diskConfigTimer = setTimeout(function() {
          var fsInput = document.getElementById('disk-fs-input');
          var pathInput = document.getElementById('disk-path-input');
          if (fsInput) diskCfg.customFsExclude = fsInput.value;
          if (pathInput) diskCfg.customPathExclude = pathInput.value;
          sendToExtension({cmd:'setConfig',key:'disk',value:diskCfg});
        }, 600);
      }
      var fsInput = document.getElementById('disk-fs-input');
      var pathInput = document.getElementById('disk-path-input');
      if (fsInput) fsInput.addEventListener('input', onDiskCustomInput);
      if (pathInput) pathInput.addEventListener('input', onDiskCustomInput);
    }
    var hideParentBtn = diskBody.querySelector('[data-act="disk-hide-parent"]');
    if (hideParentBtn) hideParentBtn.addEventListener('click', function() {
      diskCfg.hideParentMounts = !diskCfg.hideParentMounts;
      sendToExtension({cmd:'setConfig',key:'disk',value:diskCfg});
      animateSwitch(this, diskCfg.hideParentMounts);
    });

    var dispBody = document.getElementById('sett-display-body');
    var dph = settingRow(T.chartsToggle, switchButton('charts-toggle', displayCfg.charts !== false));
    dph += settingRow(T.sparkLabel, selectControl('spark-min', String(displayCfg.sparkMinutes || 5), [1,2,5,10,30].map(function(m) { return [String(m), m + (zh?' 分钟':' min')]; })));
    dph += settingRow(T.tabularNums, switchButton('tabular-toggle', displayCfg.tabularNums !== false), T.tabularNumsTip);
    var groupLabels = {system:T.systemGroup,disk:T.diskLabel,network:T.networkGroup,gpuSummary:T.gpuSummaryGroup,gpuCards:T.gpuCardsGroup};
    Object.keys(groupLabels).forEach(function(key) {
      dph += settingRow(groupLabels[key], switchButton('group-toggle', !(displayCfg.hiddenGroups || {})[key], key));
    });
    dph += settingRow(T.myGpuBorder, switchButton('my-gpu-toggle', displayCfg.highlightMyGpus !== false));
    dph += settingRow(T.gpuPicker, switchButton('gpu-picker-toggle', displayCfg.showGpuPicker !== false));
    dph += settingRow(T.gpuUsers, switchButton('gpu-users-toggle', displayCfg.showGpuUsers !== false));
    dispBody.innerHTML = dph;
    dispBody.querySelector('[data-act="charts-toggle"]').addEventListener('click', function() {
      displayCfg.charts = !displayCfg.charts;
      sendToExtension({cmd:'setConfig',key:'display',value:displayCfg});
      applyCharts();
      animateSwitch(this, displayCfg.charts);
    });
    dispBody.querySelector('[data-act="tabular-toggle"]').addEventListener('click', function() {
      displayCfg.tabularNums = !displayCfg.tabularNums;
      sendToExtension({cmd:'setConfig',key:'display',value:displayCfg});
      applyTabularNums();
      animateSwitch(this, displayCfg.tabularNums);
    });
    dispBody.querySelector('[data-act="spark-min"]').addEventListener('click', function(event) {
      event.stopPropagation();
      openSettingMenu(this, function(value) {
        displayCfg.sparkMinutes = parseInt(value);
        SPARK_WINDOW = displayCfg.sparkMinutes * 60 * 1000;
        sendToExtension({cmd:'setConfig',key:'display',value:displayCfg});
        renderSettingsBody();
      });
    });
    dispBody.querySelectorAll('[data-act="group-toggle"]').forEach(function(button) {
      button.addEventListener('click', function() {
        if (!displayCfg.hiddenGroups) displayCfg.hiddenGroups = {};
        displayCfg.hiddenGroups[this.dataset.key] = !displayCfg.hiddenGroups[this.dataset.key];
        sendToExtension({cmd:'setConfig',key:'display',value:displayCfg});
        applyGroupVisibility();
        animateSwitch(this, !displayCfg.hiddenGroups[this.dataset.key]);
      });
    });
    dispBody.querySelector('[data-act="my-gpu-toggle"]').addEventListener('click', function() {
      displayCfg.highlightMyGpus = displayCfg.highlightMyGpus === false;
      sendToExtension({cmd:'setConfig',key:'display',value:displayCfg});
      applyGroupVisibility();
      animateSwitch(this, displayCfg.highlightMyGpus);
    });
    dispBody.querySelector('[data-act="gpu-picker-toggle"]').addEventListener('click', function() {
      displayCfg.showGpuPicker = displayCfg.showGpuPicker === false;
      sendToExtension({cmd:'setConfig',key:'display',value:displayCfg});
      applyGroupVisibility();
      animateSwitch(this, displayCfg.showGpuPicker);
    });
    dispBody.querySelector('[data-act="gpu-users-toggle"]').addEventListener('click', function() {
      displayCfg.showGpuUsers = displayCfg.showGpuUsers === false;
      sendToExtension({cmd:'setConfig',key:'display',value:displayCfg});
      applyGroupVisibility();
      animateSwitch(this, displayCfg.showGpuUsers);
    });
    if (modalOpen) requestAnimationFrame(updateModalScrollbar);
  }

  function bindSettingsEvents(body, cfg) {
    body.querySelectorAll('button.setting-select[data-act]').forEach(function(trigger) {
      trigger.addEventListener('click', function(event) {
        event.stopPropagation();
        var action = this.dataset.act;
        var key = this.dataset.key;
        openSettingMenu(this, function(value) {
          if (action === 'select') cfg[key] = value;
          else if (action === 'gpu-mode') cfg.gpu.mode = value;
          else if (action === 'gpu-metric') cfg.gpu.metric = value;
          pushCfg();
          renderSettingsBody();
        });
      });
    });
    var priInput = document.getElementById('bar-priority-input');
    if (priInput) {
      priInput.addEventListener('input', function() {
        var n = parseInt(this.value);
        if (isNaN(n) || n < 0) n = 10;
        cfg.priority = n;
        pushCfg();
      });
    }
    var cardsInput = document.getElementById('gpu-cards-input');
    if (cardsInput) {
      cardsInput.addEventListener('input', function() {
        var raw = this.value.trim();
        var errEl = document.getElementById('gpu-cards-err');
        if (!raw) { cfg.gpu.cards = []; errEl.textContent = ''; pushCfg(); return; }
        var parts = raw.split(',');
        var valid = true, nums = [];
        parts.forEach(function(s) {
          var n = parseInt(s.trim());
          if (isNaN(n) || n < 0) valid = false;
          else nums.push(n);
        });
        if (!valid) { errEl.textContent = zh?'格式错误，请用逗号分隔数字':'Invalid format'; this.classList.add('err'); return; }
        this.classList.remove('err');
        var badCards = nums.filter(function(n){ return n >= gpuCount; });
        errEl.textContent = badCards.length ? (zh?'卡 '+badCards.join(',')+' 不存在，将不显示':'Card '+badCards.join(',')+' not found') : '';
        cfg.gpu.cards = nums;
        cfg.gpu.cards.sort(function(a,b){return a-b;});
        pushCfg();
      });
    }

    var firstInput = document.getElementById('gpu-first-input');
    if (firstInput) {
      firstInput.addEventListener('input', function() {
        var n = parseInt(this.value);
        if (isNaN(n) || n < 1) n = 1;
        if (n > 1024) n = 1024;
        cfg.gpu.firstN = n;
        pushCfg();
      });
    }

    body.querySelectorAll('.setting-switch, .setting-segment button').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var a = this.dataset.act;
        if (a==='bool') { cfg[this.dataset.key] = !cfg[this.dataset.key]; }
        else if (a==='radio') { cfg[this.dataset.key] = this.dataset.val; }
        else if (a==='gpu-summary') { cfg.gpu.summary = !cfg.gpu.summary; }
        else if (a==='gpu-idle-ids') { cfg.gpu.showIdleIds = !cfg.gpu.showIdleIds; }
        else if (a==='gpu-mode') {
          cfg.gpu.mode = this.dataset.val;
        }
        else if (a==='gpu-metric') { cfg.gpu.metric = this.dataset.val; }
        else if (a==='gpu-skip-idle') { cfg.gpu.skipIdle = !cfg.gpu.skipIdle; }
        else if (a==='bar-toggle') { cfg.barEnabled = !(cfg.barEnabled !== false); }
        pushCfg();
        if (a === 'radio') {
          this.parentElement.querySelectorAll('button').forEach(function(button) { button.classList.toggle('on', button === btn); });
        } else if (a === 'bar-toggle') animateSwitch(this, cfg.barEnabled, true);
        else if (a === 'gpu-summary') animateSwitch(this, cfg.gpu.summary, true);
        else if (a === 'bool') animateSwitch(this, !!cfg[this.dataset.key]);
        else if (a === 'gpu-idle-ids') animateSwitch(this, !!cfg.gpu.showIdleIds);
        else if (a === 'gpu-skip-idle') animateSwitch(this, !!cfg.gpu.skipIdle);
      });
    });
  }
