import { state } from "./state.mjs";
import { sendToExtension, tr } from "./ui.mjs";
let updateLocalIntro, applyCharts, applyGroupVisibility, applyTabularNums, closeRemoteMenu, renderServers;

let modalBody, modalScrollbar, modalScrollbarThumb, modalDragOffset;
let infoPopover, settingMenuTrigger, rows, inputs, intervalButtons, groups;
const textareaSizes = new WeakMap();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fieldChanges(before, after, path = []) {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key => fieldChanges(before[key], after[key], [...path, key]));
  }
  return [{ path, value: structuredClone(after) }];
}

function changeConfig(key, change) {
  const before = structuredClone(state.config[key]);
  change();
  const changes = fieldChanges(before, state.config[key]);
  if (changes.length) sendToExtension({ cmd: 'setConfig', key, changes });
}

function updateModalScrollbar() {
  if (!state.ui.settingsOpen) return;
  const viewport = modalBody.clientHeight;
  const overflow = modalBody.scrollHeight - viewport;
  modalScrollbar.hidden = overflow <= 1;
  if (modalScrollbar.hidden) return;
  modalScrollbar.style.top = modalBody.offsetTop + 'px';
  modalScrollbar.style.height = viewport + 'px';
  const height = Math.min(viewport, Math.max(28, viewport * viewport / modalBody.scrollHeight));
  modalScrollbarThumb.style.height = height + 'px';
  modalScrollbarThumb.style.transform = 'translateY(' + (viewport - height) * modalBody.scrollTop / overflow + 'px)';
}

function scrollModalFromPointer(event) {
  const bounds = modalScrollbar.getBoundingClientRect();
  const travel = bounds.height - modalScrollbarThumb.offsetHeight;
  if (travel <= 0) return;
  const progress = Math.max(0, Math.min(1, (event.clientY - bounds.top - modalDragOffset) / travel));
  modalBody.scrollTop = progress * (modalBody.scrollHeight - modalBody.clientHeight);
}

function endModalScrollbarDrag(event) {
  modalDragOffset = null;
  modalScrollbar.classList.remove('dragging');
  if (modalScrollbar.hasPointerCapture(event.pointerId)) modalScrollbar.releasePointerCapture(event.pointerId);
}

function showInfo(button, key) {
  infoPopover.textContent = tr(key);
  infoPopover.hidden = false;
  const bounds = button.getBoundingClientRect();
  infoPopover.style.left = Math.max(4, Math.min(bounds.left, window.innerWidth - infoPopover.offsetWidth - 4)) + 'px';
  infoPopover.style.top = Math.max(4, Math.min(bounds.bottom + 6, window.innerHeight - infoPopover.offsetHeight - 4)) + 'px';
}

function bindInfo(button, key) {
  button.addEventListener('mouseenter', () => showInfo(button, key));
  button.addEventListener('focus', () => showInfo(button, key));
  button.addEventListener('mouseleave', () => { infoPopover.hidden = true; });
  button.addEventListener('blur', () => { infoPopover.hidden = true; });
}

function resizeTextarea(input) {
  if (input.tagName !== 'TEXTAREA') return;
  const width = input.clientWidth;
  if (!width) return;
  const previous = textareaSizes.get(input);
  if (previous?.width === width && previous.value === input.value) return;
  textareaSizes.set(input, { width, value: input.value });
  input.style.height = '0px';
  input.style.height = input.scrollHeight + 2 + 'px';
}

function numericValue(raw, definition, clamp = false) {
  if (!String(raw).trim()) return undefined;
  let value = Number(raw);
  if (clamp && Number.isFinite(value)) value = Math.max(definition.minimum, Math.min(definition.maximum ?? Infinity, value));
  return Number.isFinite(value) && (definition.integer === false || Number.isInteger(value)) && value >= definition.minimum && (definition.maximum === undefined || value <= definition.maximum) ? value : undefined;
}

function bindInput(input, definition) {
  let entry = inputs.get(input);
  if (!entry) {
    entry = { input, definition, dirty: false };
    inputs.set(input, entry);
    input.addEventListener('input', () => {
      entry.dirty = true;
      const value = entry.definition.parse(input.value);
      input.classList.toggle('err', input.value !== '' && value === undefined);
      resizeTextarea(input);
      updateTimeoutReset();
      updateModalScrollbar();
    });
    input.addEventListener('blur', () => {
      commitInput(entry);
      renderSettings();
    });
  }
  entry.definition = definition;
  if (document.activeElement !== input) {
    input.value = definition.value == null ? '' : String(definition.value);
    entry.dirty = false;
    input.classList.remove('err');
  }
  input.readOnly = !!definition.readonly;
  resizeTextarea(input);
}

function commitInput(entry) {
  if (!entry.dirty) return;
  entry.dirty = false;
  const value = (entry.definition.normalize || entry.definition.parse)(entry.input.value);
  if (!entry.definition.readonly && value !== undefined) {
    if (entry.definition.normalize) { entry.input.value = String(value); entry.input.classList.remove('err'); }
    entry.definition.change(value);
  }
}

function flushSettingsInputs() {
  inputs.forEach(commitInput);
}

function closeSettingMenu() {
  state.ui.settingsMenu?.remove();
  settingMenuTrigger?.setAttribute('aria-expanded', 'false');
  state.ui.settingsMenu = null;
  settingMenuTrigger = null;
}

function openSettingMenu(trigger, options, change) {
  if (settingMenuTrigger === trigger) { closeSettingMenu(); return; }
  closeSettingMenu();
  const menu = element('div', 'setting-menu');
  menu.setAttribute('role', 'listbox');
  for (const [value, label] of options) {
    const item = element('button', 'setting-menu-item', label);
    item.type = 'button';
    item.setAttribute('role', 'option');
    const selected = trigger.dataset.value === String(value);
    item.classList.toggle('selected', selected);
    item.setAttribute('aria-selected', String(selected));
    item.addEventListener('click', event => {
      event.stopPropagation();
      closeSettingMenu();
      change(value);
      renderSettings();
    });
    menu.append(item);
  }
  document.body.append(menu);
  const bounds = trigger.getBoundingClientRect();
  menu.style.minWidth = bounds.width + 'px';
  menu.style.left = Math.max(4, Math.min(bounds.left, window.innerWidth - menu.offsetWidth - 4)) + 'px';
  menu.style.top = (window.innerHeight - bounds.bottom >= menu.offsetHeight + 4 ? bounds.bottom + 3 : Math.max(4, bounds.top - menu.offsetHeight - 3)) + 'px';
  trigger.setAttribute('aria-expanded', 'true');
  settingMenuTrigger = trigger;
  state.ui.settingsMenu = menu;
}

function setting(parent, key, definition) {
  let record = rows.get(key);
  if (!record) {
    const row = element('div', 'setting-row');
    const info = element('span', 'setting-info');
    const title = element('span', 'setting-title');
    const hint = element('small');
    const control = element('span', 'setting-control');
    info.append(title, hint);
    row.append(info, control);
    parent.append(row);
    record = { row, info, title, hint, control, definition };
    rows.set(key, record);
    if (definition.type === 'switch') {
      record.button = element('button', 'setting-switch');
      record.button.type = 'button';
      record.button.setAttribute('role', 'switch');
      record.button.append(element('span'));
      record.button.addEventListener('click', () => { record.definition.change(!record.definition.value); renderSettings(); });
      control.append(record.button);
    } else if (definition.type === 'select') {
      const wrap = element('span', 'setting-select-wrap');
      record.sizer = element('span', 'setting-select-sizer');
      record.sizer.setAttribute('aria-hidden', 'true');
      record.button = element('button', 'setting-select');
      record.button.type = 'button';
      record.button.setAttribute('aria-haspopup', 'listbox');
      record.button.setAttribute('aria-expanded', 'false');
      record.caption = element('span');
      const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      arrow.setAttribute('viewBox', '0 0 16 16');
      arrow.setAttribute('aria-hidden', 'true');
      arrow.classList.add('setting-select-arrow');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M4 6l4 4 4-4');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      arrow.append(path);
      record.button.append(record.caption, arrow);
      record.button.addEventListener('click', event => {
        event.stopPropagation();
        openSettingMenu(record.button, record.definition.options, value => record.definition.change(value));
      });
      wrap.append(record.sizer, record.button);
      control.append(wrap);
    } else if (definition.type === 'segment') {
      record.segment = element('span', 'setting-segment');
      control.append(record.segment);
      record.buttons = definition.options.map(([value]) => {
        const button = element('button');
        button.type = 'button';
        button.addEventListener('click', () => { record.definition.change(value); renderSettings(); });
        record.segment.append(button);
        return button;
      });
    } else if (definition.type === 'action') {
      record.button = element('button', 'tb');
      record.button.type = 'button';
      record.button.addEventListener('click', event => record.definition.change(event));
      control.append(record.button);
    } else {
      record.input = element(definition.type === 'textarea' ? 'textarea' : 'input', 'sett-input');
      if (definition.type === 'textarea') { record.input.rows = 1; record.input.classList.add('wide'); control.classList.add('wide'); }
      else record.input.type = definition.type === 'number' ? 'number' : 'text';
      if (definition.id) record.input.id = definition.id;
      control.append(record.input);
    }
    if (definition.help) {
      info.classList.add('sett-heading');
      const help = element('button', 'sett-info-icon', 'ⓘ');
      help.type = 'button';
      help.setAttribute('aria-label', definition.label);
      bindInfo(help, definition.help);
      info.append(help);
    }
  }
  record.definition = definition;
  record.row.hidden = definition.visible === false;
  record.row.classList.toggle('is-disabled', !!definition.disabled || !!definition.readonly);
  record.title.textContent = definition.label;
  record.title.title = definition.hint || '';
  record.hint.textContent = definition.hint || '';
  record.hint.hidden = !definition.hint;
  if (record.row.hidden && settingMenuTrigger === record.button) closeSettingMenu();
  if (record.button) {
    record.button.disabled = !!definition.disabled;
    record.button.dataset.act = key;
    if (definition.type === 'switch') {
      record.button.classList.toggle('on', !!definition.value);
      record.button.setAttribute('aria-checked', String(!!definition.value));
    } else if (definition.type === 'select') {
      record.button.dataset.value = String(definition.value);
      record.caption.textContent = (definition.options.find(([value]) => String(value) === String(definition.value)) || definition.options[0])[1];
      const labels = definition.options.map(([, label]) => label).join('\0');
      if (record.optionLabels !== labels) {
        record.optionLabels = labels;
        record.sizer.replaceChildren(...definition.options.map(([, label]) => element('span', '', label)));
      }
    } else record.button.textContent = definition.caption || '';
  }
  if (record.segment) definition.options.forEach(([value, label], index) => {
    record.buttons[index].textContent = label;
    record.buttons[index].classList.toggle('on', definition.value === value);
  });
  if (record.input) {
    record.input.setAttribute('aria-label', definition.label);
    if (definition.type === 'number') {
      record.input.min = definition.minimum;
      if (definition.maximum !== undefined) record.input.max = definition.maximum;
      record.input.step = definition.integer === false ? 'any' : '1';
      definition.parse = raw => numericValue(raw, definition);
      definition.normalize = raw => numericValue(raw, definition, true);
    } else definition.parse ||= raw => raw;
    bindInput(record.input, definition);
  }
}

function settingGroup(parent, key, { visible = true, disabled = false } = {}) {
  let group = groups.get(key);
  if (!group) { group = element('div', 'setting-children'); parent.append(group); groups.set(key, group); }
  group.hidden = !visible;
  group.classList.toggle('dim', disabled);
  return group;
}

function renderIntervalRow() {
  const parent = document.getElementById('interval-row');
  if (!intervalButtons.length) {
    for (const seconds of [1, 2, 5, 10]) {
      const button = element('button', 'tb');
      button.type = 'button';
      button.addEventListener('click', () => { changeConfig('refreshInterval', () => { state.config.refreshInterval = seconds; }); renderSettings(); });
      parent.append(button);
      intervalButtons.push({ button, seconds });
    }
    const input = element('input', 'sett-input');
    input.type = 'number';
    input.id = 'refresh-interval-input';
    parent.append(input);
  }
  for (const { button, seconds } of intervalButtons) {
    button.textContent = seconds + tr('s');
    button.classList.toggle('on', state.config.refreshInterval === seconds);
  }
  const input = document.getElementById('refresh-interval-input');
  const limits = state.initial.refreshSetting;
  input.min = limits.minimum; input.max = limits.maximum; input.step = 'any';
  input.title = tr('refreshIntervalRange');
  bindInput(input, { value: state.config.refreshInterval, parse: raw => numericValue(raw, { ...limits, integer: false }), normalize: raw => numericValue(raw, { ...limits, integer: false }, true), change(value) {
    changeConfig('refreshInterval', () => { state.config.refreshInterval = value; });
  } });
}

function renderTimeoutSettings() {
  const body = document.getElementById('sett-timeouts-body');
  const enabled = state.config.timeouts.enabled === true;
  document.getElementById('sett-timeouts-label').textContent = tr('connectionAndCollection');
  document.getElementById('custom-timeouts-label').textContent = tr('customTimeouts');
  document.getElementById('sett-timeouts-section').classList.toggle('custom-timeouts-enabled', enabled);
  body.hidden = !enabled;
  body.classList.add('setting-children', 'last-setting');
  document.getElementById('timeout-reset').hidden = !enabled;
  document.getElementById('timeout-toggle').classList.toggle('on', enabled);
  document.getElementById('timeout-toggle').setAttribute('aria-checked', String(enabled));
  document.getElementById('timeout-reset').textContent = tr('restoreDefaults');
  for (const field of state.initial.collectionFields) {
    setting(body, 'strategy-' + field.key, { type: 'number', label: tr(field.label), help: field.help,
      minimum: field.minimum, maximum: field.maximum, value: state.config.timeouts[field.key], change(value) {
        changeConfig('timeouts', () => { state.config.timeouts[field.key] = value; });
      } });
  }
  updateTimeoutReset();
}

function updateTimeoutReset() {
  if (!inputs) return;
  const reset = document.getElementById('timeout-reset');
  reset.disabled = state.initial.collectionFields.every(field => {
    const record = rows.get('strategy-' + field.key);
    const draft = record && inputs.get(record.input);
    return (draft?.dirty ? draft.definition.parse(draft.input.value) : state.config.timeouts[field.key]) === field.default;
  });
}

function renderSettingsBody() {
  const bar = state.config.statusBar, gpu = bar.gpu || {};
  const barBody = document.getElementById('sett-body');
  const bool = (parent, key, label, group, get, put, options = {}) => setting(parent, key, {
    type: 'switch', label, value: get(), ...options, change(value) { changeConfig(group, () => put(value)); options.effect?.(); },
  });
  const select = (parent, key, label, group, value, options, put, extra = {}) => setting(parent, key, {
    type: 'select', label, value, options, ...extra, change(value) { changeConfig(group, () => put(value)); extra.effect?.(); },
  });
  bool(barBody, 'bar-toggle', tr('barToggle'), 'statusBar', () => bar.barEnabled !== false, value => { bar.barEnabled = value; });
  const barVisible = bar.barEnabled !== false;
  const body = settingGroup(barBody, 'bar-options', { visible: barVisible });
  setting(body, 'bar-align', { type: 'segment', label: tr('barAlign'), visible: barVisible, value: bar.alignment || 'left',
    options: [['left', tr('left')], ['right', tr('right')]], change(value) { changeConfig('statusBar', () => { bar.alignment = value; }); } });
  setting(body, 'bar-priority', { type: 'number', id: 'bar-priority-input', label: tr('barPriority'), hint: tr('barPriorityTip'),
    visible: barVisible, value: bar.priority, minimum: 0, integer: false, change(value) { changeConfig('statusBar', () => { bar.priority = value; }); } });
  for (const [key, label] of [['cpu', 'CPU'], ['ram', 'RAM'], ['disk', tr('diskUsage')], ['ssh', tr('sshLabel')]]) {
    if (key === 'ssh') continue;
    bool(body, 'bar-' + key, label, 'statusBar', () => !!bar[key], value => { bar[key] = value; }, { visible: barVisible });
  }
  select(body, 'diskIO', tr('diskIO'), 'statusBar', bar.diskIO,
    [['off',tr('scopeOff')],['read',tr('diskIORead')],['write',tr('diskIOWrite')],['both',tr('netAll')],['combined',tr('netMerge')]],
    value => { bar.diskIO = value; }, { visible: barVisible });
  select(body, 'net', tr('netLabel'), 'statusBar', bar.net,
    [['off',tr('scopeOff')],['up',tr('netUp')],['down',tr('netDown')],['both',tr('netAll')],['combined',tr('netMerge')]],
    value => { bar.net = value; }, { visible: barVisible });
  bool(body, 'bar-ssh', tr('sshLabel'), 'statusBar', () => !!bar.ssh, value => { bar.ssh = value; }, { visible: barVisible });
  bool(body, 'gpu-summary', tr('gpuSummary'), 'statusBar', () => !!gpu.summary, value => { gpu.summary = value; }, { visible: barVisible });
  const summaryBody = settingGroup(body, 'gpu-summary-options', { visible: barVisible && !!gpu.summary });
  bool(summaryBody, 'gpu-idle-ids', tr('gpuIdleIds'), 'statusBar', () => !!gpu.showIdleIds, value => { gpu.showIdleIds = value; }, { visible: barVisible && !!gpu.summary });
  select(body, 'gpu-mode', tr('gpuPerf'), 'statusBar', gpu.mode,
    [['off',tr('scopeOff')],['all',tr('gpuAll')],['first',tr('gpuFirst')],['specify',tr('gpuSpecify')],['my',tr('scopeMy')]],
    value => { gpu.mode = value; }, { visible: barVisible });
  const gpuBody = settingGroup(body, 'gpu-perf-options', { visible: barVisible && gpu.mode !== 'off' });
  setting(gpuBody, 'gpu-first', { type:'number', id:'gpu-first-input', label:tr('gpuFirst'), minimum:1, maximum:1024,
    value:gpu.firstN, visible:barVisible && gpu.mode === 'first', change(value) { changeConfig('statusBar', () => { gpu.firstN = value; }); } });
  setting(gpuBody, 'gpu-cards', { type:'text', id:'gpu-cards-input', label:tr('gpuSpecify'), hint:'', value:gpu.cards.join(','),
    visible:barVisible && gpu.mode === 'specify', parse(raw) {
      if (!raw.trim()) return [];
      const values = raw.split(',').map(value => value.trim());
      return values.every(value => /^\d+$/.test(value)) ? [...new Set(values.map(Number))].sort((a,b) => a-b) : undefined;
    }, change(value) { changeConfig('statusBar', () => { gpu.cards = value; }); } });
  refreshGpuAvailability();
  select(gpuBody, 'gpu-metric', tr('gpuMetric'), 'statusBar', gpu.metric,
    [['util',tr('metUtil')],['vram',tr('metVram')],['both',tr('metBoth')]],
    value => { gpu.metric = value; }, { visible:barVisible && gpu.mode !== 'off' });
  bool(gpuBody, 'gpu-skip-idle', tr('gpuSkipIdle'), 'statusBar', () => !!gpu.skipIdle, value => { gpu.skipIdle = value; }, { visible:barVisible && gpu.mode !== 'off' });

  const disk = state.config.disk, filter = disk.mountFilter;
  const diskBody = document.getElementById('sett-disk-body');
  const custom = filter === 'custom';
  const values = custom ? disk : state.initial.diskPresets[filter];
  select(diskBody, 'disk-filter', tr('diskFilter'), 'disk', filter,
    [['default',tr('diskDefault')],['more',tr('diskMore')],['all',tr('diskAll')],['custom',tr('diskCustom')]], value => {
      if (value === 'custom' && !custom && disk.customFsExclude === undefined && disk.customPathExclude === undefined) {
        Object.assign(disk, values);
      }
      disk.mountFilter = value;
    });
  const rulesBody = settingGroup(diskBody, 'disk-rules', { disabled: !custom });
  rulesBody.classList.add('custom-group');
  bool(rulesBody, 'disk-hide-virtual', tr('diskHideVirtual'), 'disk', () => values.hideVirtualFs, value => { disk.hideVirtualFs = value; },
    { hint:tr('diskHideVirtualTip'),disabled:!custom });
  for (const [id,label,hint,key,value] of [
    ['disk-fs-input','diskExcludeFs','diskExcludeFsTip','customFsExclude',values.customFsExclude || ''],
    ['disk-path-input','diskExcludePath','diskExcludePathTip','customPathExclude',values.customPathExclude || ''],
  ]) setting(rulesBody,id,{type:'textarea',id,label:tr(label),hint:tr(hint),value,readonly:!custom,
    change(value) { changeConfig('disk', () => { disk[key] = value; }); }});
  bool(diskBody,'disk-hide-parent',tr('diskHideParent'),'disk',()=>disk.hideParentMounts !== false,value=>{disk.hideParentMounts=value;},{hint:tr('diskHideParentTip')});

  const display=state.config.display, displayBody=document.getElementById('sett-display-body');
  bool(displayBody,'charts-toggle',tr('chartsToggle'),'display',()=>display.charts !== false,value=>{display.charts=value;},{effect:applyCharts});
  const minutes = display.sparkMinutes || 5;
  const durations = [...new Set([1,2,5,10,30,minutes])].sort((a,b)=>a-b);
  select(displayBody,'spark-min',tr('sparkLabel'),'display',String(minutes),
    durations.map(value=>[String(value),value+tr('min2')]),value=>{display.sparkMinutes=Number(value);state.charts.windowMilliseconds=Number(value)*60000;});
  bool(displayBody,'tabular-toggle',tr('tabularNums'),'display',()=>display.tabularNums !== false,value=>{display.tabularNums=value;},{hint:tr('tabularNumsTip'),effect:applyTabularNums});
  const groups={cpu:'CPU',memory:'RAM',disk:tr('diskLabel'),network:tr('networkGroup'),gpuSummary:tr('gpuSummaryGroup'),gpuCards:tr('gpuCardsGroup')};
  for (const [key,label] of Object.entries(groups)) bool(displayBody,'group-'+key,label,'display',
    ()=>!(display.hiddenGroups || {})[key],value=>{display.hiddenGroups={...display.hiddenGroups,[key]:!value};},{effect:applyGroupVisibility});
  for (const [key,label] of [['highlightMyGpus','myGpuBorder'],['showGpuPicker','gpuPicker'],['showGpuUsers','gpuUsers']]) {
    bool(displayBody,key,tr(label),'display',()=>display[key] !== false,value=>{display[key]=value;},{effect:applyGroupVisibility});
  }
  const servers=state.config.servers, actions=servers.actions || {};
  const actionsBody=document.getElementById('sett-actions-body');
  for (const [key,label] of [['editor','createSwitchEditorView'],['window','createMoveToNewWindow'],['terminal','openSSHTerminal'],['remoteWindow','openRemoteWindow']]) {
    bool(actionsBody,'action-'+key,tr(label),'servers',()=>actions[key] !== false,value=>{servers.actions={...servers.actions,[key]:value};},{effect:()=>{if(state.environment.localMode)renderServers();}});
  }
  const remoteBody = settingGroup(actionsBody, 'remote-window-options', { visible: actions.remoteWindow !== false });
  select(remoteBody,'remote-window-mode',tr('remoteWindowBehavior'),'servers',servers.remoteWindowMode || 'menu',
    [['new',tr('newWorkspace')],['recent',tr('recentWorkspace')],['menu',tr('chooseFromMenu')]],
    value=>{servers.remoteWindowMode=value;closeRemoteMenu();if(state.environment.localMode)renderServers();},{visible:actions.remoteWindow !== false});
  document.getElementById('sett-servers-section').hidden=false;
  const serversBody=document.getElementById('sett-servers-body');
  bool(serversBody,'servers-visible',tr('refreshVisiblePanelsOnly'),'servers',()=>servers.visibleOnly === true,value=>{servers.visibleOnly=value;},{hint:tr('hiddenServersStopSamplingWhenEnabledChartsMay')});
  bool(serversBody,'servers-restore',tr('restoreTabsOnStartup'),'servers',()=>servers.restoreTabs !== false,value=>{servers.restoreTabs=value;});
  setting(serversBody,'ssh-default-add',{type:'action',label:tr('remoteSSHAutoInstall'),hint:tr('addToTheDefaultListToInstallAutomatically'),
    caption:state.config.sshDefaultInstalled?tr('added'):state.ui.installPending?tr('adding'):tr('addToDefaults'),
    disabled:state.config.sshDefaultInstalled || state.ui.installPending,change:addSshDefaultExtension});
  if(state.ui.settingsOpen)requestAnimationFrame(updateModalScrollbar);
}

function renderSettings() {
  renderIntervalRow();
  renderTimeoutSettings();
  renderSettingsBody();
  const parents = ['sett-body','sett-disk-body','sett-display-body','sett-actions-body','sett-servers-body','sett-timeouts-body'].map(id => document.getElementById(id));
  for (const parent of [...parents, ...groups.values()]) {
    const children = [...parent.children].filter(row=>!row.hidden);
    children.forEach((row,index)=>row.classList.toggle('last-setting',index===children.length-1));
  }
}

function updateSshDefaultUi(error) {
  const introButton=document.getElementById('server-intro-ssh-default');
  introButton.hidden=!!state.config.sshDefaultInstalled;
  introButton.textContent=state.ui.installPending?tr('adding'):tr('addToDefaults');
  introButton.disabled=!!state.ui.installPending;
  if(rows?.has('ssh-default-add')) {
    const button=rows.get('ssh-default-add').button;
    button.textContent=state.config.sshDefaultInstalled?tr('added'):state.ui.installPending?tr('adding'):tr('addToDefaults');
    button.disabled=!!(state.config.sshDefaultInstalled || state.ui.installPending);
    button.classList.toggle('on',!state.config.sshDefaultInstalled);
  }
  for(const id of ['server-intro-ssh-error','ssh-default-error']) {
    const node=document.getElementById(id);
    if(node){node.textContent=error || '';node.hidden=!error;}
  }
  updateLocalIntro();
}

function addSshDefaultExtension(event) {
  if(state.config.sshDefaultInstalled || state.ui.installPending)return;
  state.ui.installPending=true;updateSshDefaultUi();
  sendToExtension({cmd:'addSshDefaultExtension',dismissIntro:event?.currentTarget?.id==='server-intro-ssh-default'});
}

function openModal() {
  state.ui.settingsOpen=true;
  document.getElementById('modal-mask').classList.add('open');
  document.getElementById('modal-title-text').textContent=tr('settBtn');
  for(const [id,key] of [['sett-bar-label','statusBar'],['sett-disk-label','diskLabel'],['sett-display-label','displayLabel'],['sett-actions-label','actionButtons'],['sett-servers-label','servers']]) {
    document.getElementById(id).textContent=tr(key);
  }
  renderSettings();
}

function closeModal() {
  flushSettingsInputs();closeSettingMenu();
  state.ui.settingsOpen=false;
  modalScrollbar.hidden=true;infoPopover.hidden=true;
  document.getElementById('modal-mask').classList.remove('open');
}

export function initializeSettings(effects) {
  ({ updateLocalIntro, applyCharts, applyGroupVisibility, applyTabularNums, closeRemoteMenu, renderServers } = effects);
  groups = new Map();
  rows=new Map();inputs=new Map();intervalButtons=[];
  state.ui.settingsMenu=null;state.ui.installPending=false;settingMenuTrigger=null;
  modalBody=document.getElementById('modal-body');
  modalScrollbar=document.getElementById('modal-scrollbar');
  modalScrollbarThumb=document.getElementById('modal-scrollbar-thumb');
  infoPopover=element('div','gpu-info-popover sett-info-popover timeout-info-popover');
  infoPopover.hidden=true;document.body.append(infoPopover);
  bindInfo(document.getElementById('timeout-info'),'timeoutInfo');
  bindInfo(document.getElementById('sett-bar-info'),'inALocalLinuxWindowTheStatusBar');
  document.getElementById('timeout-reset').addEventListener('click',()=>{
    changeConfig('timeouts', () => { for(const field of state.initial.collectionFields)state.config.timeouts[field.key]=field.default; });
    renderSettings();
  });
  document.getElementById('timeout-toggle').addEventListener('click',()=>{
    changeConfig('timeouts', () => { state.config.timeouts.enabled=!state.config.timeouts.enabled; }); renderSettings();
  });
  const saveRetry = document.getElementById('config-save-retry');
  saveRetry.classList.add('tb');
  saveRetry.addEventListener('click', () => sendToExtension({cmd:'retryConfigSave'}));
  showConfigSaveState(state.initial.saveState);
  document.getElementById('settings-btn').addEventListener('click',openModal);
  document.getElementById('modal-close').addEventListener('click',closeModal);
  document.getElementById('open-vsc-settings').addEventListener('click',()=>sendToExtension({cmd:'openSettings'}));
  modalScrollbar.addEventListener('pointerdown',event=>{
    if(modalScrollbar.hidden)return;
    event.preventDefault();
    modalScrollbar.classList.add('dragging');
    const bounds=modalScrollbarThumb.getBoundingClientRect();
    modalDragOffset=event.clientY>=bounds.top&&event.clientY<=bounds.bottom?event.clientY-bounds.top:modalScrollbarThumb.offsetHeight/2;
    modalScrollbar.setPointerCapture(event.pointerId);scrollModalFromPointer(event);
  });
  modalScrollbar.addEventListener('pointermove',event=>{if(modalDragOffset!==null)scrollModalFromPointer(event);});
  modalScrollbar.addEventListener('pointerup',endModalScrollbarDrag);
  modalScrollbar.addEventListener('pointercancel',endModalScrollbarDrag);
  modalDragOffset=null;
  modalBody.addEventListener('scroll',()=>{closeSettingMenu();infoPopover.hidden=true;updateModalScrollbar();});
  window.addEventListener('resize',()=>{closeSettingMenu();infoPopover.hidden=true;document.querySelectorAll('#disk-fs-input, #disk-path-input').forEach(resizeTextarea);updateModalScrollbar();});
  document.addEventListener('click',event=>{
    if(state.ui.settingsMenu&&!state.ui.settingsMenu.contains(event.target)&&!settingMenuTrigger?.contains(event.target))closeSettingMenu();
    const link=event.target.closest('a[href]');
    if(link){event.preventDefault();sendToExtension({cmd:'openLink',url:link.href});}
  });
  document.addEventListener('keydown',event=>{if(event.key==='Escape')closeSettingMenu();});
}

export function showConfigSaveState(saveState = {status:'saved',error:null}) {
  state.config.saveState = saveState;
  const error = document.getElementById('config-save-error');
  error.hidden = saveState.status !== 'error';
  document.getElementById('config-save-error-text').textContent = tr('configSaveFailed');
  error.title = saveState.error || '';
  document.getElementById('config-save-retry').textContent = tr('retry');
  if (state.ui.settingsOpen) requestAnimationFrame(updateModalScrollbar);
}

export { renderSettings, renderSettingsBody, renderTimeoutSettings, renderIntervalRow, flushSettingsInputs, openModal, closeModal, updateSshDefaultUi, addSshDefaultExtension, openSettingMenu, closeSettingMenu, updateModalScrollbar };

export function refreshGpuAvailability() {
  const row = rows.get('gpu-cards');
  if (!row) return;
  const badCards = state.data.viewModel ? state.config.statusBar.gpu.cards.filter(index => !state.data.gpus.some(card => card.idx === index)) : [];
  row.hint.textContent = badCards.length ? tr('cardNotFound', {badCards}) : '';
  row.hint.hidden = !badCards.length;
}
