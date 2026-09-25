  function updateResponsiveLayout() {
    var page = document.querySelector('.tab-content.active');
    if (!page || !page.clientWidth) return;
    var cpuCard = document.getElementById('cpu-card');
    var memoryCard = document.getElementById('mem-card');
    var cpuBounds = cpuCard.getBoundingClientRect();
    var memoryBounds = memoryCard.getBoundingClientRect();
    var compact;
    if (cpuBounds.width && memoryBounds.width) {
      compact = cpuBounds.top !== memoryBounds.top;
    } else {
      var row = document.getElementById('system-row');
      var contentStyle = getComputedStyle(document.getElementById('tab-perf'));
      var viewportWidth = page.getBoundingClientRect().width - (page.offsetWidth - page.clientWidth);
      var available = row.getBoundingClientRect().width || viewportWidth - parseFloat(contentStyle.paddingLeft) - parseFloat(contentStyle.paddingRight);
      var required = parseFloat(getComputedStyle(cpuCard).flexBasis) * 2 + parseFloat(getComputedStyle(row).columnGap);
      compact = available < required;
    }
    document.body.classList.toggle('compact-layout', compact);
  }
  var monitorLayoutObserver = new ResizeObserver(updateResponsiveLayout);
  monitorLayoutObserver.observe(document.body);
  monitorLayoutObserver.observe(document.getElementById('system-row'));
  document.querySelectorAll('.tab-content').forEach(function(page) { monitorLayoutObserver.observe(page); });

  var tabScrollViewport = document.getElementById('device-strip');
  var tabScrollTrack = document.getElementById('device-scrollbar');
  var tabScrollThumb = document.getElementById('device-scrollbar-thumb');
  var tabScrollDragOffset = null;

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
  function endDeviceScrollbarDrag(event) {
    tabScrollDragOffset = null;
    tabScrollTrack.classList.remove('dragging');
    if (tabScrollTrack.hasPointerCapture(event.pointerId)) tabScrollTrack.releasePointerCapture(event.pointerId);
  }
  tabScrollTrack.addEventListener('pointerup', endDeviceScrollbarDrag);
  tabScrollTrack.addEventListener('pointercancel', endDeviceScrollbarDrag);
  tabScrollViewport.addEventListener('scroll', updateDeviceScrollbar);
  var deviceScrollbarObserver = new ResizeObserver(updateDeviceScrollbar);
  deviceScrollbarObserver.observe(tabScrollViewport);
