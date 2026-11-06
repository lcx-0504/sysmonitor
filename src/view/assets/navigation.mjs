import { state } from './state.mjs';
import { element, sendToExtension, storedViewState, storeViewState, tr } from './ui.mjs';
import { TO_EXTENSION } from './protocol.mjs';
import { deviceHost, isLocalDeviceId } from './device-id.mjs';
import { updateDeviceScrollbar, updateTopbarLayout } from './layout.mjs';

// A pointer press becomes a tab drag after moving this far.
const TAB_DRAG_THRESHOLD_PX = 6;
// A dragged tab must pass a neighbour's center by this much before the two swap places.
const TAB_REORDER_HYSTERESIS_PX = 2;
// Dragged tabs stay this far inside the strip edges.
const TAB_STRIP_INSET_PX = 1;

let pointerDrag = null;
let suppressDeviceClick = false;
let requestedPage = null;
let deviceStrip, topbar;

function storeNavigation() {
  if (state.environment.localMode) storeViewState({ navigation: state.ui.navigation });
}

function isActiveTab(id) {
  return state.ui.navigation.selected === id && state.ui.navigation.page !== 'servers';
}

function clearTabDrag() {
  const drag = pointerDrag;
  pointerDrag = null;
  if (!drag) return;
  for (const slot of drag.slots) {
    slot.tab.classList.remove('dragging');
    slot.tab.style.transform = '';
  }
}

function slotShift(drag, index) {
  if (drag.targetIndex > drag.originIndex && index > drag.originIndex && index <= drag.targetIndex) return -drag.origin.width;
  if (drag.targetIndex < drag.originIndex && index >= drag.targetIndex && index < drag.originIndex) return drag.origin.width;
  return 0;
}

function moveTabWithinStrip(event) {
  const drag = pointerDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < TAB_DRAG_THRESHOLD_PX) return;
  drag.active = true;
  event.preventDefault();
  const bounds = deviceStrip.getBoundingClientRect();
  const minOffset = Math.min(0, bounds.left + TAB_STRIP_INSET_PX - drag.origin.left);
  const maxOffset = Math.max(0, bounds.right - TAB_STRIP_INSET_PX - drag.origin.right);
  const offset = Math.max(minOffset, Math.min(event.clientX - drag.startX, maxOffset));
  drag.tab.classList.add('dragging');
  drag.tab.style.transform = 'translateX(' + offset + 'px)';
  const center = drag.origin.left + drag.origin.width / 2 + offset;
  drag.targetIndex = drag.slots.filter((slot, index) => slot.tab !== drag.tab
    && slot.center < center + (index > drag.originIndex ? TAB_REORDER_HYSTERESIS_PX : -TAB_REORDER_HYSTERESIS_PX)).length;
  drag.slots.forEach((slot, index) => {
    if (slot.tab === drag.tab) return;
    const shift = slotShift(drag, index);
    slot.tab.style.transform = shift ? 'translateX(' + shift + 'px)' : '';
  });
}

function reorderDeviceTab(draggedId, targetIndex) {
  const reordered = state.ui.navigation.tabs.filter((value) => value !== draggedId);
  reordered.splice(targetIndex, 0, draggedId);
  state.ui.navigation = { ...state.ui.navigation, tabs: reordered };
  renderDeviceTabs();
  storeNavigation();
  sendToExtension(TO_EXTENSION.reorderDevices, { tabs: reordered });
}

function updateDeviceTabsPresentation() {
  const hasTabs = state.ui.navigation.tabs.length > 0;
  deviceStrip.hidden = state.environment.editorMode || !hasTabs || state.ui.navigation.page === 'servers';
  document.getElementById('device-strip-wrap').hidden = deviceStrip.hidden;
  topbar.hidden = false;
  document.getElementById('tab-perf-btn').hidden = !hasTabs;
  document.getElementById('tab-proc-btn').hidden = !hasTabs;
  document.getElementById('tab-servers-btn').hidden = state.environment.editorMode;
  deviceStrip.querySelectorAll('.device-tab').forEach((tab) => {
    const active = isActiveTab(tab.dataset.deviceId);
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  updateTopbarLayout();
  updateDeviceScrollbar();
}

function startTabDrag(tab, id, event) {
  if (event.button !== 0 || event.target.closest('.device-tab-close')) return;
  const tabs = Array.from(deviceStrip.querySelectorAll('.device-tab'));
  if (tabs.length < 2) return;
  const originIndex = tabs.indexOf(tab);
  pointerDrag = { id, tab, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false,
    origin: tab.getBoundingClientRect(), originIndex, targetIndex: originIndex,
    slots: tabs.map((item) => {
      const rect = item.getBoundingClientRect();
      return { tab: item, center: rect.left + rect.width / 2 };
    }) };
  tab.setPointerCapture(event.pointerId);
}

function finishTabDrag(tab, id, event) {
  if (pointerDrag?.id !== id || pointerDrag.pointerId !== event.pointerId) return;
  if (pointerDrag.active) moveTabWithinStrip(event);
  const drag = pointerDrag;
  const shouldReorder = drag.active && drag.targetIndex !== drag.originIndex;
  if (tab.hasPointerCapture(event.pointerId)) tab.releasePointerCapture(event.pointerId);
  clearTabDrag();
  if (!drag.active) return;
  suppressDeviceClick = true;
  setTimeout(() => {
    suppressDeviceClick = false;
  });
  if (shouldReorder) reorderDeviceTab(id, drag.targetIndex);
}

function createDeviceTab(id) {
  const active = isActiveTab(id);
  const tab = element('div', 'device-tab' + (active ? ' active' : ''));
  tab.tabIndex = 0;
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', active ? 'true' : 'false');
  const name = element('span', '', isLocalDeviceId(id) ? tr('localDevice') : deviceHost(id));
  tab.append(name);
  tab.title = name.textContent;
  tab.addEventListener('click', (event) => {
    if (suppressDeviceClick) {
      event.preventDefault();
      suppressDeviceClick = false;
      return;
    }
    sendToExtension(TO_EXTENSION.switchDevice, { id });
  });
  tab.addEventListener('keydown', (event) => {
    if (event.target !== tab || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    sendToExtension(TO_EXTENSION.switchDevice, { id });
  });
  tab.addEventListener('auxclick', (event) => {
    if (event.button !== 1 || isLocalDeviceId(id)) return;
    event.preventDefault();
    sendToExtension(TO_EXTENSION.closeDevice, { id });
  });
  tab.addEventListener('pointerdown', (event) => startTabDrag(tab, id, event));
  tab.addEventListener('pointermove', (event) => {
    if (pointerDrag?.id === id && pointerDrag.pointerId === event.pointerId) moveTabWithinStrip(event);
  });
  tab.addEventListener('pointerup', (event) => finishTabDrag(tab, id, event));
  tab.addEventListener('pointercancel', (event) => {
    if (pointerDrag?.pointerId === event.pointerId) clearTabDrag();
  });
  tab.dataset.deviceId = id;
  if (!isLocalDeviceId(id)) {
    const close = element('button', 'device-tab-close', '×');
    close.type = 'button';
    close.title = tr('closeDevice');
    close.setAttribute('aria-label', close.title);
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      sendToExtension(TO_EXTENSION.closeDevice, { id });
    });
    tab.append(close);
  }
  return tab;
}

function renderDeviceTabs() {
  if (!state.environment.localMode) return;
  deviceStrip.replaceChildren();
  if (!state.environment.editorMode) deviceStrip.append(...state.ui.navigation.tabs.map(createDeviceTab));
  updateDeviceTabsPresentation();
}

function editorNavigation(navigation) {
  const selected = state.initial.navigation.selected;
  return { ...navigation, tabs: [selected], selected, page: navigation.page === 'proc' ? 'proc' : 'perf' };
}

// Applies a navigation state from the extension and reports whether the selected device changed.
export function applyNavigation(next) {
  let navigation = state.environment.editorMode ? editorNavigation(next) : next;
  const current = state.ui.navigation;
  const tabsChanged = current.tabs.length !== navigation.tabs.length || current.tabs.some((id, index) => id !== navigation.tabs[index]);
  if (requestedPage && !tabsChanged && current.selected === navigation.selected) {
    if (navigation.page === requestedPage) requestedPage = null;
    else navigation = { ...navigation, page: requestedPage };
  } else requestedPage = null;
  const tabAvailabilityChanged = (current.tabs.length === 0) !== (navigation.tabs.length === 0);
  if (tabAvailabilityChanged) topbar.classList.add('instant-page');
  const deviceChanged = navigation.selected !== state.ui.deviceId;
  state.ui.deviceId = navigation.selected;
  state.ui.navigation = navigation;
  if (tabsChanged || deviceStrip.childElementCount !== navigation.tabs.length) renderDeviceTabs();
  else updateDeviceTabsPresentation();
  storeNavigation();
  if (tabAvailabilityChanged) requestAnimationFrame(() => requestAnimationFrame(() => topbar.classList.remove('instant-page')));
  return { deviceChanged };
}

// Records a page chosen in this view so that a navigation update still in flight does not revert it.
export function requestPage(page) {
  requestedPage = page;
  state.ui.navigation = { ...state.ui.navigation, page };
  updateDeviceTabsPresentation();
  storeNavigation();
}

export function initializeNavigation() {
  const stored = state.environment.localMode ? storedViewState() : null;
  const navigation = stored?.navigation || state.initial.navigation || { tabs: [], selected: null, page: 'servers' };
  state.ui.navigation = state.environment.editorMode ? editorNavigation(navigation) : navigation;
  state.ui.deviceId = state.ui.navigation.selected;
  deviceStrip = document.getElementById('device-strip');
  topbar = document.querySelector('.topbar');
}
