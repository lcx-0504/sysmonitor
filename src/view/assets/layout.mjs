import { state } from './state.mjs';
import { element } from './ui.mjs';
import { closeMenu, isMenuOpen, menuContent, openMenu } from './popover.mjs';

const TOPBAR_MENU = 'topbar';
const SCROLL_THUMB_MIN_PX = 24;
const SCROLL_OVERFLOW_TOLERANCE_PX = 1;

let topbarHiddenItems = [];
let topbarLayoutPending = false;
let topbar, topbarMoreButton, tabScrollViewport, tabScrollTrack, tabScrollThumb;
let tabScrollDragOffset = null;

function updateResponsiveLayout() {
  updateTopbarLayout();
  const page = document.getElementById('tab-perf');
  if (!page.classList.contains('active')) return;
  const style = getComputedStyle(page);
  const width = page.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const minimum = parseFloat(style.getPropertyValue('--card-min-width'));
  const gap = parseFloat(style.getPropertyValue('--card-gap'));
  page.classList.toggle('compact-cards', width < minimum * 2 + gap);
}

function chooseTopbarStage(available, widths) {
  const stage = widths.findIndex((width) => width <= available);
  return stage < 0 ? widths.length - 1 : stage;
}

function updateTopbarLayout() {
  if (topbarLayoutPending) return;
  topbarLayoutPending = true;
  requestAnimationFrame(() => {
    topbarLayoutPending = false;
    measureTopbarLayout();
  });
}

function topbarStages(serverMode, { updated, pause, settings, refresh }) {
  if (serverMode) return [[refresh, settings], [topbarMoreButton, refresh], [topbarMoreButton]];
  return [[updated, pause, settings], [topbarMoreButton, pause, settings], [topbarMoreButton, pause], [topbarMoreButton]];
}

function measureStageWidths(stages) {
  const measure = element('div', 'topbar-right topbar-measure');
  measure.setAttribute('aria-hidden', 'true');
  document.body.append(measure);
  const widths = stages.map((stage) => {
    measure.replaceChildren(...stage.map((item) => {
      const clone = item.cloneNode(true);
      clone.removeAttribute('id');
      clone.hidden = false;
      return clone;
    }));
    return measure.getBoundingClientRect().width;
  });
  measure.remove();
  return widths;
}

function measureTopbarLayout() {
  if (!topbar) return;
  const left =topbar.querySelector('.topbar-left');
  const right = topbar.querySelector('.topbar-right');
  const controls = {
    updated: document.getElementById('updated'),
    pause: document.getElementById('pause-btn'),
    settings: document.getElementById('settings-btn'),
    refresh: document.getElementById('topbar-server-refresh'),
  };
  const serverMode = state.environment.localMode ? state.ui.navigation?.page === 'servers' : state.ui.page === 'servers';
  const items = serverMode ? [controls.refresh, controls.settings] : [controls.updated, controls.pause, controls.settings];
  const stages = topbarStages(serverMode, controls);
  const widths = measureStageWidths(stages);
  const style = getComputedStyle(topbar);
  const available = topbar.getBoundingClientRect().width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth)
    - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - left.getBoundingClientRect().width - parseFloat(style.columnGap);
  const stage = chooseTopbarStage(available, widths);
  topbar.classList.toggle('wrap-groups', widths[stage] > available);
  for (const item of [...Object.values(controls), topbarMoreButton]) item.hidden = !stages[stage].includes(item);
  const hiddenItems = items.filter((item) => item.hidden);
  const changed = topbarHiddenItems.map((item) => item.id).join(',') !== hiddenItems.map((item) => item.id).join(',');
  topbarHiddenItems = hiddenItems;
  right.dataset.collapse = String(stage);
  if (changed) closeMenu(TOPBAR_MENU);
  menuContent(TOPBAR_MENU)?.querySelectorAll('[data-source]').forEach((item) => {
    item.textContent = document.getElementById(item.dataset.source).textContent;
  });
}

function topbarMenuItem(original) {
  if (original.id === 'updated') {
    const info = element('div', 'action-menu-info', original.textContent);
    info.dataset.source = original.id;
    return info;
  }
  const item = element('button', 'popup-menu-item action-menu-item', original.textContent);
  item.type = 'button';
  item.dataset.source = original.id;
  item.setAttribute('role', 'menuitem');
  item.addEventListener('click', () => {
    closeMenu(TOPBAR_MENU);
    original.click();
  });
  return item;
}

function toggleTopbarMenu() {
  if (isMenuOpen(TOPBAR_MENU)) {
    closeMenu(TOPBAR_MENU);
    return;
  }
  const menu = element('div', 'popup-menu action-menu');
  menu.setAttribute('role', 'menu');
  menu.append(...topbarHiddenItems.map(topbarMenuItem));
  openMenu({ owner: TOPBAR_MENU, trigger: topbarMoreButton, content: menu, placement: { align: 'end', side: 'below', gap: 3 }, focusFirst: true });
}

function updateDeviceScrollbar() {
  const width = tabScrollViewport.clientWidth;
  const overflow = tabScrollViewport.scrollWidth - width;
  tabScrollTrack.hidden = !width || overflow <= SCROLL_OVERFLOW_TOLERANCE_PX;
  if (tabScrollTrack.hidden) return;
  const thumbWidth = Math.min(width, Math.max(SCROLL_THUMB_MIN_PX, width * width / tabScrollViewport.scrollWidth));
  tabScrollThumb.style.width = thumbWidth + 'px';
  tabScrollThumb.style.transform = 'translateX(' + (width - thumbWidth) * tabScrollViewport.scrollLeft / overflow + 'px)';
}

function scrollDeviceTabsFromPointer(event) {
  const bounds = tabScrollTrack.getBoundingClientRect();
  const travel = bounds.width - tabScrollThumb.offsetWidth;
  if (travel <= 0) return;
  const progress = Math.max(0, Math.min(1, (event.clientX - bounds.left - tabScrollDragOffset) / travel));
  tabScrollViewport.scrollLeft = progress * (tabScrollViewport.scrollWidth - tabScrollViewport.clientWidth);
  updateDeviceScrollbar();
}

function startDeviceScrollbarDrag(event) {
  if (event.button !== 0 || tabScrollTrack.hidden) return;
  event.preventDefault();
  const thumbBounds = tabScrollThumb.getBoundingClientRect();
  tabScrollDragOffset = event.target === tabScrollThumb ? event.clientX - thumbBounds.left : thumbBounds.width / 2;
  tabScrollTrack.classList.add('dragging');
  tabScrollTrack.setPointerCapture(event.pointerId);
  scrollDeviceTabsFromPointer(event);
}

function endDeviceScrollbarDrag(event) {
  tabScrollDragOffset = null;
  tabScrollTrack.classList.remove('dragging');
  if (tabScrollTrack.hasPointerCapture(event.pointerId)) tabScrollTrack.releasePointerCapture(event.pointerId);
}

export function initializeLayout() {
  topbar = document.querySelector('.topbar');
  topbarMoreButton = document.getElementById('topbar-more');
  topbarMoreButton.addEventListener('click', toggleTopbarMenu);
  const layoutObserver = new ResizeObserver(updateResponsiveLayout);
  layoutObserver.observe(document.body);
  layoutObserver.observe(document.getElementById('system-row'));
  document.querySelectorAll('.tab-content').forEach((page) => layoutObserver.observe(page));
  layoutObserver.observe(topbar);
  document.fonts?.ready.then(updateTopbarLayout);
  tabScrollViewport = document.getElementById('device-strip');
  tabScrollTrack = document.getElementById('device-scrollbar');
  tabScrollThumb = document.getElementById('device-scrollbar-thumb');
  tabScrollTrack.addEventListener('pointerdown', startDeviceScrollbarDrag);
  tabScrollTrack.addEventListener('pointermove', (event) => {
    if (tabScrollDragOffset !== null) scrollDeviceTabsFromPointer(event);
  });
  tabScrollTrack.addEventListener('pointerup', endDeviceScrollbarDrag);
  tabScrollTrack.addEventListener('pointercancel', endDeviceScrollbarDrag);
  tabScrollViewport.addEventListener('scroll', updateDeviceScrollbar);
  new ResizeObserver(updateDeviceScrollbar).observe(tabScrollViewport);
}

export { updateResponsiveLayout, chooseTopbarStage, updateTopbarLayout, updateDeviceScrollbar };
