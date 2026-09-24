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
          var pct = g.pct;
          var cls = g.mappingStatus === 'unmatched' ? ' tag-unknown' : ' ' + tagColorClass(pct);
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

  // 所有部分加载完毕后再通知扩展。
  sendToExtension({cmd:'ready'});
  requestAnimationFrame(animateSparks);
