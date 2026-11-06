import { state } from "./state.mjs";

let topbarMenu, topbarHiddenItems, topbarMoreButton, monitorLayoutObserver, tabScrollViewport, tabScrollTrack, tabScrollThumb, tabScrollDragOffset, deviceScrollbarObserver;
let topbarLayoutPending = false;

function updateResponsiveLayout() {
    updateTopbarLayout();
    const page = document.getElementById('tab-perf');
    if (page.classList.contains('active')) {
      const style = getComputedStyle(page);
      const width = page.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const minimum = parseFloat(style.getPropertyValue('--card-min-width'));
      const gap = parseFloat(style.getPropertyValue('--card-gap'));
      page.classList.toggle('compact-cards', width < minimum * 2 + gap);
    }
  }

function closeTopbarMenu() {
    if (topbarMenu) topbarMenu.remove();
    topbarMenu = null;
    topbarMoreButton.setAttribute('aria-expanded', 'false');
  }

function chooseTopbarStage(available, widths) {
    var stage = widths.findIndex(function(width) { return width <= available; });
    return stage < 0 ? widths.length - 1 : stage;
  }

function updateTopbarLayout() {
    if (topbarLayoutPending) return;
    topbarLayoutPending = true;
    requestAnimationFrame(() => { topbarLayoutPending = false; measureTopbarLayout(); });
  }

function measureTopbarLayout() {
    if (!topbarMoreButton) return;
    var bar = document.querySelector('.topbar');
    var left = bar.querySelector('.topbar-left');
    var right = bar.querySelector('.topbar-right');
    var updated = document.getElementById('updated');
    var pause = document.getElementById('pause-btn');
    var settings = document.getElementById('settings-btn');
    var refresh = document.getElementById('topbar-server-refresh');
    var serverMode = state.environment.localMode
      ? state.ui.navigation?.page === 'servers'
      : document.getElementById('tab-servers').classList.contains('active');
    var items = serverMode ? [refresh, settings] : [updated, pause, settings];
    var stages = serverMode ? [[refresh, settings], [topbarMoreButton, refresh], [topbarMoreButton]]
      : [[updated, pause, settings], [topbarMoreButton, pause, settings], [topbarMoreButton, pause], [topbarMoreButton]];
    var measure = document.createElement('div');
    measure.className = 'topbar-right topbar-measure';
    measure.setAttribute('aria-hidden', 'true');
    document.body.appendChild(measure);
    var widths = stages.map(function(stage) {
      measure.replaceChildren();
      stage.forEach(function(item) { var clone = item.cloneNode(true); clone.removeAttribute('id'); clone.hidden = false; measure.appendChild(clone); });
      return measure.getBoundingClientRect().width;
    });
    measure.remove();
    var style = getComputedStyle(bar);
    var available = bar.getBoundingClientRect().width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth)
      - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - left.getBoundingClientRect().width - parseFloat(style.columnGap);
    var stage = chooseTopbarStage(available, widths);
    bar.classList.toggle('wrap-groups', widths[stage] > available);
    [updated, pause, settings, refresh, topbarMoreButton].forEach(function(item) { item.hidden = stages[stage].indexOf(item) < 0; });
    var nextHiddenItems = items.filter(function(item) { return item.hidden; });
    var changed = topbarHiddenItems.map(function(item) { return item.id; }).join(',') !== nextHiddenItems.map(function(item) { return item.id; }).join(',');
    topbarHiddenItems = nextHiddenItems;
    right.dataset.collapse = String(stage);
    if (topbarMenu && changed) closeTopbarMenu();
    if (topbarMenu) topbarMenu.querySelectorAll('[data-source]').forEach(function(item) { item.textContent = document.getElementById(item.dataset.source).textContent; });
  }

function updateDeviceScrollbar() {
    var width = tabScrollViewport.clientWidth;
    var overflow = tabScrollViewport.scrollWidth - width;
    tabScrollTrack.hidden = !width || overflow <= 1;
    if (tabScrollTrack.hidden) return;
    var thumbWidth = Math.min(width, Math.max(24, width * width / tabScrollViewport.scrollWidth));
    tabScrollThumb.style.width = thumbWidth + 'px';
    tabScrollThumb.style.transform = 'translateX(' + (width - thumbWidth) * tabScrollViewport.scrollLeft / overflow + 'px)';
  }

function scrollDeviceTabsFromPointer(event) {
    var bounds = tabScrollTrack.getBoundingClientRect();
    var travel = bounds.width - tabScrollThumb.offsetWidth;
    if (travel <= 0) return;
    var progress = Math.max(0, Math.min(1, (event.clientX - bounds.left - tabScrollDragOffset) / travel));
    tabScrollViewport.scrollLeft = progress * (tabScrollViewport.scrollWidth - tabScrollViewport.clientWidth);
    updateDeviceScrollbar();
  }

function endDeviceScrollbarDrag(event) {
    tabScrollDragOffset = null;
    tabScrollTrack.classList.remove('dragging');
    if (tabScrollTrack.hasPointerCapture(event.pointerId)) tabScrollTrack.releasePointerCapture(event.pointerId);
  }

export function initializeLayout() {
  topbarLayoutPending = false;
  topbarMenu = null;
  topbarHiddenItems = [];
  topbarMoreButton = document.getElementById('topbar-more');
  topbarMoreButton.addEventListener('click', function(event) {
      event.stopPropagation();
      if (topbarMenu) { closeTopbarMenu(); return; }
      topbarMenu = document.createElement('div');
      topbarMenu.className = 'server-folder-menu';
      topbarMenu.setAttribute('role', 'menu');
      topbarHiddenItems.forEach(function(original) {
        var item = document.createElement(original.id === 'updated' ? 'div' : 'button');
        item.className = original.id === 'updated' ? 'topbar-menu-info' : 'server-folder-item';
        item.textContent = original.textContent;
        item.dataset.source = original.id;
        if (original.id !== 'updated') {
          item.type = 'button'; item.setAttribute('role', 'menuitem');
          item.addEventListener('click', function() { closeTopbarMenu(); original.click(); });
        }
        topbarMenu.appendChild(item);
      });
      document.body.appendChild(topbarMenu);
      var bounds = topbarMoreButton.getBoundingClientRect();
      topbarMenu.style.left = Math.max(4, Math.min(bounds.right - topbarMenu.offsetWidth, window.innerWidth - topbarMenu.offsetWidth - 4)) + 'px';
      topbarMenu.style.top = (bounds.bottom + topbarMenu.offsetHeight < window.innerHeight ? bounds.bottom + 3 : Math.max(4, bounds.top - topbarMenu.offsetHeight - 3)) + 'px';
      topbarMoreButton.setAttribute('aria-expanded', 'true');
      var first = topbarMenu.querySelector('button');
      if (first) first.focus();
    });
  document.addEventListener('click', function(event) { if (topbarMenu && !topbarMenu.contains(event.target)) closeTopbarMenu(); });
  document.addEventListener('keydown', function(event) { if (event.key === 'Escape' && topbarMenu) { closeTopbarMenu(); topbarMoreButton.focus(); } });
  monitorLayoutObserver = new ResizeObserver(updateResponsiveLayout);
  monitorLayoutObserver.observe(document.body);
  monitorLayoutObserver.observe(document.getElementById('system-row'));
  document.querySelectorAll('.tab-content').forEach(function(page) { monitorLayoutObserver.observe(page); });
  monitorLayoutObserver.observe(document.querySelector('.topbar'));
  if (document.fonts) document.fonts.ready.then(updateTopbarLayout);
  tabScrollViewport = document.getElementById('device-strip');
  tabScrollTrack = document.getElementById('device-scrollbar');
  tabScrollThumb = document.getElementById('device-scrollbar-thumb');
  tabScrollDragOffset = null;
  tabScrollTrack.addEventListener('pointerdown', function(event) {
      if (event.button !== 0 || tabScrollTrack.hidden) return;
      event.preventDefault();
      var thumbBounds = tabScrollThumb.getBoundingClientRect();
      tabScrollDragOffset = event.target === tabScrollThumb ? event.clientX - thumbBounds.left : thumbBounds.width / 2;
      tabScrollTrack.classList.add('dragging');
      tabScrollTrack.setPointerCapture(event.pointerId);
      scrollDeviceTabsFromPointer(event);
    });
  tabScrollTrack.addEventListener('pointermove', function(event) {
      if (tabScrollDragOffset !== null) scrollDeviceTabsFromPointer(event);
    });
  tabScrollTrack.addEventListener('pointerup', endDeviceScrollbarDrag);
  tabScrollTrack.addEventListener('pointercancel', endDeviceScrollbarDrag);
  tabScrollViewport.addEventListener('scroll', updateDeviceScrollbar);
  deviceScrollbarObserver = new ResizeObserver(updateDeviceScrollbar);
  deviceScrollbarObserver.observe(tabScrollViewport);
}

export { updateResponsiveLayout, chooseTopbarStage, updateTopbarLayout, updateDeviceScrollbar };
