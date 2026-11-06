'use strict';

const { DEFAULT_CONFIG, COLLECTION_FIELDS } = require('./default-config');
const { normalizeConfig } = require('./normalize-config');

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isBoolean = value => typeof value === 'boolean';
const UPGRADE_KEYS = ['disk', 'display', 'timeouts'];

function upgradeSetting(key, value) {
  if (!isObject(value)) return null;
  if (key === 'disk' && Object.hasOwn(value, 'showVirtualFs')) {
    const next = { ...value };
    if (!isBoolean(next.hideVirtualFs)) next.hideVirtualFs = isBoolean(value.showVirtualFs) ? !value.showVirtualFs : DEFAULT_CONFIG.disk.hideVirtualFs;
    delete next.showVirtualFs;
    return next;
  }
  if (key === 'display' && isObject(value.hiddenGroups) && Object.hasOwn(value.hiddenGroups, 'system')) {
    const hiddenGroups = { ...value.hiddenGroups };
    if (isBoolean(hiddenGroups.system)) for (const group of ['cpu', 'memory']) {
      if (!isBoolean(hiddenGroups[group])) hiddenGroups[group] = hiddenGroups.system;
    }
    delete hiddenGroups.system;
    return { ...value, hiddenGroups };
  }
  if (key === 'timeouts' && !Object.hasOwn(value, 'enabled')) {
    const normalized = normalizeConfig({ timeouts: value }).timeouts;
    const enabled = COLLECTION_FIELDS.some(field => normalized[field.key] !== DEFAULT_CONFIG.timeouts[field.key]);
    return { ...value, enabled };
  }
  return null;
}

async function upgradeConfiguration(vscode) {
  const configuration = vscode.workspace.getConfiguration('sysmonitor');
  for (const key of UPGRADE_KEYS) {
    const value = upgradeSetting(key, configuration.inspect(key)?.globalValue);
    if (value) await configuration.update(key, value, true);
  }
}

module.exports = { upgradeSetting, upgradeConfiguration };
