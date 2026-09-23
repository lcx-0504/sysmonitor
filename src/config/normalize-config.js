'use strict';

const { DEFAULT_CONFIG } = require('./default-config');

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isBoolean = (value) => typeof value === 'boolean';
const numberInRange = (value, fallback, minimum, maximum) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
};
const enumValue = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;

function normalizeGpuConfig(rawValue) {
  const rawGpu = isObject(rawValue) ? rawValue : {};
  const cards = Array.isArray(rawGpu.cards)
    ? [...new Set(rawGpu.cards.filter((value) => Number.isInteger(value) && value >= 0))].sort((left, right) => left - right)
    : [...DEFAULT_CONFIG.statusBar.gpu.cards];

  return {
    ...rawGpu,
    summary: isBoolean(rawGpu.summary) ? rawGpu.summary : DEFAULT_CONFIG.statusBar.gpu.summary,
    showIdleIds: isBoolean(rawGpu.showIdleIds) ? rawGpu.showIdleIds : DEFAULT_CONFIG.statusBar.gpu.showIdleIds,
    mode: enumValue(rawGpu.mode, ['off', 'all', 'first', 'specify', 'my'], DEFAULT_CONFIG.statusBar.gpu.mode),
    cards,
    firstN: Math.round(numberInRange(rawGpu.firstN, DEFAULT_CONFIG.statusBar.gpu.firstN, 1, 1024)),
    metric: enumValue(rawGpu.metric, ['util', 'vram', 'both'], DEFAULT_CONFIG.statusBar.gpu.metric),
    skipIdle: isBoolean(rawGpu.skipIdle) ? rawGpu.skipIdle : DEFAULT_CONFIG.statusBar.gpu.skipIdle,
  };
}

function normalizeStatusBarConfig(rawValue) {
  const rawStatusBar = isObject(rawValue) ? rawValue : {};
  return {
    ...rawStatusBar,
    barEnabled: isBoolean(rawStatusBar.barEnabled) ? rawStatusBar.barEnabled : DEFAULT_CONFIG.statusBar.barEnabled,
    alignment: enumValue(rawStatusBar.alignment, ['left', 'right'], DEFAULT_CONFIG.statusBar.alignment),
    priority: numberInRange(rawStatusBar.priority, DEFAULT_CONFIG.statusBar.priority, 0, Number.MAX_SAFE_INTEGER),
    cpu: isBoolean(rawStatusBar.cpu) ? rawStatusBar.cpu : DEFAULT_CONFIG.statusBar.cpu,
    ram: isBoolean(rawStatusBar.ram) ? rawStatusBar.ram : DEFAULT_CONFIG.statusBar.ram,
    disk: isBoolean(rawStatusBar.disk) ? rawStatusBar.disk : DEFAULT_CONFIG.statusBar.disk,
    diskIO: enumValue(rawStatusBar.diskIO, ['off', 'read', 'write', 'both', 'combined'], DEFAULT_CONFIG.statusBar.diskIO),
    net: enumValue(rawStatusBar.net, ['off', 'up', 'down', 'both', 'combined'], DEFAULT_CONFIG.statusBar.net),
    ssh: isBoolean(rawStatusBar.ssh) ? rawStatusBar.ssh : DEFAULT_CONFIG.statusBar.ssh,
    gpu: normalizeGpuConfig(rawStatusBar.gpu),
  };
}

function normalizeDiskConfig(rawValue) {
  if (typeof rawValue === 'string') {
    return { ...DEFAULT_CONFIG.disk, mountFilter: rawValue };
  }

  const rawDisk = isObject(rawValue) ? rawValue : {};
  const mountFilter = typeof rawDisk.mountFilter === 'string' && rawDisk.mountFilter.trim()
    ? rawDisk.mountFilter
    : DEFAULT_CONFIG.disk.mountFilter;

  return {
    ...rawDisk,
    mountFilter,
    hideParentMounts: isBoolean(rawDisk.hideParentMounts) ? rawDisk.hideParentMounts : DEFAULT_CONFIG.disk.hideParentMounts,
  };
}

function normalizeDisplayConfig(rawValue) {
  const rawDisplay = isObject(rawValue) ? rawValue : {};
  const rawHiddenGroups = isObject(rawDisplay.hiddenGroups) ? rawDisplay.hiddenGroups : {};
  const hiddenGroups = {};
  for (const [key, fallback] of Object.entries(DEFAULT_CONFIG.display.hiddenGroups)) {
    hiddenGroups[key] = isBoolean(rawHiddenGroups[key]) ? rawHiddenGroups[key] : fallback;
  }
  return {
    ...rawDisplay,
    charts: isBoolean(rawDisplay.charts) ? rawDisplay.charts : DEFAULT_CONFIG.display.charts,
    sparkMinutes: numberInRange(rawDisplay.sparkMinutes, DEFAULT_CONFIG.display.sparkMinutes, 1, 30),
    tabularNums: isBoolean(rawDisplay.tabularNums) ? rawDisplay.tabularNums : DEFAULT_CONFIG.display.tabularNums,
    hiddenGroups,
    highlightMyGpus: isBoolean(rawDisplay.highlightMyGpus) ? rawDisplay.highlightMyGpus : DEFAULT_CONFIG.display.highlightMyGpus,
    showGpuPicker: isBoolean(rawDisplay.showGpuPicker) ? rawDisplay.showGpuPicker : DEFAULT_CONFIG.display.showGpuPicker,
    showGpuUsers: isBoolean(rawDisplay.showGpuUsers) ? rawDisplay.showGpuUsers : DEFAULT_CONFIG.display.showGpuUsers,
  };
}

function normalizeConfig(rawValue = {}) {
  const rawConfig = isObject(rawValue) ? rawValue : {};
  return {
    ...rawConfig,
    refreshInterval: numberInRange(rawConfig.refreshInterval, DEFAULT_CONFIG.refreshInterval, 1, 30),
    statusBar: normalizeStatusBarConfig(rawConfig.statusBar),
    disk: normalizeDiskConfig(rawConfig.disk),
    display: normalizeDisplayConfig(rawConfig.display),
  };
}

module.exports = {
  normalizeConfig,
  normalizeDiskConfig,
  normalizeDisplayConfig,
  normalizeGpuConfig,
  normalizeStatusBarConfig,
};
