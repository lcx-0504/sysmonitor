import { state, currentGpus } from './state.mjs';
import { element, sendToExtension, tr } from './ui.mjs';
import { TO_EXTENSION } from './protocol.mjs';
import { chartMinutes, updateChartWindow } from './chart-state.mjs';
import { closeMenu, createTooltip, isMenuOpen, openMenu } from './popover.mjs';
import { applyCharts, applyGroupVisibility, applyTabularNums } from './performance.mjs';
import { addSshDefaultExtension, closeRemoteMenu, renderServers, sshDefaultStatus } from './servers.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SETTING_MENU = 'setting';
const REFRESH_INTERVAL_PRESETS = [1, 2, 5, 10];
const CHART_MINUTE_PRESETS = [1, 2, 5, 10, 30];
const GPU_FIRST_LIMITS = { minimum: 1, maximum: 1024 };
const MODAL_SCROLL_THUMB_MIN_PX = 28;
const SCROLL_OVERFLOW_TOLERANCE_PX = 1;
// A textarea's scrollHeight excludes its top and bottom borders.
const TEXTAREA_BORDER_PX = 2;
const SECTION_BODY_IDS = ['sett-body', 'sett-disk-body', 'sett-display-body', 'sett-actions-body', 'sett-servers-body', 'sett-collection-body'];

const rows = new Map();
const inputs = new Map();
const settingGroups = new Map();
const textareaSizes = new WeakMap();
const intervalButtons = [];
let settingsOpen = false;
let modalDragOffset = null;
let modalBody, modalScrollbar, modalScrollbarThumb, helpTooltip;

function fieldChanges(before, after, path = []) {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) => fieldChanges(before[key], after[key], [...path, key]));
  }
  return [{ path, value: structuredClone(after) }];
}

function changeConfig(key, change) {
  const before = structuredClone(state.config[key]);
  change();
  const changes = fieldChanges(before, state.config[key]);
  if (changes.length) sendToExtension(TO_EXTENSION.setConfig, { key, changes });
}

function updateModalScrollbar() {
  if (!settingsOpen) return;
  const viewport = modalBody.clientHeight;
  const overflow = modalBody.scrollHeight - viewport;
  modalScrollbar.hidden = overflow <= SCROLL_OVERFLOW_TOLERANCE_PX;
  if (modalScrollbar.hidden) return;
  modalScrollbar.style.top = modalBody.offsetTop + 'px';
  modalScrollbar.style.height = viewport + 'px';
  const height = Math.min(viewport, Math.max(MODAL_SCROLL_THUMB_MIN_PX, viewport * viewport / modalBody.scrollHeight));
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

function startModalScrollbarDrag(event) {
  if (modalScrollbar.hidden) return;
  event.preventDefault();
  modalScrollbar.classList.add('dragging');
  const bounds = modalScrollbarThumb.getBoundingClientRect();
  modalDragOffset = event.clientY >= bounds.top && event.clientY <= bounds.bottom ? event.clientY - bounds.top : modalScrollbarThumb.offsetHeight / 2;
  modalScrollbar.setPointerCapture(event.pointerId);
  scrollModalFromPointer(event);
}

function endModalScrollbarDrag(event) {
  modalDragOffset = null;
  modalScrollbar.classList.remove('dragging');
  if (modalScrollbar.hasPointerCapture(event.pointerId)) modalScrollbar.releasePointerCapture(event.pointerId);
}

function bindHelp(button, text) {
  helpTooltip.bind(button, (tooltip) => {
    tooltip.textContent = text();
  });
}

function resizeTextarea(input) {
  if (input.tagName !== 'TEXTAREA') return;
  const width = input.clientWidth;
  if (!width) return;
  const previous = textareaSizes.get(input);
  if (previous?.width === width && previous.value === input.value) return;
  textareaSizes.set(input, { width, value: input.value });
  input.style.height = '0px';
  input.style.height = input.scrollHeight + TEXTAREA_BORDER_PX + 'px';
}

function numericValue(raw, definition, clamp = false) {
  if (!String(raw).trim()) return undefined;
  let value = Number(raw);
  if (clamp && Number.isFinite(value)) value = Math.max(definition.minimum, Math.min(definition.maximum ?? Infinity, value));
  const integral = definition.integer === false || Number.isInteger(value);
  const inRange = value >= definition.minimum && (definition.maximum === undefined || value <= definition.maximum);
  return Number.isFinite(value) && integral && inRange ? value : undefined;
}

function commitInput(entry) {
  if (!entry.dirty) return;
  entry.dirty = false;
  const value = (entry.definition.normalize || entry.definition.parse)(entry.input.value);
  if (entry.definition.readonly || value === undefined) return;
  if (entry.definition.normalize) {
    entry.input.value = String(value);
    entry.input.classList.remove('err');
  }
  entry.definition.change(value);
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
      updateCollectionReset();
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

function flushSettingsInputs() {
  inputs.forEach(commitInput);
}

function closeSettingMenu() {
  closeMenu(SETTING_MENU);
}

function openSettingMenu(trigger, options, change) {
  if (isMenuOpen(SETTING_MENU, trigger)) {
    closeSettingMenu();
    return;
  }
  const menu = element('div', 'popup-menu setting-menu');
  menu.setAttribute('role', 'listbox');
  for (const [value, label] of options) {
    const item = element('button', 'popup-menu-item setting-menu-item', label);
    item.type = 'button';
    item.setAttribute('role', 'option');
    const selected = trigger.dataset.value === String(value);
    item.classList.toggle('selected', selected);
    item.setAttribute('aria-selected', String(selected));
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      closeSettingMenu();
      change(value);
      renderSettings();
    });
    menu.append(item);
  }
  menu.style.minWidth = trigger.getBoundingClientRect().width + 'px';
  openMenu({ owner: SETTING_MENU, trigger, content: menu, placement: { align: 'start', side: 'below', gap: 3 }, closeOnScroll: modalBody, closeOnResize: true });
}

function createSwitchControl(record) {
  const button = element('button', 'setting-switch');
  button.type = 'button';
  button.setAttribute('role', 'switch');
  button.append(element('span'));
  button.addEventListener('click', () => {
    record.definition.change(!record.definition.value);
    renderSettings();
  });
  record.button = button;
  record.control.append(button);
}

function selectArrow() {
  const arrow = document.createElementNS(SVG_NS, 'svg');
  arrow.setAttribute('viewBox', '0 0 16 16');
  arrow.setAttribute('aria-hidden', 'true');
  arrow.classList.add('setting-select-arrow');
  const path = document.createElementNS(SVG_NS, 'path');
  for (const [name, value] of [['d', 'M4 6l4 4 4-4'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.5'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) {
    path.setAttribute(name, value);
  }
  arrow.append(path);
  return arrow;
}

function createSelectControl(record) {
  const wrap = element('span', 'setting-select-wrap');
  record.sizer = element('span', 'setting-select-sizer');
  record.sizer.setAttribute('aria-hidden', 'true');
  const button = element('button', 'setting-select');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  record.caption = element('span');
  button.append(record.caption, selectArrow());
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    openSettingMenu(button, record.definition.options, (value) => record.definition.change(value));
  });
  record.button = button;
  wrap.append(record.sizer, button);
  record.control.append(wrap);
}

function createSegmentControl(record, definition) {
  record.segment = element('span', 'setting-segment');
  record.control.append(record.segment);
  record.buttons = definition.options.map(([value]) => {
    const button = element('button');
    button.type = 'button';
    button.addEventListener('click', () => {
      record.definition.change(value);
      renderSettings();
    });
    record.segment.append(button);
    return button;
  });
}

function createActionControl(record) {
  const button = element('button', 'tb');
  button.type = 'button';
  button.addEventListener('click', (event) => record.definition.change(event));
  record.button = button;
  record.control.append(button);
}

function createInputControl(record, definition) {
  const textarea = definition.type === 'textarea';
  record.input = element(textarea ? 'textarea' : 'input', 'sett-input');
  if (textarea) {
    record.input.rows = 1;
    record.input.classList.add('wide');
    record.control.classList.add('wide');
  } else record.input.type = definition.type === 'number' ? 'number' : 'text';
  if (definition.id) record.input.id = definition.id;
  record.control.append(record.input);
}

const CONTROL_FACTORIES = { switch: createSwitchControl, select: createSelectControl, segment: createSegmentControl, action: createActionControl };

function createSettingRow(parent, key, definition) {
  const row = element('div', 'setting-row');
  const info = element('span', 'setting-info');
  const title = element('span', 'setting-title');
  const hint = element('small');
  const control = element('span', 'setting-control');
  info.append(title, hint);
  row.append(info, control);
  parent.append(row);
  const record = { row, info, title, hint, control, definition };
  rows.set(key, record);
  (CONTROL_FACTORIES[definition.type] || createInputControl)(record, definition);
  if (definition.help) {
    info.classList.add('sett-heading');
    const help = element('button', 'sett-info-icon', 'ⓘ');
    help.type = 'button';
    help.setAttribute('aria-label', definition.label);
    bindHelp(help, () => tr(record.definition.help));
    info.append(help);
  }
  return record;
}

function updateSettingButton(record, key, definition) {
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
  } else {
    record.button.textContent = definition.caption || '';
    record.button.classList.toggle('on', !!definition.active);
  }
}

function updateSettingInput(record, definition) {
  record.input.setAttribute('aria-label', definition.label);
  if (definition.type === 'number') {
    record.input.min = definition.minimum;
    if (definition.maximum !== undefined) record.input.max = definition.maximum;
    record.input.step = definition.integer === false ? 'any' : '1';
    definition.parse = (raw) => numericValue(raw, definition);
    definition.normalize = (raw) => numericValue(raw, definition, true);
  } else definition.parse ||= (raw) => raw;
  bindInput(record.input, definition);
}

function setting(parent, key, definition) {
  const record = rows.get(key) || createSettingRow(parent, key, definition);
  record.definition = definition;
  record.row.hidden = definition.visible === false;
  record.row.classList.toggle('is-disabled', !!definition.disabled || !!definition.readonly);
  record.title.textContent = definition.label;
  record.title.title = definition.hint || '';
  record.hint.textContent = definition.hint || '';
  record.hint.hidden = !definition.hint;
  if (record.row.hidden && record.button && isMenuOpen(SETTING_MENU, record.button)) closeSettingMenu();
  if (record.button) updateSettingButton(record, key, definition);
  if (record.segment) {
    definition.options.forEach(([value, label], index) => {
      record.buttons[index].textContent = label;
      record.buttons[index].classList.toggle('on', definition.value === value);
    });
  }
  if (record.input) updateSettingInput(record, definition);
}

const assign = (target, property) => (value) => {
  target[property] = value;
};

function switchSetting(parent, key, label, group, read, write, options = {}) {
  setting(parent, key, { type: 'switch', label, value: read(), ...options, change(value) {
    changeConfig(group, () => write(value));
    options.effect?.();
  } });
}

function selectSetting(parent, key, label, group, value, choices, write, options = {}) {
  setting(parent, key, { type: 'select', label, value, options: choices, ...options, change(next) {
    changeConfig(group, () => write(next));
    options.effect?.();
  } });
}

function settingGroup(parent, key, { visible = true, disabled = false } = {}) {
  let group = settingGroups.get(key);
  if (!group) {
    group = element('div', 'setting-children');
    parent.append(group);
    settingGroups.set(key, group);
  }
  group.hidden = !visible;
  group.classList.toggle('dim', disabled);
  return group;
}

function renderIntervalRow() {
  const parent = document.getElementById('interval-row');
  if (!intervalButtons.length) {
    for (const seconds of REFRESH_INTERVAL_PRESETS) {
      const button = element('button', 'tb');
      button.type = 'button';
      button.addEventListener('click', () => {
        changeConfig('refreshInterval', () => {
          state.config.refreshInterval = seconds;
        });
        renderSettings();
      });
      parent.append(button);
      intervalButtons.push({ button, seconds });
    }
    const input = element('input', 'sett-input');
    input.type = 'number';
    input.id = 'refresh-interval-input';
    parent.append(input);
  }
  for (const { button, seconds } of intervalButtons) {
    button.textContent = tr('seconds', { count: seconds });
    button.classList.toggle('on', state.config.refreshInterval === seconds);
  }
  const input = document.getElementById('refresh-interval-input');
  const limits = { ...state.initial.refreshSetting, integer: false };
  input.min = limits.minimum;
  input.max = limits.maximum;
  input.step = 'any';
  input.title = tr('refreshIntervalRange');
  bindInput(input, { value: state.config.refreshInterval, parse: (raw) => numericValue(raw, limits), normalize: (raw) => numericValue(raw, limits, true), change(value) {
    changeConfig('refreshInterval', () => {
      state.config.refreshInterval = value;
    });
  } });
}

function renderCollectionSettings() {
  const body = document.getElementById('sett-collection-body');
  const enabled = state.config.collection.custom === true;
  document.getElementById('sett-collection-section').classList.toggle('custom-collection-enabled', enabled);
  body.hidden = !enabled;
  body.classList.add('setting-children', 'last-setting');
  document.getElementById('collection-reset').hidden = !enabled;
  const toggle = document.getElementById('collection-toggle');
  toggle.classList.toggle('on', enabled);
  toggle.setAttribute('aria-checked', String(enabled));
  for (const field of state.initial.collectionFields) {
    setting(body, 'collection-' + field.key, { type: 'number', label: tr(field.label), help: field.help,
      minimum: field.minimum, maximum: field.maximum, value: state.config.collection[field.key], change(value) {
        changeConfig('collection', () => {
          state.config.collection[field.key] = value;
        });
      } });
  }
  updateCollectionReset();
}

function updateCollectionReset() {
  document.getElementById('collection-reset').disabled = state.initial.collectionFields.every((field) => {
    const record = rows.get('collection-' + field.key);
    const draft = record && inputs.get(record.input);
    return (draft?.dirty ? draft.definition.parse(draft.input.value) : state.config.collection[field.key]) === field.default;
  });
}

function renderStatusBarGpuSettings(parent, gpu, barVisible) {
  switchSetting(parent, 'gpu-summary', tr('gpuSummary'), 'statusBar', () => !!gpu.summary, assign(gpu, 'summary'), { visible: barVisible });
  const summaryBody = settingGroup(parent, 'gpu-summary-options', { visible: barVisible && !!gpu.summary });
  switchSetting(summaryBody, 'gpu-idle-ids', tr('gpuIdleIds'), 'statusBar', () => !!gpu.showIdleIds, assign(gpu, 'showIdleIds'), { visible: barVisible && !!gpu.summary });
  selectSetting(parent, 'gpu-mode', tr('gpuPerf'), 'statusBar', gpu.mode,
    [['off', tr('scopeOff')], ['all', tr('gpuAll')], ['first', tr('gpuFirst')], ['specify', tr('gpuSpecify')], ['my', tr('scopeMy')]], assign(gpu, 'mode'), { visible: barVisible });
  const perfVisible = barVisible && gpu.mode !== 'off';
  const gpuBody = settingGroup(parent, 'gpu-perf-options', { visible: perfVisible });
  setting(gpuBody, 'gpu-first', { type: 'number', id: 'gpu-first-input', label: tr('gpuFirst'), ...GPU_FIRST_LIMITS,
    value: gpu.firstN, visible: barVisible && gpu.mode === 'first', change(value) {
      changeConfig('statusBar', () => {
        gpu.firstN = value;
      });
    } });
  setting(gpuBody, 'gpu-cards', { type: 'text', id: 'gpu-cards-input', label: tr('gpuSpecify'), hint: '', value: gpu.cards.join(','),
    visible: barVisible && gpu.mode === 'specify', parse(raw) {
      if (!raw.trim()) return [];
      const values = raw.split(',').map((value) => value.trim());
      return values.every((value) => /^\d+$/.test(value)) ? [...new Set(values.map(Number))].sort((a, b) => a - b) : undefined;
    }, change(value) {
      changeConfig('statusBar', () => {
        gpu.cards = value;
      });
    } });
  refreshGpuAvailability();
  selectSetting(gpuBody, 'gpu-metric', tr('gpuMetric'), 'statusBar', gpu.metric,
    [['util', tr('metUtil')], ['vram', tr('metVram')], ['both', tr('metBoth')]], assign(gpu, 'metric'), { visible: perfVisible });
  switchSetting(gpuBody, 'gpu-skip-idle', tr('gpuSkipIdle'), 'statusBar', () => !!gpu.skipIdle, assign(gpu, 'skipIdle'), { visible: perfVisible });
}

function renderStatusBarSettings() {
  const bar = state.config.statusBar;
  const gpu = bar.gpu || {};
  const barBody = document.getElementById('sett-body');
  switchSetting(barBody, 'bar-toggle', tr('barToggle'), 'statusBar', () => bar.barEnabled !== false, assign(bar, 'barEnabled'));
  const barVisible = bar.barEnabled !== false;
  const body = settingGroup(barBody, 'bar-options', { visible: barVisible });
  setting(body, 'bar-align', { type: 'segment', label: tr('barAlign'), visible: barVisible, value: bar.alignment || 'left',
    options: [['left', tr('left')], ['right', tr('right')]], change(value) {
      changeConfig('statusBar', () => {
        bar.alignment = value;
      });
    } });
  setting(body, 'bar-priority', { type: 'number', id: 'bar-priority-input', label: tr('barPriority'), hint: tr('barPriorityTip'),
    visible: barVisible, value: bar.priority, minimum: 0, integer: false, change(value) {
      changeConfig('statusBar', () => {
        bar.priority = value;
      });
    } });
  for (const [key, label] of [['cpu', 'CPU'], ['ram', 'RAM'], ['disk', tr('diskUsage')]]) {
    switchSetting(body, 'bar-' + key, label, 'statusBar', () => !!bar[key], assign(bar, key), { visible: barVisible });
  }
  selectSetting(body, 'diskIO', tr('diskIO'), 'statusBar', bar.diskIO,
    [['off', tr('scopeOff')], ['read', tr('diskIORead')], ['write', tr('diskIOWrite')], ['both', tr('netAll')], ['combined', tr('netMerge')]], assign(bar, 'diskIO'), { visible: barVisible });
  selectSetting(body, 'net', tr('netLabel'), 'statusBar', bar.net,
    [['off', tr('scopeOff')], ['up', tr('netUp')], ['down', tr('netDown')], ['both', tr('netAll')], ['combined', tr('netMerge')]], assign(bar, 'net'), { visible: barVisible });
  switchSetting(body, 'bar-ssh', tr('sshLabel'), 'statusBar', () => !!bar.ssh, assign(bar, 'ssh'), { visible: barVisible });
  renderStatusBarGpuSettings(body, gpu, barVisible);
}

function renderDiskSettings() {
  const disk = state.config.disk;
  const filter = disk.mountFilter;
  const custom = filter === 'custom';
  const values = custom ? disk : state.initial.diskPresets[filter];
  const diskBody = document.getElementById('sett-disk-body');
  selectSetting(diskBody, 'disk-filter', tr('diskFilter'), 'disk', filter,
    [['default', tr('diskDefault')], ['more', tr('diskMore')], ['all', tr('diskAll')], ['custom', tr('diskCustom')]], (value) => {
      if (value === 'custom' && !custom && disk.customFsExclude === undefined && disk.customPathExclude === undefined) Object.assign(disk, values);
      disk.mountFilter = value;
    });
  const rulesBody = settingGroup(diskBody, 'disk-rules', { disabled: !custom });
  rulesBody.classList.add('custom-group');
  switchSetting(rulesBody, 'disk-hide-virtual', tr('diskHideVirtual'), 'disk', () => values.hideVirtualFs, assign(disk, 'hideVirtualFs'), { hint: tr('diskHideVirtualTip'), disabled: !custom });
  for (const [id, label, hint, key] of [
    ['disk-fs-input', tr('diskExcludeFs'), tr('diskExcludeFsTip'), 'customFsExclude'],
    ['disk-path-input', tr('diskExcludePath'), tr('diskExcludePathTip'), 'customPathExclude'],
  ]) {
    setting(rulesBody, id, { type: 'textarea', id, label, hint, value: values[key] || '', readonly: !custom, change(value) {
      changeConfig('disk', () => {
        disk[key] = value;
      });
    } });
  }
  switchSetting(diskBody, 'disk-hide-parent', tr('diskHideParent'), 'disk', () => disk.hideParentMounts !== false, assign(disk, 'hideParentMounts'), { hint: tr('diskHideParentTip') });
}

function renderDisplaySettings() {
  const display = state.config.display;
  const displayBody = document.getElementById('sett-display-body');
  switchSetting(displayBody, 'charts-toggle', tr('chartsToggle'), 'display', () => display.charts !== false, assign(display, 'charts'), { effect: applyCharts });
  const minutes = chartMinutes();
  const durations = [...new Set([...CHART_MINUTE_PRESETS, minutes])].sort((a, b) => a - b);
  selectSetting(displayBody, 'spark-min', tr('sparkLabel'), 'display', String(minutes), durations.map((value) => [String(value), tr('minutes', { count: value })]), (value) => {
    display.sparkMinutes = Number(value);
    updateChartWindow();
  });
  switchSetting(displayBody, 'tabular-toggle', tr('tabularNums'), 'display', () => display.tabularNums !== false, assign(display, 'tabularNums'), { hint: tr('tabularNumsTip'), effect: applyTabularNums });
  const groupLabels = { cpu: 'CPU', memory: 'RAM', disk: tr('diskLabel'), network: tr('networkGroup'), gpuSummary: tr('gpuSummaryGroup'), gpuCards: tr('gpuCardsGroup') };
  for (const [key, label] of Object.entries(groupLabels)) {
    switchSetting(displayBody, 'group-' + key, label, 'display', () => !(display.hiddenGroups || {})[key], (value) => {
      display.hiddenGroups = { ...display.hiddenGroups, [key]: !value };
    }, { effect: applyGroupVisibility });
  }
  for (const [key, label] of [['highlightMyGpus', tr('myGpuBorder')], ['showGpuPicker', tr('gpuPicker')], ['showGpuUsers', tr('gpuUsers')]]) {
    switchSetting(displayBody, key, label, 'display', () => display[key] !== false, assign(display, key), { effect: applyGroupVisibility });
  }
}

function renderActionSettings() {
  const servers = state.config.servers;
  const actions = servers.actions || {};
  const actionsBody = document.getElementById('sett-actions-body');
  const refreshServerList = () => {
    if (state.environment.localMode) renderServers();
  };
  for (const [key, label] of [['editor', tr('actionEditorView')], ['window', tr('actionNewWindow')], ['terminal', tr('openSSHTerminal')], ['remoteWindow', tr('openRemoteWindow')]]) {
    switchSetting(actionsBody, 'action-' + key, label, 'servers', () => actions[key] !== false, (value) => {
      servers.actions = { ...servers.actions, [key]: value };
    }, { effect: refreshServerList });
  }
  const remoteBody = settingGroup(actionsBody, 'remote-window-options', { visible: actions.remoteWindow !== false });
  selectSetting(remoteBody, 'remote-window-mode', tr('remoteWindowBehavior'), 'servers', servers.remoteWindowMode || 'menu',
    [['new', tr('newWorkspace')], ['recent', tr('recentWorkspace')], ['menu', tr('chooseFromMenu')]], (value) => {
      servers.remoteWindowMode = value;
      closeRemoteMenu();
      refreshServerList();
    }, { visible: actions.remoteWindow !== false });
}

function renderServerSettings() {
  const servers = state.config.servers;
  const serversBody = document.getElementById('sett-servers-body');
  switchSetting(serversBody, 'servers-visible', tr('serversVisibleOnly'), 'servers', () => servers.visibleOnly === true, assign(servers, 'visibleOnly'), { hint: tr('serversVisibleOnlyHint') });
  switchSetting(serversBody, 'servers-restore', tr('serversRestoreTabs'), 'servers', () => servers.restoreTabs !== false, assign(servers, 'restoreTabs'));
  const sshDefault = sshDefaultStatus();
  setting(serversBody, 'ssh-default-add', { type: 'action', label: tr('sshDefaultInstall'), hint: tr('sshDefaultInstallHint'),
    caption: sshDefault.installed ? tr('added') : sshDefault.pending ? tr('adding') : tr('addToDefaults'),
    active: !sshDefault.installed, disabled: sshDefault.installed || sshDefault.pending, change() {
      addSshDefaultExtension(false);
      renderSettings();
    } });
  const error = document.getElementById('ssh-default-error');
  error.textContent = sshDefault.error;
  error.hidden = !sshDefault.error;
}

function markLastSettings() {
  const parents = SECTION_BODY_IDS.map((id) => document.getElementById(id));
  for (const parent of [...parents, ...settingGroups.values()]) {
    const visible = [...parent.children].filter((row) => !row.hidden);
    visible.forEach((row, index) => row.classList.toggle('last-setting', index === visible.length - 1));
  }
}

function renderSettings() {
  renderIntervalRow();
  renderCollectionSettings();
  renderStatusBarSettings();
  renderDiskSettings();
  renderDisplaySettings();
  renderActionSettings();
  renderServerSettings();
  if (settingsOpen) requestAnimationFrame(updateModalScrollbar);
  markLastSettings();
}

export function refreshSettings() {
  if (settingsOpen) renderSettings();
}

export function refreshGpuAvailability() {
  const row = rows.get('gpu-cards');
  if (!row) return;
  const missing = state.data.viewModel ? state.config.statusBar.gpu.cards.filter((index) => !currentGpus().some((gpu) => gpu.idx === index)) : [];
  row.hint.textContent = missing.length ? tr('cardNotFound', { cards: missing.join(',') }) : '';
  row.hint.hidden = !missing.length;
}

export function showConfigSaveState(saveState = { status: 'saved', error: null }) {
  const error = document.getElementById('config-save-error');
  error.hidden = saveState.status !== 'error';
  error.title = saveState.error || '';
  if (settingsOpen) requestAnimationFrame(updateModalScrollbar);
}

function openModal() {
  settingsOpen = true;
  document.getElementById('modal-mask').classList.add('open');
  renderSettings();
}

function closeModal() {
  flushSettingsInputs();
  closeSettingMenu();
  settingsOpen = false;
  modalScrollbar.hidden = true;
  helpTooltip.hide();
  document.getElementById('modal-mask').classList.remove('open');
}

export function initializeSettings() {
  modalBody = document.getElementById('modal-body');
  modalScrollbar = document.getElementById('modal-scrollbar');
  modalScrollbarThumb = document.getElementById('modal-scrollbar-thumb');
  helpTooltip = createTooltip('settings-tooltip', { align: 'start', side: 'below', gap: 6, fit: 'shift' });
  bindHelp(document.getElementById('collection-info'), () => tr('collectionInfo'));
  bindHelp(document.getElementById('sett-bar-info'), () => tr('statusBarScopeInfo'));
  document.getElementById('collection-reset').addEventListener('click', () => {
    changeConfig('collection', () => {
      for (const field of state.initial.collectionFields) state.config.collection[field.key] = field.default;
    });
    renderSettings();
  });
  document.getElementById('collection-toggle').addEventListener('click', () => {
    changeConfig('collection', () => {
      state.config.collection.custom = !state.config.collection.custom;
    });
    renderSettings();
  });
  document.getElementById('config-save-retry').addEventListener('click', () => sendToExtension(TO_EXTENSION.retryConfigSave));
  showConfigSaveState(state.initial.saveState);
  document.getElementById('settings-btn').addEventListener('click', openModal);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('open-vsc-settings').addEventListener('click', () => sendToExtension(TO_EXTENSION.openSettings));
  modalScrollbar.addEventListener('pointerdown', startModalScrollbarDrag);
  modalScrollbar.addEventListener('pointermove', (event) => {
    if (modalDragOffset !== null) scrollModalFromPointer(event);
  });
  modalScrollbar.addEventListener('pointerup', endModalScrollbarDrag);
  modalScrollbar.addEventListener('pointercancel', endModalScrollbarDrag);
  modalBody.addEventListener('scroll', () => {
    helpTooltip.hide();
    updateModalScrollbar();
  });
  window.addEventListener('resize', () => {
    helpTooltip.hide();
    document.querySelectorAll('#disk-fs-input, #disk-path-input').forEach(resizeTextarea);
    updateModalScrollbar();
  });
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (!link) return;
    event.preventDefault();
    sendToExtension(TO_EXTENSION.openLink, { url: link.href });
  });
}
