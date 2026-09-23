  var vscode = acquireVsCodeApi();
  function sendToExtension(message) { vscode.postMessage(Object.assign({ version: 1 }, message)); }
  var zh = true, T = {}, paused = false;

  function colorClass(p) { return p >= 90 ? 'danger' : p >= 70 ? 'warn' : ''; }
  function setBar(id, percent) { var barElement = document.getElementById(id); if (barElement) { barElement.style.width = percent + '%'; barElement.className = 'fill ' + colorClass(percent); } }

  function setLang(lang) {
    zh = lang && lang.startsWith('zh');
    T = zh
      ? { min:' 分钟',cores:' 核',used:'已用',avail:'可用',total:'总计',srvNet:'服务器网络',net:'网络',localSSH:'本机 SSH',up:'↑ 上传',down:'↓ 下载',selAll:'全选空闲',clear:'清除',copyEnv:'复制环境变量',detecting:'检测中…',noGpu:'未检测到 GPU',updAt:'更新于 ',utilLabel:'利用率',memLabel:'显存',tempLabel:'温度',pwLabel:'功耗',
          perfTab:'性能',procTab:'进程',settBtn:'设置',running:'运行中',stopped:'已暂停',enabled:'已开启',disabled:'已关闭',settTitle:'设置',interval:'刷新间隔',statusBar:'状态栏',barToggle:'显示状态栏',barAlign:'位置',barPriority:'优先级',barPriorityTip:'数字越大越靠左（左侧）或越靠右（右侧），默认 10',close:'关闭',
          netLabel:'网络速率',gpuLabel:'GPU',
          scopeOff:'关',scopeSummary:'总览',scopeCard:'指定卡',scopeMy:'我的卡',metUtil:'仅利用率',metVram:'仅显存',metBoth:'全部显示',
          netUp:'仅上传',netDown:'仅下载',netAll:'全部显示',netMerge:'合并显示',
          sshLabel:'SSH速率',gpuSummary:'GPU总览',gpuIdleIds:'显示空闲卡号',gpuPerf:'GPU性能显示',gpuAll:'所有卡',gpuSpecify:'指定卡',gpuFirst:'前几张',gpuMetric:'GPU显示指标',gpuSkipIdle:'隐藏空闲卡',viewProcs:'查看进程',
          diskLabel:'磁盘',diskUsage:'磁盘容量',diskIO:'磁盘速率',diskIORead:'仅读',diskIOWrite:'仅写',diskNoData:'无磁盘数据',diskFilter:'挂载过滤',diskDefault:'默认',diskMore:'更多',diskAll:'全部',diskCustom:'自定义',diskShowVirtual:'排除虚拟 FS',diskShowVirtualTip:'tmpfs, sysfs, proc, devtmpfs 等',diskExcludeFs:'排除 FS 类型',diskExcludeFsTip:'如 vfat, ntfs, fuse 等文件系统类型',diskExcludePath:'排除路径前缀',diskExcludePathTip:'如 /proc, /sys, /run 等挂载路径',diskHideParent:'仅显示叶子挂载点',diskHideParentTip:'例: /autodl-fs 和 /autodl-fs/data 同时存在时只显示 /autodl-fs/data（适用于 AutoDL 等平台）',
          displayLabel:'显示',chartsToggle:'卡片背景图表',sparkLabel:'图表时长',tabularNums:'等宽数字',tabularNumsTip:'所有数字宽度一致，布局更稳定，但可能显得略宽松',
          pcpu:'CPU',pmem:'内存',pgpu:'GPU',ppid:'PID',puser:'用户',pname:'进程名',pcpuPct:'CPU',pmemCol:'内存',pgpuCol:'GPU',pcount:'共 {n} 进程',pnoGpu:'—',pcmd:'命令',filterHint:'搜索进程...',coreMode:'单核',wholeMode:'整机',bothMode:'都显示',sizeMode:'占用量',percentMode:'占比',expand:'展开',collapse:'收起',latency:'延迟',systemGroup:'CPU + 内存',networkGroup:'网络',gpuSummaryGroup:'GPU 总览',gpuCardsGroup:'GPU 卡片',myGpuBorder:'标记我的 GPU',gpuPicker:'空闲 GPU 选择器',gpuUsers:'GPU 占用用户',openEditor:'在编辑器中打开' }
      : { min:' min',cores:' cores',used:'Used',avail:'Avail',total:'Total',srvNet:'Server Net',net:'Network',localSSH:'Local SSH',up:'↑ Up',down:'↓ Down',selAll:'Select All',clear:'Clear',copyEnv:'Copy Env Var',detecting:'Detecting…',noGpu:'No GPU detected',updAt:'Updated ',utilLabel:'Util',memLabel:'VRAM',tempLabel:'Temp',pwLabel:'Power',
          perfTab:'Perf',procTab:'Procs',settBtn:'Settings',running:'Running',stopped:'Paused',enabled:'Enabled',disabled:'Disabled',settTitle:'Settings',interval:'Refresh Interval',statusBar:'Status Bar',barToggle:'Show Status Bar',barAlign:'Position',barPriority:'Priority',barPriorityTip:'Higher = closer to the edge. Default: 10',close:'Close',
          netLabel:'Network',gpuLabel:'GPU',
          scopeOff:'Off',scopeSummary:'Summary',scopeCard:'Card',scopeMy:'My Card',metUtil:'Util Only',metVram:'VRAM Only',metBoth:'All',
          netUp:'Upload',netDown:'Download',netAll:'All',netMerge:'Merged',
          sshLabel:'SSH Traffic',gpuSummary:'GPU Summary',gpuIdleIds:'Show Idle IDs',gpuPerf:'GPU Performance',gpuAll:'All Cards',gpuSpecify:'Specific',gpuFirst:'First N',gpuMetric:'GPU Metric',gpuSkipIdle:'Hide Idle',viewProcs:'View Procs',
          diskLabel:'Disk',diskUsage:'Disk Usage',diskIO:'Disk I/O',diskIORead:'Read',diskIOWrite:'Write',diskNoData:'No disk data',diskFilter:'Mount Filter',diskDefault:'Default',diskMore:'More',diskAll:'All',diskCustom:'Custom',diskShowVirtual:'Exclude Virtual FS',diskShowVirtualTip:'tmpfs, sysfs, proc, devtmpfs, etc.',diskExcludeFs:'Exclude FS Type',diskExcludeFsTip:'e.g. vfat, ntfs, fuse',diskExcludePath:'Exclude Path Prefix',diskExcludePathTip:'e.g. /proc, /sys, /run',diskHideParent:'Leaf mounts only',diskHideParentTip:'e.g. if /autodl-fs and /autodl-fs/data both exist, only /autodl-fs/data is shown (useful on AutoDL, etc.)',
          displayLabel:'Display',chartsToggle:'Card Background Charts',sparkLabel:'Chart Duration',tabularNums:'Tabular Numbers',tabularNumsTip:'All digits have equal width for stable layout, but may appear slightly wider',
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
      document.body.style.setProperty('--spark-color-duration', curInterval + 's');
      if (typeof data.gpuCount === 'number') gpuCount = data.gpuCount;
      if (modalOpen && !settingMenu) renderSettingsBody();
      return;
    }
    if (data.cmd === 'procs') {
      if (ctxMenu) pendingProcData = data.data || [];
      else { procData = data.data || []; renderProcTable(); }
      return;
    }
    if (data.cmd !== 'update') return;
    var snapshotPayload = data.payload;
    lastGpuPayload = snapshotPayload.gpus || [];
    if (snapshotPayload.lang) setLang(snapshotPayload.lang);

    document.getElementById('cpu-val').textContent = snapshotPayload.cpu + '%';
    setBar('cpu-bar', snapshotPayload.cpu);
    document.getElementById('load-1').textContent = snapshotPayload.load1 + ' / ' + snapshotPayload.cpuCores + T.cores;
    document.getElementById('load-5').textContent = snapshotPayload.load5 + ' / ' + snapshotPayload.cpuCores + T.cores;
    document.getElementById('load-15').textContent = snapshotPayload.load15 + ' / ' + snapshotPayload.cpuCores + T.cores;
    pushHist(cpuHist, snapshotPayload.cpu);
    renderSpark(document.getElementById('cpu-spark-area'), null, cpuHist, 100, sparkColor(snapshotPayload.cpu));

    document.getElementById('mem-val').textContent = snapshotPayload.mem.percent + '%';
    setBar('mem-bar', snapshotPayload.mem.percent);
    document.getElementById('mem-used').textContent = snapshotPayload.mem.usedStr;
    document.getElementById('mem-avail').textContent = snapshotPayload.mem.availStr;
    document.getElementById('mem-total').textContent = snapshotPayload.mem.totalStr;
    pushHist(ramHist, snapshotPayload.mem.percent);
    renderSpark(document.getElementById('ram-spark-area'), null, ramHist, 100, sparkColor(snapshotPayload.mem.percent));

    renderDisk(snapshotPayload.disks);

    // disk I/O
    if (snapshotPayload.diskIO) {
      var dioEl = document.getElementById('disk-io-val');
      if (dioEl) {
        dioEl.textContent = snapshotPayload.diskIO.totalStr;
        dioEl.title = 'Read ' + snapshotPayload.diskIO.rStr + '  Write ' + snapshotPayload.diskIO.wStr;
      }
      pushHist(diskRHist, snapshotPayload.diskIO.r || 0);
      pushHist(diskWHist, snapshotPayload.diskIO.w || 0);
      var diskMax = 1;
      diskRHist.forEach(function(p) { if (p.v > diskMax) diskMax = p.v; });
      diskWHist.forEach(function(p) { if (p.v > diskMax) diskMax = p.v; });
      renderSpark(document.getElementById('disk-spark-r-area'), null, diskRHist, diskMax, 'var(--warn)');
      renderSpark(document.getElementById('disk-spark-w-area'), null, diskWHist, diskMax, 'var(--accent)');
    }

    var sshCard = document.getElementById('ssh-card');
    var netTitle = document.getElementById('net-title');
    if (snapshotPayload.ssh && snapshotPayload.ssh.isSSH) {
      netTitle.textContent = T.srvNet;
      sshCard.style.display = '';
      document.getElementById('ssh-label').textContent = T.localSSH;
      document.getElementById('ssh-tx').textContent = snapshotPayload.ssh.txStr;
      document.getElementById('ssh-rx').textContent = snapshotPayload.ssh.rxStr;
      document.getElementById('ssh-latency').textContent = snapshotPayload.ssh.latencyStr;
      document.getElementById('ssh-latency').title = T.latency + ' · TCP RTT';
      pushHist(sshTxHist, snapshotPayload.ssh.tx || 0);
      pushHist(sshRxHist, snapshotPayload.ssh.rx || 0);
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
    var nextGpuCount = snapshotPayload.gpus ? snapshotPayload.gpus.length : 0;
    if (nextGpuCount !== gpuCount) { gpuCount = nextGpuCount; if (modalOpen && !settingMenu) renderSettingsBody(); }
    if (snapshotPayload.gpus && snapshotPayload.gpus.length) {
      var gpuKeys = snapshotPayload.gpus.map(function(g) { return g.idx; });
      var gpuIdentityKeys = snapshotPayload.gpus.map(function(g) { return g.deviceKey || String(g.idx); });
      Object.keys(selectedGpus).forEach(function(index) { if (gpuKeys.indexOf(parseInt(index)) < 0) delete selectedGpus[index]; });
      Object.keys(gpuHist).forEach(function(index) { if (gpuKeys.indexOf(parseInt(index)) < 0) delete gpuHist[index]; });
      var gpuSame = gpuIdentityKeys.length === renderedAcceleratorKeys.length && gpuIdentityKeys.every(function(k, i) { return k === renderedAcceleratorKeys[i]; });
      snapshotPayload.gpus.forEach(function(g) {
        if (!gpuHist[g.idx]) gpuHist[g.idx] = [];
        pushHist(gpuHist[g.idx], parseInt(g.util) || 0);
      });
      if (!gpuSame) {
        renderedAcceleratorKeys = gpuIdentityKeys;
        var ghtml = '';
        snapshotPayload.gpus.forEach(function(g) {
          var util = parseInt(g.util) || 0;
          var mu = parseInt(g.memUsed) || 0;
          var mt = parseInt(g.memTotal) || 1;
          var memPct = Math.min(100, Math.round(mu / mt * 100));
          ghtml += '<div class="gpu-mini" data-mine="' + (g.isMine ? '1' : '0') + '">'
            + '<svg class="spark-bg" id="gpu-spark-' + g.idx + '" viewBox="0 0 100 100" preserveAspectRatio="none"><path id="gpu-spark-area-' + g.idx + '" /></svg>'
            + '<div class="gpu-title"><span class="gpu-name">GPU ' + g.idx + '</span><span class="gpu-sub" title="' + esc(g.name) + '"><bdo dir="ltr" id="gpu-name-text-' + g.idx + '">' + esc(g.displayName || g.name) + '</bdo></span></div>'
            + '<div class="bar-label"><span>' + T.utilLabel + '</span><span id="gpu-util-text-' + g.idx + '"><b>' + util + '%</b> <span class="gpu-link" data-gpu-link="' + g.idx + '">&nearr; ' + T.viewProcs + '</span></span></div>'
            + '<div class="track"><div class="fill ' + colorClass(util) + '" id="gpu-util-' + g.idx + '"></div></div>'
            + '<div class="bar-label"><span>' + T.memLabel + '</span><span class="gpu-mem-wrap"><span class="ltr-ellipsis" id="gpu-mem-text-' + g.idx + '" title="' + esc(g.memUsedStr + ' / ' + g.memTotalStr) + '"><bdo dir="ltr">' + esc(g.memUsedStr + ' / ' + g.memTotalStr) + '</bdo></span><span class="gpu-pct" id="gpu-mem-pct-' + g.idx + '">' + memPct + '%</span></span></div>'
            + '<div class="track"><div class="fill ' + colorClass(memPct) + '" id="gpu-mem-' + g.idx + '"></div></div>'
            + '<div class="gpu-users" id="gpu-users-' + g.idx + '"></div>'
            + '<div class="gpu-stats"><span id="gpu-temp-' + g.idx + '" title="' + T.tempLabel + ' ' + (g.temp || 0) + ' °C">' + T.tempLabel + ' <b>' + (g.temp || 0) + ' °C</b></span>' + (g.power ? '<span id="gpu-power-' + g.idx + '" title="' + T.pwLabel + ' ' + g.power.draw + '/' + g.power.limit + ' W">' + T.pwLabel + ' <b>' + g.power.draw + '/' + g.power.limit + ' W</b></span>' : '') + '</div></div>';
        });
        gpuBody.innerHTML = ghtml;
        snapshotPayload.gpus.forEach(function(g) { renderGpuUsers(g); });
        applyCharts();
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
          snapshotPayload.gpus.forEach(function(g) {
            var util = parseInt(g.util) || 0;
            var mu = parseInt(g.memUsed) || 0, mt = parseInt(g.memTotal) || 1;
            var memPct = Math.min(100, Math.round(mu / mt * 100));
            var ub = document.getElementById('gpu-util-' + g.idx);
            var mb = document.getElementById('gpu-mem-' + g.idx);
            if (ub) ub.style.width = util + '%';
            if (mb) mb.style.width = memPct + '%';
            var ga = document.getElementById('gpu-spark-area-' + g.idx);
            if (ga && gpuHist[g.idx]) renderSpark(ga, null, gpuHist[g.idx], 100, sparkColor(util));
          });
        });
      } else {
        snapshotPayload.gpus.forEach(function(g) {
          var util = parseInt(g.util) || 0;
          var mu = parseInt(g.memUsed) || 0, mt = parseInt(g.memTotal) || 1;
          var memPct = Math.min(100, Math.round(mu / mt * 100));
          var ub = document.getElementById('gpu-util-' + g.idx);
          var mb = document.getElementById('gpu-mem-' + g.idx);
          if (ub) { ub.style.width = util + '%'; ub.className = 'fill ' + colorClass(util); }
          if (mb) { mb.style.width = memPct + '%'; mb.className = 'fill ' + colorClass(memPct); }
          var ut = document.getElementById('gpu-util-text-' + g.idx);
          if (ut) { var b = ut.querySelector('b'); if (b) { b.textContent = util + '%'; } else { var link = ut.querySelector('.gpu-link'); ut.textContent = util + '% '; if (link) ut.appendChild(link); } }
          var memoryTextElement = document.getElementById('gpu-mem-text-' + g.idx);
          if (memoryTextElement) { var bdo = memoryTextElement.querySelector('bdo'); if (bdo) bdo.textContent = g.memUsedStr + ' / ' + g.memTotalStr; else memoryTextElement.textContent = g.memUsedStr + ' / ' + g.memTotalStr; memoryTextElement.title = g.memUsedStr + ' / ' + g.memTotalStr; }
          var nameElement = document.getElementById('gpu-name-text-' + g.idx);
          if (nameElement) { nameElement.textContent = g.displayName || g.name; nameElement.parentElement.title = g.name; }
          var mp = document.getElementById('gpu-mem-pct-' + g.idx);
          if (mp) { mp.textContent = memPct + '%'; }
          var te = document.getElementById('gpu-temp-' + g.idx);
          if (te) { te.innerHTML = T.tempLabel + ' <b>' + (g.temp || 0) + ' °C</b>'; te.title = T.tempLabel + ' ' + (g.temp || 0) + ' °C'; }
          var powerElement = document.getElementById('gpu-power-' + g.idx);
          if (powerElement && g.power) { powerElement.innerHTML = T.pwLabel + ' <b>' + g.power.draw + '/' + g.power.limit + ' W</b>'; powerElement.title = T.pwLabel + ' ' + g.power.draw + '/' + g.power.limit + ' W'; }
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

    document.getElementById('net-tx').textContent = snapshotPayload.net.txStr;
    document.getElementById('net-rx').textContent = snapshotPayload.net.rxStr;
    pushHist(netTxHist, snapshotPayload.net.tx || 0);
    pushHist(netRxHist, snapshotPayload.net.rx || 0);
    var netMax = 1;
    netTxHist.forEach(function(p) { if (p.v > netMax) netMax = p.v; });
    netRxHist.forEach(function(p) { if (p.v > netMax) netMax = p.v; });
    renderSpark(document.getElementById('net-spark-tx-area'), null, netTxHist, netMax, 'var(--warn)');
    renderSpark(document.getElementById('net-spark-rx-area'), null, netRxHist, netMax, 'var(--accent)');

    var freeCard = document.getElementById('free-gpu-card');
    var capsElem = document.getElementById('gpu-capsules');
    var actElem = document.getElementById('capsule-actions');
    if (snapshotPayload.gpus && snapshotPayload.gpus.length) {
      freeCard.style.display = '';
      freeCard.querySelector('.card-head').style.marginBottom = '';
      capsElem.style.display = '';
      actElem.style.display = '';
      gpuBody.style.display = '';
      var caps = document.getElementById('gpu-capsules');
      var freeCount = 0;
      var capsHtml = '';
      snapshotPayload.gpus.forEach(function(g) {
        var util = parseInt(g.util) || 0;
        var memPct = g.memTotal > 0 ? Math.round((parseInt(g.memUsed) || 0) / g.memTotal * 100) : 0;
        var isFree = g.isIdle === true;
        if (isFree) freeCount++;
        var cls = isFree ? (selectedGpus[g.idx] ? 'cap sel' : 'cap') : 'cap busy';
        capsHtml += '<button class="' + cls + '" data-idx="' + g.idx + '" data-free="' + (isFree?1:0) + '">' + g.idx + '</button>';
      });
      caps.innerHTML = capsHtml;
      document.getElementById('gpu-summary').textContent = zh
        ? freeCount + ' 空闲 / ' + snapshotPayload.gpus.length + ' 张'
        : freeCount + ' free / ' + snapshotPayload.gpus.length + ' GPUs';
      updateCopyBtn();
      lastFreeIdxs = snapshotPayload.gpus.filter(function(g) { return g.isIdle === true; }).map(function(g){ return g.idx; });
    } else {
      freeCard.style.display = '';
      freeCard.querySelector('.card-head').style.marginBottom = '0';
      document.getElementById('gpu-summary').textContent = snapshotPayload.gpuLoading ? (zh ? '加载中…' : 'Loading…') : (zh ? '无 GPU' : 'No GPU');
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
    document.querySelectorAll('.tab-content').forEach(function(d){d.classList.remove('active');});
    document.getElementById('tab-'+name).classList.add('active');
    document.getElementById('tab-perf-btn').classList.toggle('on', name==='perf');
    document.getElementById('tab-proc-btn').classList.toggle('on', name==='proc');
    if (name === 'proc') sendToExtension({cmd:'needProcs'});
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

  // ── 设置模态 ──
  var __initCfg = JSON.parse(atob(document.body.dataset.config));
  var barCfg = __initCfg.barCfg || {};
  var diskCfg = __initCfg.diskCfg || {};
  var displayCfg = __initCfg.displayCfg || {};
  var lastGpuPayload = [];
  var processDisplay = __initCfg.processDisplay || { cpu: 'core', ram: 'size' };
  var expandedColumns = { name: false, cmd: false };
  var curInterval = __initCfg.interval || 2, gpuCount = typeof __initCfg.gpuCount === 'number' ? __initCfg.gpuCount : 0, modalOpen = false;
  document.body.style.setProperty('--spark-color-duration', curInterval + 's');
  SPARK_WINDOW = (displayCfg.sparkMinutes || 5) * 60 * 1000;

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
  }
  function renderGpuUsers(gpu) {
    var line = document.getElementById('gpu-users-' + gpu.idx);
    if (!line) return;
    var users = gpu.users || [];
    line.style.display = users.length && displayCfg.showGpuUsers !== false ? 'flex' : 'none';
    if (displayCfg.showGpuUsers === false || !users.length || !line.clientWidth) return;
    for (var visible = users.length; visible >= 0; visible--) {
      line.replaceChildren();
      users.slice(0, visible).forEach(function(user) {
        var chip = document.createElement('span');
        chip.className = 'gpu-user ' + (user.percent >= 90 ? 'tag-danger' : user.percent >= 70 ? 'tag-warn' : 'tag-accent');
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
  window.addEventListener('resize', function() { lastGpuPayload.forEach(renderGpuUsers); });

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
  }
  function closeModal() { closeSettingMenu(); modalOpen = false; document.getElementById('modal-mask').classList.remove('open'); }
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

  function settingRow(label, control, hint) {
    return '<div class="setting-row"><span class="setting-info"><span class="setting-title"' + (hint ? ' title="' + esc(hint) + '"' : '') + '>' + label + '</span>' + (hint ? '<small>' + esc(hint) + '</small>' : '') + '</span><span class="setting-control">' + control + '</span></div>';
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
    dh += settingRow(T.diskExcludeFs, '<input class="sett-input wide" id="disk-fs-input" type="text" value="' + esc(showFs) + '"' + (isCustom ? '' : ' readonly') + ' />', T.diskExcludeFsTip);
    dh += settingRow(T.diskExcludePath, '<input class="sett-input wide" id="disk-path-input" type="text" value="' + esc(showPaths) + '"' + (isCustom ? '' : ' readonly') + ' />', T.diskExcludePathTip);
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

  // ── 进程 tab 逻辑 ──
  var procSort = 'cpu', procData = [], procFilter = '';
  function renderProcToolbar() {
    var tb = document.getElementById('proc-toolbar');
    if(!tb) return;
    tb.innerHTML = '<button class="sb'+(procSort==='cpu'?' on':'')+'" data-s="cpu">CPU</button>'
      +'<button class="sb'+(procSort==='mem'?' on':'')+'" data-s="mem">RAM</button>'
      +'<button class="sb'+(procSort==='gpu'?' on':'')+'" data-s="gpu">GPU</button>';
    tb.querySelectorAll('.sb').forEach(function(b){
      b.addEventListener('click',function(){procSort=this.dataset.s;renderProcToolbar();renderProcTable();});
    });
  }
  var filterInput = document.getElementById('proc-filter');
  var filterWrap = document.getElementById('filter-wrap');
  filterInput.addEventListener('input',function(){
    procFilter = this.value.toLowerCase();
    filterWrap.classList.toggle('has-text', this.value.length > 0);
    renderProcTable();
  });
  var persistedViewState = vscode.getState() || {};
  var hintDismissed = !!persistedViewState.hintDismissed;
  var hintShown = false;
  filterInput.addEventListener('focus', function() {
    if (hintDismissed || hintShown) return;
    hintShown = true;
    var hint = document.getElementById('filter-hint');
    var hintText = zh
      ? '<span class="hint-close" id="hint-close">&times;</span>支持搜索进程名、用户名、PID、命令行。GPU 搜索：<code>GPU0</code> <code>#0</code> <code>GPU 0</code>'
      : '<span class="hint-close" id="hint-close">&times;</span>Search by name, user, PID, command. GPU: <code>GPU0</code> <code>#0</code> <code>GPU 0</code>';
    hint.innerHTML = hintText;
    hint.classList.add('show');
    document.getElementById('hint-close').addEventListener('click', function() {
      hint.classList.remove('show');
      hintDismissed = true;
      vscode.setState(Object.assign(persistedViewState, { hintDismissed: true }));
    });
  });
  document.getElementById('filter-clear').addEventListener('click',function(){
    filterInput.value = '';
    procFilter = '';
    filterWrap.classList.remove('has-text');
    renderProcTable();
    filterInput.focus();
  });
  function esc(s){return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
  function procSearchStr(p) {
    var s = p.name.toLowerCase() + ' ' + p.user.toLowerCase() + ' ' + (p.cmd||'').toLowerCase() + ' ' + p.pid;
    if (p.gpus && p.gpus.length) {
      p.gpus.forEach(function(g){ s += ' gpu'+g.idx + ' gpu '+g.idx + ' #'+g.idx; });
    }
    return s;
  }
  function renderProcTable(){
    var filtered = procData;
    if (procFilter) {
      filtered = procData.filter(function(p){
        return procSearchStr(p).indexOf(procFilter) >= 0;
      });
    }
    var sorted = filtered.slice();
    if(procSort==='cpu') sorted.sort(function(a,b){return b.cpu-a.cpu;});
    else if(procSort==='mem') sorted.sort(function(a,b){return b.mem-a.mem;});
    else sorted.sort(function(a,b){return (b.vram||0)-(a.vram||0);});
    sorted = sorted.slice(0,100);
    document.getElementById('proc-count').textContent = (filtered.length < procData.length)
      ? T.pcount.replace('{n}', filtered.length + ' / ' + procData.length)
      : T.pcount.replace('{n}', procData.length);
    var cpuModeLabel = processDisplay.cpu === 'whole' ? T.wholeMode : processDisplay.cpu === 'both' ? T.bothMode : T.coreMode;
    var ramModeLabel = processDisplay.ram === 'percent' ? T.percentMode : processDisplay.ram === 'both' ? T.bothMode : T.sizeMode;
    document.getElementById('proc-hdr').innerHTML =
      '<th class="r">PID</th>'
      + '<th><span class="hdr-label">'+T.pname+'<button class="hdr-btn" data-hdr="name" title="'+(expandedColumns.name?T.collapse:T.expand)+'">'+(expandedColumns.name?'−':'+')+'</button></span></th>'
      + '<th>'+T.puser+'</th>'
      + '<th><span class="hdr-label">CPU<button class="hdr-btn" data-hdr="cpu" title="'+cpuModeLabel+'">'+cpuModeLabel+'</button></span></th>'
      + '<th><span class="hdr-label">RAM<button class="hdr-btn" data-hdr="ram" title="'+ramModeLabel+'">'+ramModeLabel+'</button></span></th>'
      + '<th>GPU</th>'
      + '<th><span class="hdr-label">'+T.pcmd+'<button class="hdr-btn" data-hdr="cmd" title="'+(expandedColumns.cmd?T.collapse:T.expand)+'">'+(expandedColumns.cmd?'−':'+')+'</button></span></th>';
    var html = '';
    sorted.forEach(function(p){
      var gpuCell = '';
      if (p.gpus && p.gpus.length) {
        var tags = p.gpus.map(function(g){
          var vTxt = g.vramStr || '—';
          var tTxt = g.memTotalStr || '—';
          var pct = g.memTotal > 0 ? Math.round(g.vram / g.memTotal * 100) : 0;
          var cls = g.mappingStatus === 'unmatched' ? ' tag-unknown' : pct >= 90 ? ' tag-danger' : pct >= 70 ? ' tag-warn' : ' tag-accent';
          return '<span class="gpu-tag'+cls+'">#'+g.idx+' '+vTxt+'/'+tTxt+' '+pct+'%</span>';
        }).join(' ');
        gpuCell = tags;
      } else {
        gpuCell = '<span class="pmuted">'+T.pnoGpu+'</span>';
      }
      var cpuTxt = p.cpu.toFixed(1);
      var wholeCpuTxt = (p.cpuWhole || 0).toFixed(1);
      var coreDisplay = cpuTxt + '%';
      var wholeDisplay = wholeCpuTxt + '%';
      var cpuHtml = processDisplay.cpu === 'both' ? '<span class="dual-value"><span>'+coreDisplay+'</span><span>'+wholeDisplay+'</span></span>' : (processDisplay.cpu === 'whole' ? wholeDisplay : coreDisplay);
      var cpuCopy = processDisplay.cpu === 'both' ? T.coreMode+' '+coreDisplay+' / '+T.wholeMode+' '+wholeDisplay : (processDisplay.cpu === 'whole' ? wholeDisplay : coreDisplay);
      var ramSize = p.memStr || '—';
      var ramPercent = p.memPct.toFixed(1) + '%';
      var ramHtml = processDisplay.ram === 'both' ? '<span class="dual-value"><span>'+ramSize+'</span><span>'+ramPercent+'</span></span>' : (processDisplay.ram === 'percent' ? ramPercent : ramSize);
      var ramCopy = processDisplay.ram === 'both' ? T.sizeMode+' '+ramSize+' / '+T.percentMode+' '+ramPercent : (processDisplay.ram === 'percent' ? ramPercent : ramSize);
      var cmdFull = p.cmd || p.name;
      html+='<tr>'
        +'<td class="r">'+p.pid+'</td>'
        +'<td class="expandable'+(expandedColumns.name?' expanded':'')+'" data-copy="'+esc(p.name)+'" title="PID '+p.pid+'&#10;'+esc(cmdFull)+'">'+esc(p.name)+'</td>'
        +'<td>'+esc(p.user)+'</td>'
        +'<td data-copy="'+esc(cpuCopy)+'">'+cpuHtml+'</td>'
        +'<td data-copy="'+esc(ramCopy)+'">'+ramHtml+'</td>'
        +'<td class="gpu-cell">'+gpuCell+'</td>'
        +'<td class="expandable'+(expandedColumns.cmd?' expanded':'')+'" data-copy="'+esc(cmdFull)+'" title="'+esc(cmdFull)+'">'+esc(cmdFull)+'</td>'
        +'</tr>';
    });
    document.getElementById('proc-tbody').innerHTML = html;
  }
  document.getElementById('proc-hdr').addEventListener('click', function(event) {
    var button = event.target.closest('[data-hdr]');
    if (!button) return;
    var key = button.dataset.hdr;
    if (key === 'name' || key === 'cmd') expandedColumns[key] = !expandedColumns[key];
    else if (key === 'cpu') {
      var cpuModes = ['core', 'whole', 'both'];
      processDisplay.cpu = cpuModes[(cpuModes.indexOf(processDisplay.cpu) + 1) % cpuModes.length];
      sendToExtension({cmd:'setProcessDisplay',key:'cpu',value:processDisplay.cpu});
    } else if (key === 'ram') {
      var ramModes = ['size', 'percent', 'both'];
      processDisplay.ram = ramModes[(ramModes.indexOf(processDisplay.ram) + 1) % ramModes.length];
      sendToExtension({cmd:'setProcessDisplay',key:'ram',value:processDisplay.ram});
    }
    renderProcTable();
  });
  renderProcToolbar();

  // ── 右键菜单 ──
  var ctxMenu = null, pendingProcData = null;
  function removeCtxMenu() {
    if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
    if (pendingProcData) { procData = pendingProcData; pendingProcData = null; renderProcTable(); }
  }
  document.addEventListener('click', removeCtxMenu);
  document.addEventListener('scroll', removeCtxMenu, true);
  document.getElementById('proc-tbody').addEventListener('contextmenu', function(e) {
    var td = e.target.closest('td');
    var tr = e.target.closest('tr');
    if (!td || !tr) return;
    e.preventDefault();
    removeCtxMenu();
    var menu = document.createElement('div');
    menu.className = 'ctx-menu';
    var cellText = td.dataset.copy || td.textContent;
    var rowCells = tr.querySelectorAll('td');
    var rowText = Array.prototype.map.call(rowCells, function(c) { return c.dataset.copy || c.textContent; }).join('\t');
    var item1 = document.createElement('div');
    item1.className = 'ctx-menu-item';
    item1.textContent = zh ? '复制单元格' : 'Copy Cell';
    item1.addEventListener('click', function() { navigator.clipboard.writeText(cellText); removeCtxMenu(); });
    var itemPid = document.createElement('div');
    itemPid.className = 'ctx-menu-item';
    itemPid.textContent = zh ? '复制 PID' : 'Copy PID';
    itemPid.addEventListener('click', function() { navigator.clipboard.writeText(rowCells[0].textContent.trim()); removeCtxMenu(); });
    var item2 = document.createElement('div');
    item2.className = 'ctx-menu-item';
    item2.textContent = zh ? '复制整行' : 'Copy Row';
    item2.addEventListener('click', function() { navigator.clipboard.writeText(rowText); removeCtxMenu(); });
    menu.appendChild(item1);
    menu.appendChild(itemPid);
    menu.appendChild(item2);
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    document.body.appendChild(menu);
    ctxMenu = menu;
    var rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 4) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 4) + 'px';
  });

  sendToExtension({cmd:'ready'});
  requestAnimationFrame(animateSparks);
