import { state } from "./state.mjs";
import { sendToExtension, tagColorClass, tr } from "./ui.mjs";

let switchPage, renderedRevision, persistedViewState, hintDismissed, hintShown;

export function resetProcessView() {
  renderedRevision = null;
  state.ui.processMenu?.remove();
  state.ui.processMenu = null;
  state.ui.pendingProcesses = null;
}

export function renderProcessSnapshot(viewModel) {
  const gpuEnabled = viewModel.sources?.accelerators?.state !== 'disabled';
  if (state.ui.gpuProcessesEnabled !== gpuEnabled) {
    state.ui.gpuProcessesEnabled = gpuEnabled;
    if (!gpuEnabled && state.ui.sort === 'gpu') state.ui.sort = 'cpu';
    renderProcToolbar();
  }
  const revision = [state.ui.deviceId, state.locale.language, viewModel.processRevision, gpuEnabled].join(':');
  if (viewModel.processRevision !== undefined && revision === renderedRevision) return;
  renderedRevision = revision;
  if (state.ui.processMenu) state.ui.pendingProcesses = viewModel.processes || [];
  else { state.data.processes = viewModel.processes || []; renderProcTable(); }
}

export function focusGpuProcesses(index) {
  state.ui.sort = 'gpu'; state.ui.search = 'gpu' + index;
  state.elements.filterInput.value = 'GPU' + index;
  state.elements.filterWrap.classList.add('has-text');
  switchPage('proc'); renderProcToolbar(); renderProcTable();
}
function renderProcToolbar() {
    var tb = document.getElementById('proc-toolbar');
    if(!tb) return;
    tb.innerHTML = '<button class="sb'+(state.ui.sort==='cpu'?' on':'')+'" data-s="cpu">CPU</button>'
      +'<button class="sb'+(state.ui.sort==='mem'?' on':'')+'" data-s="mem">RAM</button>'
      +(state.ui.gpuProcessesEnabled === false ? '' : '<button class="sb'+(state.ui.sort==='gpu'?' on':'')+'" data-s="gpu">GPU</button>');
    tb.querySelectorAll('.sb').forEach(function(b){
      b.addEventListener('click',function(){state.ui.sort=this.dataset.s;renderProcToolbar();renderProcTable();});
    });
  }

function esc(s){return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}

function procSearchStr(p) {
    var s = p.name.toLowerCase() + ' ' + p.user.toLowerCase() + ' ' + (p.cmd||'').toLowerCase() + ' ' + p.pid;
    if (p.gpus && p.gpus.length) {
      p.gpus.forEach(function(g){ s += ' gpu'+g.idx + ' gpu '+g.idx + ' #'+g.idx; });
    }
    return s;
  }

export function selectProcessRows(processes, sort, search = '') {
    const filtered = search ? processes.filter(process => procSearchStr(process).includes(search)) : processes;
    const metric = sort === 'cpu' ? 'cpu' : sort === 'mem' ? 'mem' : 'vram';
    const sorted = filtered.slice().sort((a, b) => (b[metric] || 0) - (a[metric] || 0) || a.pid - b.pid);
    return { rows: sorted.slice(0, 100), matchedCount: filtered.length };
}

function renderProcTable(){
    const { rows: sorted, matchedCount } = selectProcessRows(state.data.processes, state.ui.sort, state.ui.search);
    const totalCount = state.data.viewModel?.processTotalCount ?? 0;
    document.getElementById('proc-count').textContent = state.data.status && state.data.status.processesReady === false ? '--'
      : state.locale.messages.pcount.replace('{n}', state.ui.search ? matchedCount + ' / ' + totalCount : totalCount);
    var cpuModeLabel = state.ui.processDisplay.cpu === 'whole' ? state.locale.messages.wholeMode : state.ui.processDisplay.cpu === 'both' ? state.locale.messages.cpuBothMode : state.locale.messages.coreMode;
    var ramModeLabel = state.ui.processDisplay.ram === 'percent' ? state.locale.messages.percentMode : state.ui.processDisplay.ram === 'both' ? state.locale.messages.ramBothMode : state.locale.messages.sizeMode;
    document.getElementById('proc-hdr').innerHTML =
      '<th class="r">PID</th>'
      + '<th><span class="hdr-label">'+state.locale.messages.pname+'<button class="hdr-btn" data-hdr="name">'+(state.ui.expandedColumns.name?state.locale.messages.collapse:state.locale.messages.expand)+'</button></span></th>'
      + '<th>'+state.locale.messages.puser+'</th>'
      + '<th><span class="hdr-label">CPU<button class="hdr-btn" data-hdr="cpu" title="'+cpuModeLabel+'">'+cpuModeLabel+'</button></span></th>'
      + '<th><span class="hdr-label">RAM<button class="hdr-btn" data-hdr="ram" title="'+ramModeLabel+'">'+ramModeLabel+'</button></span></th>'
      + (state.ui.gpuProcessesEnabled === false ? '' : '<th>GPU</th>')
      + '<th><span class="hdr-label">'+state.locale.messages.pcmd+'<button class="hdr-btn" data-hdr="cmd">'+(state.ui.expandedColumns.cmd?state.locale.messages.collapse:state.locale.messages.expand)+'</button></span></th>';
    var html = '';
    sorted.forEach(function(p){
      var gpuCell = '';
      if (p.gpus && p.gpus.length) {
        var tags = p.gpus.map(function(g){
          var vTxt = g.vramStr || '—';
          var tTxt = g.memTotalStr || '—';
          var pct = g.pct;
          var cls = g.mappingStatus === 'unmatched' ? ' tag-unknown' : ' ' + tagColorClass(pct);
          return '<span class="gpu-tag'+cls+'">#'+g.idx+' '+vTxt+'/'+tTxt+' '+(Number.isFinite(pct) ? pct+'%' : '—')+'</span>';
        }).join(' ');
        gpuCell = tags;
      } else {
        gpuCell = '<span class="pmuted">'+state.locale.messages.pnoGpu+'</span>';
      }
      var cpuTxt = p.cpu.toFixed(1);
      var wholeCpuTxt = (p.cpuWhole || 0).toFixed(1);
      var coreDisplay = cpuTxt + '%';
      var wholeDisplay = wholeCpuTxt + '%';
      var cpuHtml = state.ui.processDisplay.cpu === 'both' ? '<span class="dual-value"><span>'+coreDisplay+'</span><span>'+wholeDisplay+'</span></span>' : (state.ui.processDisplay.cpu === 'whole' ? wholeDisplay : coreDisplay);
      var cpuCopy = state.ui.processDisplay.cpu === 'both' ? state.locale.messages.coreMode+' '+coreDisplay+' / '+state.locale.messages.wholeMode+' '+wholeDisplay : (state.ui.processDisplay.cpu === 'whole' ? wholeDisplay : coreDisplay);
      var ramSize = p.memStr || '—';
      var ramPercent = p.memPct.toFixed(1) + '%';
      var ramHtml = state.ui.processDisplay.ram === 'both' ? '<span class="dual-value"><span>'+ramSize+'</span><span>'+ramPercent+'</span></span>' : (state.ui.processDisplay.ram === 'percent' ? ramPercent : ramSize);
      var ramCopy = state.ui.processDisplay.ram === 'both' ? state.locale.messages.sizeMode+' '+ramSize+' / '+state.locale.messages.percentMode+' '+ramPercent : (state.ui.processDisplay.ram === 'percent' ? ramPercent : ramSize);
      var cmdFull = p.cmd || p.name;
      html+='<tr>'
        +'<td class="r">'+p.pid+'</td>'
        +'<td class="expandable'+(state.ui.expandedColumns.name?' expanded':'')+'" data-copy="'+esc(p.name)+'" title="PID '+p.pid+'&#10;'+esc(cmdFull)+'">'+esc(p.name)+'</td>'
        +'<td>'+esc(p.user)+'</td>'
        +'<td data-copy="'+esc(cpuCopy)+'">'+cpuHtml+'</td>'
        +'<td data-copy="'+esc(ramCopy)+'">'+ramHtml+'</td>'
        +(state.ui.gpuProcessesEnabled === false ? '' : '<td class="gpu-cell">'+gpuCell+'</td>')
        +'<td class="expandable'+(state.ui.expandedColumns.cmd?' expanded':'')+'" data-copy="'+esc(cmdFull)+'" title="'+esc(cmdFull)+'">'+esc(cmdFull)+'</td>'
        +'</tr>';
    });
    document.getElementById('proc-tbody').innerHTML = html;
  }

function removeCtxMenu() {
    if (state.ui.processMenu) { state.ui.processMenu.remove(); state.ui.processMenu = null; }
    if (state.ui.pendingProcesses) { state.data.processes = state.ui.pendingProcesses; state.ui.pendingProcesses = null; renderProcTable(); }
  }

export function initializeProcesses({ switchPage: navigate }) {
  switchPage = navigate;
  state.ui.sort = 'cpu';
  state.data.processes = [];
  state.ui.search = '';
  state.elements.filterInput = document.getElementById('proc-filter');
  state.elements.filterWrap = document.getElementById('filter-wrap');
  state.elements.filterInput.addEventListener('input',function(){
      state.ui.search = this.value.toLowerCase();
      state.elements.filterWrap.classList.toggle('has-text', this.value.length > 0);
      renderProcTable();
    });
  persistedViewState = state.bridge.getState() || {};
  hintDismissed = !!persistedViewState.hintDismissed;
  hintShown = false;
  state.elements.filterInput.addEventListener('focus', function() {
      if (hintDismissed || hintShown) return;
      hintShown = true;
      var hint = document.getElementById('filter-hint');
      var hintText = tr("timesSearchByNameUserPIDCommandGPU");
      hint.innerHTML = hintText;
      hint.classList.add('show');
      document.getElementById('hint-close').addEventListener('click', function() {
        hint.classList.remove('show');
        hintDismissed = true;
        state.bridge.setState(Object.assign({}, state.bridge.getState() || {}, { hintDismissed: true }));
      });
    });
  document.getElementById('filter-clear').addEventListener('click',function(){
      state.elements.filterInput.value = '';
      state.ui.search = '';
      state.elements.filterWrap.classList.remove('has-text');
      renderProcTable();
      state.elements.filterInput.focus();
    });
  document.getElementById('proc-hdr').addEventListener('click', function(event) {
      var button = event.target.closest('[data-hdr]');
      if (!button) return;
      var key = button.dataset.hdr;
      if (key === 'name' || key === 'cmd') state.ui.expandedColumns[key] = !state.ui.expandedColumns[key];
      else if (key === 'cpu') {
        var cpuModes = ['core', 'whole', 'both'];
        state.ui.processDisplay.cpu = cpuModes[(cpuModes.indexOf(state.ui.processDisplay.cpu) + 1) % cpuModes.length];
        sendToExtension({cmd:'setProcessDisplay',key:'cpu',value:state.ui.processDisplay.cpu});
      } else if (key === 'ram') {
        var ramModes = ['size', 'percent', 'both'];
        state.ui.processDisplay.ram = ramModes[(ramModes.indexOf(state.ui.processDisplay.ram) + 1) % ramModes.length];
        sendToExtension({cmd:'setProcessDisplay',key:'ram',value:state.ui.processDisplay.ram});
      }
      renderProcTable();
    });
  renderProcToolbar();
  state.ui.processMenu = null;
  state.ui.pendingProcesses = null;
  document.addEventListener('click', removeCtxMenu);
  document.addEventListener('scroll', removeCtxMenu, true);
  document.getElementById('proc-tbody').addEventListener('contextmenu', function(e) {
      var td = e.target.closest('td');
      var row = e.target.closest('tr');
      if (!td || !row) return;
      e.preventDefault();
      removeCtxMenu();
      var menu = document.createElement('div');
      menu.className = 'ctx-menu';
      var cellText = td.dataset.copy || td.textContent;
      var rowCells = row.querySelectorAll('td');
      var rowText = Array.prototype.map.call(rowCells, function(c) { return c.dataset.copy || c.textContent; }).join('\t');
      var item1 = document.createElement('div');
      item1.className = 'ctx-menu-item';
      item1.textContent = tr("copyCell");
      item1.addEventListener('click', function() { navigator.clipboard.writeText(cellText); removeCtxMenu(); });
      var itemPid = document.createElement('div');
      itemPid.className = 'ctx-menu-item';
      itemPid.textContent = tr("copyPID");
      itemPid.addEventListener('click', function() { navigator.clipboard.writeText(rowCells[0].textContent.trim()); removeCtxMenu(); });
      var item2 = document.createElement('div');
      item2.className = 'ctx-menu-item';
      item2.textContent = tr("copyRow");
      item2.addEventListener('click', function() { navigator.clipboard.writeText(rowText); removeCtxMenu(); });
      menu.appendChild(item1);
      menu.appendChild(itemPid);
      menu.appendChild(item2);
      menu.style.left = e.clientX + 'px';
      menu.style.top = e.clientY + 'px';
      document.body.appendChild(menu);
      state.ui.processMenu = menu;
      var rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 4) + 'px';
      if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 4) + 'px';
    });
}

export { renderProcToolbar, esc, procSearchStr, renderProcTable, removeCtxMenu };
