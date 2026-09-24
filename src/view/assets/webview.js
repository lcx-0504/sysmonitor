  var vscode = acquireVsCodeApi();
  function sendToExtension(message) { vscode.postMessage(Object.assign({ version: 1 }, message)); }
  var zh = true, T = {}, paused = false;

  function colorClass(p) { return p >= 90 ? 'danger' : p >= 70 ? 'warn' : ''; }
  function tagColorClass(p) { return 'tag-' + (colorClass(p) || 'accent'); }
  function setBar(id, percent) { var barElement = document.getElementById(id); if (barElement) { barElement.style.width = percent + '%'; barElement.className = 'fill ' + colorClass(percent); } }

  function setLang(lang) {
    zh = lang && lang.startsWith('zh');
    T = zh
      ? { min:' 分钟',cores:' 核',used:'已用',avail:'可用',total:'总计',srvNet:'服务器网络',net:'网络',localSSH:'本机 SSH',up:'↑ 上传',down:'↓ 下载',selAll:'全选空闲',clear:'清除',copyEnv:'复制环境变量',detecting:'检测中…',noGpu:'未检测到 GPU',updAt:'更新于 ',utilLabel:'利用率',memLabel:'显存',tempLabel:'温度',pwLabel:'功耗',
          perfTab:'性能',procTab:'进程',settBtn:'设置',running:'运行中',stopped:'已暂停',enabled:'已开启',disabled:'已关闭',settTitle:'设置',interval:'刷新间隔',statusBar:'状态栏',barToggle:'显示状态栏',barAlign:'位置',barPriority:'优先级',barPriorityTip:'数值越大越靠边（默认 10）',close:'关闭',
          netLabel:'网络速率',gpuLabel:'GPU',
          scopeOff:'关',scopeSummary:'总览',scopeCard:'指定卡',scopeMy:'我的卡',metUtil:'仅利用率',metVram:'仅显存',metBoth:'全部显示',
          netUp:'仅上传',netDown:'仅下载',netAll:'全部显示',netMerge:'合并显示',
          sshLabel:'SSH速率',gpuSummary:'GPU总览',gpuIdleIds:'显示空闲卡号',gpuPerf:'GPU性能显示',gpuAll:'所有卡',gpuSpecify:'指定卡',gpuFirst:'前几张',gpuMetric:'GPU显示指标',gpuSkipIdle:'隐藏空闲卡',viewProcs:'查看进程',
          diskLabel:'磁盘',diskUsage:'磁盘容量',diskIO:'磁盘速率',diskIORead:'仅读',diskIOWrite:'仅写',diskNoData:'无磁盘数据',diskFilter:'挂载过滤',diskDefault:'默认',diskMore:'更多',diskAll:'全部',diskCustom:'自定义',diskShowVirtual:'排除虚拟 FS',diskShowVirtualTip:'如 tmpfs、sysfs、proc',diskExcludeFs:'排除 FS 类型',diskExcludeFsTip:'如 vfat、ntfs、fuse',diskExcludePath:'排除路径前缀',diskExcludePathTip:'如 /proc、/sys、/run',diskHideParent:'仅显示叶子挂载点',diskHideParentTip:'父子挂载并存时仅显示子挂载，如 /autodl-fs/data',
          displayLabel:'显示',chartsToggle:'卡片背景图表',sparkLabel:'图表时长',tabularNums:'等宽数字',tabularNumsTip:'数字等宽，减少布局跳动',
          pcpu:'CPU',pmem:'内存',pgpu:'GPU',ppid:'PID',puser:'用户',pname:'进程名',pcpuPct:'CPU',pmemCol:'内存',pgpuCol:'GPU',pcount:'共 {n} 进程',pnoGpu:'—',pcmd:'命令',filterHint:'搜索进程...',coreMode:'单核',wholeMode:'整机',bothMode:'都显示',sizeMode:'占用量',percentMode:'占比',expand:'展开',collapse:'收起',latency:'延迟',systemGroup:'CPU + 内存',networkGroup:'网络',gpuSummaryGroup:'GPU 总览',gpuCardsGroup:'GPU 卡片',myGpuBorder:'标记我的 GPU',gpuPicker:'空闲 GPU 选择器',gpuUsers:'GPU 占用用户',openEditor:'在编辑器中打开' }
      : { min:' min',cores:' cores',used:'Used',avail:'Avail',total:'Total',srvNet:'Server Net',net:'Network',localSSH:'Local SSH',up:'↑ Up',down:'↓ Down',selAll:'Select All',clear:'Clear',copyEnv:'Copy Env Var',detecting:'Detecting…',noGpu:'No GPU detected',updAt:'Updated ',utilLabel:'Util',memLabel:'VRAM',tempLabel:'Temp',pwLabel:'Power',
          perfTab:'Perf',procTab:'Procs',settBtn:'Settings',running:'Running',stopped:'Paused',enabled:'Enabled',disabled:'Disabled',settTitle:'Settings',interval:'Refresh Interval',statusBar:'Status Bar',barToggle:'Show Status Bar',barAlign:'Position',barPriority:'Priority',barPriorityTip:'Higher values move toward the edge (default 10)',close:'Close',
          netLabel:'Network',gpuLabel:'GPU',
          scopeOff:'Off',scopeSummary:'Summary',scopeCard:'Card',scopeMy:'My Card',metUtil:'Util Only',metVram:'VRAM Only',metBoth:'All',
          netUp:'Upload',netDown:'Download',netAll:'All',netMerge:'Merged',
          sshLabel:'SSH Traffic',gpuSummary:'GPU Summary',gpuIdleIds:'Show Idle IDs',gpuPerf:'GPU Performance',gpuAll:'All Cards',gpuSpecify:'Specific',gpuFirst:'First N',gpuMetric:'GPU Metric',gpuSkipIdle:'Hide Idle',viewProcs:'View Procs',
          diskLabel:'Disk',diskUsage:'Disk Usage',diskIO:'Disk I/O',diskIORead:'Read',diskIOWrite:'Write',diskNoData:'No disk data',diskFilter:'Mount Filter',diskDefault:'Default',diskMore:'More',diskAll:'All',diskCustom:'Custom',diskShowVirtual:'Exclude Virtual FS',diskShowVirtualTip:'e.g. tmpfs, sysfs, proc',diskExcludeFs:'Exclude FS Type',diskExcludeFsTip:'e.g. vfat, ntfs, fuse',diskExcludePath:'Exclude Path Prefix',diskExcludePathTip:'e.g. /proc, /sys, /run',diskHideParent:'Leaf mounts only',diskHideParentTip:'Show only child mounts, e.g. /autodl-fs/data',
          displayLabel:'Display',chartsToggle:'Card Background Charts',sparkLabel:'Chart Duration',tabularNums:'Tabular Numbers',tabularNumsTip:'Equal-width digits reduce layout shifts',
          pcpu:'CPU',pmem:'Memory',pgpu:'GPU',ppid:'PID',puser:'User',pname:'Process',pcpuPct:'CPU',pmemCol:'Memory',pgpuCol:'GPU',pcount:'{n} processes',pnoGpu:'—',pcmd:'Command',filterHint:'Search...',coreMode:'Core',wholeMode:'Machine',bothMode:'Both',sizeMode:'Used',percentMode:'Percent',expand:'Expand',collapse:'Collapse',latency:'Latency',systemGroup:'CPU + RAM',networkGroup:'Network',gpuSummaryGroup:'GPU Overview',gpuCardsGroup:'GPU Cards',myGpuBorder:'Highlight my GPUs',gpuPicker:'Idle GPU Picker',gpuUsers:'GPU Users',openEditor:'Open in Editor' };
    document.getElementById('l-1m').textContent = '1' + T.min;
    document.getElementById('l-5m').textContent = '5' + T.min;
    document.getElementById('l-15m').textContent = '15' + T.min;
    document.getElementById('l-used').textContent = T.used;
    document.getElementById('l-avail').textContent = T.avail;
    document.getElementById('l-total').textContent = T.total;
    document.getElementById('disk-label').textContent = T.diskLabel;
    document.getElementById('select-all-btn').textContent = T.selAll;
    document.getElementById('clear-btn').textContent = T.clear;
    document.getElementById('copy-btn').textContent = T.copyEnv;
    document.getElementById('tab-perf-btn').textContent = T.perfTab;
    document.getElementById('tab-proc-btn').textContent = T.procTab;
    document.getElementById('settings-btn').textContent = T.settBtn;
    document.getElementById('pause-btn').textContent = paused ? T.stopped : T.running;
    document.getElementById('proc-filter').placeholder = T.filterHint || '';
    renderProcToolbar();
  }
  setLang('zh');

  // ── 趋势图（时间基准）──
  var SPARK_WINDOW = 5 * 60 * 1000;
  var cpuHist = [], ramHist = [], netTxHist = [], netRxHist = [], sshTxHist = [], sshRxHist = [], diskRHist = [], diskWHist = [], gpuHist = {};

  function sparkColor(pct) {
    return pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warn)' : 'var(--accent)';
  }
  function sparkDisplayTime(hist) {
    if (hist.length < 2) return Date.now();
    var latest = hist[hist.length - 1];
    var previous = hist[hist.length - 2];
    var progress = Math.max(0, Math.min(1, (Date.now() - latest.t) / Math.max(1, (curInterval || 2) * 1000)));
    return previous.t + (latest.t - previous.t) * progress;
  }
  function sparkPaths(hist, maxVal) {
    if (hist.length < 2) return null;
    var now = sparkDisplayTime(hist);
    var t0 = now - SPARK_WINDOW;
    var pts = [];
    var firstInside = 0;
    while (firstInside < hist.length && hist[firstInside].t < t0) firstInside++;
    if (firstInside > 0 && firstInside < hist.length) {
      var before = hist[firstInside - 1], after = hist[firstInside];
      var span = after.t - before.t;
      var startValue = span > 0 ? before.v + (after.v - before.v) * (t0 - before.t) / span : after.v;
      pts.push('0,' + (100 - Math.min(startValue / maxVal * 100, 100)).toFixed(1));
    }
    for (var i = firstInside; i < hist.length; i++) {
      var x = ((hist[i].t - t0) / SPARK_WINDOW * 100).toFixed(4);
      var y = (100 - Math.min(hist[i].v / maxVal * 100, 100)).toFixed(1);
      pts.push(x + ',' + y);
    }
    if (pts.length < 2) return null;
    var line = 'M' + pts.join('L');
    var area = line + 'L' + pts[pts.length-1].split(',')[0] + ',100L' + pts[0].split(',')[0] + ',100Z';
    return { line: line, area: area };
  }
  function renderSpark(areaEl, lineEl, hist, maxVal, color) {
    var p = sparkPaths(hist, maxVal);
    if (!p) { areaEl.removeAttribute('d'); return; }
    areaEl.setAttribute('d', p.area);
    areaEl.style.fill = color;
    areaEl.setAttribute('fill-opacity', document.body.classList.contains('vscode-dark') ? '0.12' : '0.06');
  }
  function sparkMaximum(first, second) {
    var maximum = 1;
    [first, second].forEach(function(series) { if (series) series.forEach(function(point) { if (point.v > maximum) maximum = point.v; }); });
    return maximum;
  }
  var lastSparkFrame = 0;
  function animateSparks(frameTime) {
    if (frameTime - lastSparkFrame >= 32 && !paused && displayCfg && displayCfg.charts !== false && document.getElementById('tab-perf').classList.contains('active')) {
      lastSparkFrame = frameTime;
      renderSpark(document.getElementById('cpu-spark-area'), null, cpuHist, 100, sparkColor(cpuHist.length ? cpuHist[cpuHist.length - 1].v : 0));
      renderSpark(document.getElementById('ram-spark-area'), null, ramHist, 100, sparkColor(ramHist.length ? ramHist[ramHist.length - 1].v : 0));
      renderSpark(document.getElementById('net-spark-tx-area'), null, netTxHist, sparkMaximum(netTxHist, netRxHist), 'var(--warn)');
      renderSpark(document.getElementById('net-spark-rx-area'), null, netRxHist, sparkMaximum(netTxHist, netRxHist), 'var(--accent)');
      renderSpark(document.getElementById('ssh-spark-tx-area'), null, sshTxHist, sparkMaximum(sshTxHist, sshRxHist), 'var(--warn)');
      renderSpark(document.getElementById('ssh-spark-rx-area'), null, sshRxHist, sparkMaximum(sshTxHist, sshRxHist), 'var(--accent)');
      renderSpark(document.getElementById('disk-spark-r-area'), null, diskRHist, sparkMaximum(diskRHist, diskWHist), 'var(--warn)');
      renderSpark(document.getElementById('disk-spark-w-area'), null, diskWHist, sparkMaximum(diskRHist, diskWHist), 'var(--accent)');
      Object.keys(gpuHist).forEach(function(index) {
        var series = gpuHist[index];
        var area = document.getElementById('gpu-spark-area-' + index);
        if (area) renderSpark(area, null, series, 100, sparkColor(series.length ? series[series.length - 1].v : 0));
      });
    }
    requestAnimationFrame(animateSparks);
  }
  function pushHist(arr, val) {
    var now = Date.now();
    arr.push({t: now, v: val});
    var cutoff = now - SPARK_WINDOW - Math.max(1, (curInterval || 2) * 1000) * 2;
    // 留出延迟滚动所需的左边界锚点，避免旧点过早移除。
    while (arr.length > 2 && arr[1].t < cutoff) arr.shift();
  }

  // ── 消息处理 ──
  window.addEventListener('message', function(evt) {
    var data = evt.data;
    if (data.cmd === 'uiState') {
      if (data.processDisplay) { processDisplay = data.processDisplay; renderProcTable(); }
      if (typeof data.paused === 'boolean') {
        paused = data.paused;
        var pauseButton = document.getElementById('pause-btn');
        pauseButton.textContent = paused ? T.stopped : T.running;
        pauseButton.classList.toggle('on', !paused);
      }
      return;
    }
    if (data.cmd === 'config') {
      barCfg = data.barCfg || barCfg;
      diskCfg = data.diskCfg || diskCfg;
      displayCfg = data.displayCfg || displayCfg;
      SPARK_WINDOW = (displayCfg.sparkMinutes || 5) * 60 * 1000;
      applyTabularNums();
      applyCharts();
      applyGroupVisibility();
      curInterval = data.interval || curInterval;
      if (typeof data.gpuCount === 'number') gpuCount = data.gpuCount;
      if (modalOpen && !settingMenu) renderSettingsBody();
      return;
    }
    if (data.cmd !== 'snapshot') return;
    var viewModel = data.viewModel;
    var performance = viewModel.performance;
    if (performance.language) setLang(performance.language);
    if (ctxMenu) pendingProcData = viewModel.processes || [];
    else { procData = viewModel.processes || []; renderProcTable(); }
    lastGpuPayload = performance.gpus || [];

    document.getElementById('cpu-val').textContent = performance.cpu.usagePercent + '%';
    setBar('cpu-bar', performance.cpu.usagePercent);
    document.getElementById('load-1').textContent = performance.cpu.loadAverage.oneMinute + ' / ' + performance.cpu.coreCount + T.cores;
    document.getElementById('load-5').textContent = performance.cpu.loadAverage.fiveMinutes + ' / ' + performance.cpu.coreCount + T.cores;
    document.getElementById('load-15').textContent = performance.cpu.loadAverage.fifteenMinutes + ' / ' + performance.cpu.coreCount + T.cores;
    pushHist(cpuHist, performance.cpu.usagePercent);
    renderSpark(document.getElementById('cpu-spark-area'), null, cpuHist, 100, sparkColor(performance.cpu.usagePercent));

    document.getElementById('mem-val').textContent = performance.memory.usagePercent + '%';
    setBar('mem-bar', performance.memory.usagePercent);
    document.getElementById('mem-used').textContent = performance.memory.usedText;
    document.getElementById('mem-avail').textContent = performance.memory.availableText;
    document.getElementById('mem-total').textContent = performance.memory.totalText;
    pushHist(ramHist, performance.memory.usagePercent);
    renderSpark(document.getElementById('ram-spark-area'), null, ramHist, 100, sparkColor(performance.memory.usagePercent));

    renderDisk(performance.disks);

    // disk I/O
    if (performance.diskIo) {
      var dioEl = document.getElementById('disk-io-val');
      if (dioEl) {
        dioEl.textContent = performance.diskIo.totalText;
        dioEl.title = 'Read ' + performance.diskIo.readText + '  Write ' + performance.diskIo.writeText;
      }
      pushHist(diskRHist, performance.diskIo.readBytesPerSecond || 0);
      pushHist(diskWHist, performance.diskIo.writeBytesPerSecond || 0);
      var diskMax = 1;
      diskRHist.forEach(function(p) { if (p.v > diskMax) diskMax = p.v; });
      diskWHist.forEach(function(p) { if (p.v > diskMax) diskMax = p.v; });
      renderSpark(document.getElementById('disk-spark-r-area'), null, diskRHist, diskMax, 'var(--warn)');
      renderSpark(document.getElementById('disk-spark-w-area'), null, diskWHist, diskMax, 'var(--accent)');
    }

    var sshCard = document.getElementById('ssh-card');
    var netTitle = document.getElementById('net-title');
    if (performance.sshTraffic && performance.sshTraffic.isSsh) {
      netTitle.textContent = T.srvNet;
      sshCard.style.display = '';
      document.getElementById('ssh-label').textContent = T.localSSH;
      document.getElementById('ssh-tx').textContent = performance.sshTraffic.uploadText;
      document.getElementById('ssh-rx').textContent = performance.sshTraffic.downloadText;
      document.getElementById('ssh-latency').textContent = performance.sshTraffic.latencyText;
      document.getElementById('ssh-latency').title = T.latency + ' · TCP RTT';
      pushHist(sshTxHist, performance.sshTraffic.uploadBytesPerSecond || 0);
      pushHist(sshRxHist, performance.sshTraffic.downloadBytesPerSecond || 0);
      var sshMax = 1;
      sshTxHist.forEach(function(p) { if (p.v > sshMax) sshMax = p.v; });
      sshRxHist.forEach(function(p) { if (p.v > sshMax) sshMax = p.v; });
      renderSpark(document.getElementById('ssh-spark-tx-area'), null, sshTxHist, sshMax, 'var(--warn)');
      renderSpark(document.getElementById('ssh-spark-rx-area'), null, sshRxHist, sshMax, 'var(--accent)');
      document.getElementById('net-up-label').textContent = T.up;
      document.getElementById('net-down-label').textContent = T.down;
      document.getElementById('ssh-up-label').textContent = T.up;
      document.getElementById('ssh-down-label').textContent = T.down;
    } else {
      netTitle.textContent = T.net;
      sshCard.style.display = 'none';
      document.getElementById('net-up-label').textContent = T.up;
      document.getElementById('net-down-label').textContent = T.down;
    }

    var gpuBody = document.getElementById('gpu-body');
    var nextGpuCount = performance.gpus ? performance.gpus.length : 0;
    if (nextGpuCount !== gpuCount) { gpuCount = nextGpuCount; if (modalOpen && !settingMenu) renderSettingsBody(); }
    if (performance.gpus && performance.gpus.length) {
      var gpuKeys = performance.gpus.map(function(g) { return g.idx; });
      var gpuIdentityKeys = performance.gpus.map(function(g) { return g.deviceKey || String(g.idx); });
      Object.keys(selectedGpus).forEach(function(index) { if (gpuKeys.indexOf(parseInt(index)) < 0) delete selectedGpus[index]; });
      Object.keys(gpuHist).forEach(function(index) { if (gpuKeys.indexOf(parseInt(index)) < 0) delete gpuHist[index]; });
      var gpuSame = gpuIdentityKeys.length === renderedAcceleratorKeys.length && gpuIdentityKeys.every(function(k, i) { return k === renderedAcceleratorKeys[i]; });
      performance.gpus.forEach(function(g) {
        if (!gpuHist[g.idx]) gpuHist[g.idx] = [];
        pushHist(gpuHist[g.idx], parseInt(g.util) || 0);
      });
      if (!gpuSame) {
        renderedAcceleratorKeys = gpuIdentityKeys;
        var ghtml = '';
        performance.gpus.forEach(function(g) {
          var util = parseInt(g.util) || 0;
          var memPct = g.memPct;
          ghtml += '<div class="gpu-mini" data-mine="' + (g.isMine ? '1' : '0') + '">'
            + '<svg class="spark-bg" id="gpu-spark-' + g.idx + '" viewBox="0 0 100 100" preserveAspectRatio="none"><path id="gpu-spark-area-' + g.idx + '" /></svg>'
            + '<div class="gpu-title"><span class="gpu-name">GPU ' + g.idx + '</span><span class="gpu-sub" title="' + esc(g.name) + '"><bdo dir="ltr" id="gpu-name-text-' + g.idx + '">' + esc(g.displayName || g.name) + '</bdo></span></div>'
            + '<div class="bar-label"><span>' + T.utilLabel + '</span><span id="gpu-util-text-' + g.idx + '"><b>' + util + '%</b> <span class="gpu-link" data-gpu-link="' + g.idx + '">&nearr; ' + T.viewProcs + '</span></span></div>'
            + '<div class="track"><div class="fill ' + colorClass(util) + '" id="gpu-util-' + g.idx + '"></div></div>'
            + '<div class="bar-label"><span>' + T.memLabel + '</span><span class="gpu-mem-wrap"><span class="ltr-ellipsis" id="gpu-mem-text-' + g.idx + '" title="' + esc(g.memPairStr) + '"><bdo dir="ltr">' + esc(g.memPairStr) + '</bdo></span><span class="gpu-pct" id="gpu-mem-pct-' + g.idx + '">' + memPct + '%</span></span></div>'
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
            var idx = this.dataset.gpuLink;
            procSort = 'gpu';
            procFilter = 'gpu' + idx;
            filterInput.value = 'GPU' + idx;
            filterWrap.classList.add('has-text');
            switchTab('proc');
            renderProcToolbar();
            renderProcTable();
          });
        });
        requestAnimationFrame(function() {
          performance.gpus.forEach(function(g) {
            var util = parseInt(g.util) || 0;
            var memPct = g.memPct;
            var ub = document.getElementById('gpu-util-' + g.idx);
            var mb = document.getElementById('gpu-mem-' + g.idx);
            if (ub) ub.style.width = util + '%';
            if (mb) mb.style.width = memPct + '%';
            var ga = document.getElementById('gpu-spark-area-' + g.idx);
            if (ga && gpuHist[g.idx]) renderSpark(ga, null, gpuHist[g.idx], 100, sparkColor(util));
          });
        });
      } else {
        performance.gpus.forEach(function(g) {
          var util = parseInt(g.util) || 0;
          var memPct = g.memPct;
          var ub = document.getElementById('gpu-util-' + g.idx);
          var mb = document.getElementById('gpu-mem-' + g.idx);
          if (ub) { ub.style.width = util + '%'; ub.className = 'fill ' + colorClass(util); }
          if (mb) { mb.style.width = memPct + '%'; mb.className = 'fill ' + colorClass(memPct); }
          var ut = document.getElementById('gpu-util-text-' + g.idx);
          if (ut) { var b = ut.querySelector('b'); if (b) { b.textContent = util + '%'; } else { var link = ut.querySelector('.gpu-link'); ut.textContent = util + '% '; if (link) ut.appendChild(link); } }
          var memoryTextElement = document.getElementById('gpu-mem-text-' + g.idx);
          if (memoryTextElement) { var bdo = memoryTextElement.querySelector('bdo'); if (bdo) bdo.textContent = g.memPairStr; else memoryTextElement.textContent = g.memPairStr; memoryTextElement.title = g.memPairStr; }
          var nameElement = document.getElementById('gpu-name-text-' + g.idx);
          if (nameElement) { nameElement.textContent = g.displayName || g.name; nameElement.parentElement.title = g.name; }
          var mp = document.getElementById('gpu-mem-pct-' + g.idx);
          if (mp) { mp.textContent = memPct + '%'; }
          var statsElement = document.getElementById('gpu-stats-' + g.idx);
          if (statsElement) statsElement.innerHTML = gpuStatsMarkup(g);
          var ga = document.getElementById('gpu-spark-area-' + g.idx);
          if (ga && gpuHist[g.idx]) renderSpark(ga, null, gpuHist[g.idx], 100, sparkColor(util));
          var card = document.getElementById('gpu-users-' + g.idx);
          if (card) card.parentElement.dataset.mine = g.isMine ? '1' : '0';
          renderGpuUsers(g);
        });
      }
    } else {
      gpuBody.innerHTML = '';
      renderedAcceleratorKeys = [];
      gpuHist = {};
      selectedGpus = {};
      lastFreeIdxs = [];
    }
    refreshGpuInfoPopover();

    document.getElementById('net-tx').textContent = performance.network.transmitText;
    document.getElementById('net-rx').textContent = performance.network.receiveText;
    pushHist(netTxHist, performance.network.transmitBytesPerSecond || 0);
    pushHist(netRxHist, performance.network.receiveBytesPerSecond || 0);
    var netMax = 1;
    netTxHist.forEach(function(p) { if (p.v > netMax) netMax = p.v; });
    netRxHist.forEach(function(p) { if (p.v > netMax) netMax = p.v; });
    renderSpark(document.getElementById('net-spark-tx-area'), null, netTxHist, netMax, 'var(--warn)');
    renderSpark(document.getElementById('net-spark-rx-area'), null, netRxHist, netMax, 'var(--accent)');

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
        var cls = isFree ? (selectedGpus[g.idx] ? 'cap sel' : 'cap') : 'cap busy';
        capsHtml += '<button class="' + cls + '" data-idx="' + g.idx + '" data-free="' + (isFree?1:0) + '">' + g.idx + '</button>';
      });
      caps.innerHTML = capsHtml;
      document.getElementById('gpu-summary').textContent = zh
        ? freeCount + ' 空闲 / ' + performance.gpus.length + ' 张'
        : freeCount + ' free / ' + performance.gpus.length + ' GPUs';
      updateCopyBtn();
      lastFreeIdxs = performance.gpus.filter(function(g) { return g.isIdle === true; }).map(function(g){ return g.idx; });
    } else {
      freeCard.style.display = '';
      freeCard.querySelector('.card-head').style.marginBottom = '0';
      document.getElementById('gpu-summary').textContent = performance.gpuLoading ? (zh ? '加载中…' : 'Loading…') : (zh ? '无 GPU' : 'No GPU');
      capsElem.style.display = 'none';
      actElem.style.display = 'none';
      gpuBody.style.display = 'none';
    }

    document.getElementById('updated').textContent = T.updAt + new Date().toLocaleTimeString();
    applyGroupVisibility();
  });

  // ── GPU 胶囊 ──
  var selectedGpus = {}, lastFreeIdxs = [];
  function updateCopyBtn() { document.getElementById('copy-btn').disabled = Object.keys(selectedGpus).length === 0; }
  document.getElementById('gpu-capsules').addEventListener('click', function(e) {
    var btn = e.target;
    if (!btn.dataset || !btn.dataset.idx || btn.dataset.free === '0') return;
    var idx = parseInt(btn.dataset.idx);
    if (selectedGpus[idx]) { delete selectedGpus[idx]; btn.classList.remove('sel'); }
    else { selectedGpus[idx] = true; btn.classList.add('sel'); }
    updateCopyBtn();
  });
  document.getElementById('select-all-btn').addEventListener('click', function() {
    lastFreeIdxs.forEach(function(i){ selectedGpus[i] = true; });
    document.querySelectorAll('.cap:not(.busy)').forEach(function(b){ b.classList.add('sel'); });
    updateCopyBtn();
  });
  document.getElementById('clear-btn').addEventListener('click', function() {
    selectedGpus = {};
    document.querySelectorAll('.cap.sel').forEach(function(b){ b.classList.remove('sel'); });
    updateCopyBtn();
  });
  var copyButton = document.getElementById('copy-btn');
  copyButton.addEventListener('click', function() {
    if (this.disabled) return;
    var ids = Object.keys(selectedGpus).map(Number).sort(function(a,b){return a-b;}).join(',');
    var ta = document.createElement('textarea'); ta.value = 'CUDA_VISIBLE_DEVICES=' + ids;
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
  });

  // ── Tab 切换 ──
  function switchTab(name) {
    if (name !== 'perf') hideGpuInfoPopover();
    document.querySelectorAll('.tab-content').forEach(function(d){d.classList.remove('active');});
    document.getElementById('tab-'+name).classList.add('active');
    document.getElementById('tab-perf-btn').classList.toggle('on', name==='perf');
    document.getElementById('tab-proc-btn').classList.toggle('on', name==='proc');
    if (name === 'perf') requestAnimationFrame(function() { lastGpuPayload.forEach(renderGpuUsers); });
  }
  document.getElementById('tab-perf-btn').addEventListener('click',function(){switchTab('perf');});
  document.getElementById('tab-proc-btn').addEventListener('click',function(){switchTab('proc');});

  // ── 暂停 ──
  document.getElementById('pause-btn').addEventListener('click',function(){
    paused = !paused;
    this.textContent = paused ? T.stopped : T.running;
    this.classList.toggle('on', !paused);
    sendToExtension({cmd:'pause',value:paused});
  });

  // ── 共享状态 ──
  var __initCfg = JSON.parse(atob(document.body.dataset.config));
  var barCfg = __initCfg.barCfg || {};
  var diskCfg = __initCfg.diskCfg || {};
  var displayCfg = __initCfg.displayCfg || {};
  var lastGpuPayload = [];
  var processDisplay = __initCfg.processDisplay || { cpu: 'core', ram: 'size' };
  var expandedColumns = { name: false, cmd: false };
  var curInterval = __initCfg.interval || 2, gpuCount = typeof __initCfg.gpuCount === 'number' ? __initCfg.gpuCount : 0, modalOpen = false;
  SPARK_WINDOW = (displayCfg.sparkMinutes || 5) * 60 * 1000;
