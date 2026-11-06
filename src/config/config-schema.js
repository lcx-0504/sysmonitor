'use strict';
const { DEFAULT_CONFIG, COLLECTION_FIELDS, REFRESH_SETTING } = require('./default-config');
const enums = {
  'statusBar.alignment': ['left', 'right'], 'statusBar.diskIO': ['off', 'read', 'write', 'both', 'combined'],
  'statusBar.net': ['off', 'up', 'down', 'both', 'combined'], 'statusBar.gpu.mode': ['off', 'all', 'first', 'specify', 'my'],
  'statusBar.gpu.metric': ['util', 'vram', 'both'], 'disk.mountFilter': ['default', 'more', 'all', 'custom'],
  'servers.remoteWindowMode': ['new', 'recent', 'menu'],
};
const bounds = {
  refreshInterval: REFRESH_SETTING, 'statusBar.priority': { minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  'statusBar.gpu.firstN': { minimum: 1, maximum: 1024, type: 'integer' }, 'display.sparkMinutes': { minimum: 1, maximum: 30 },
  ...Object.fromEntries(COLLECTION_FIELDS.map(field => ['timeouts.' + field.key, { type: 'integer', minimum: field.minimum, maximum: field.maximum }])),
};
function schema(value, path) {
  if (Array.isArray(value)) return { type: 'array', items: { type: 'integer', minimum: 0 }, uniqueItems: true };
  if (value && typeof value === 'object') return { type: 'object', properties: Object.fromEntries(Object.entries(value).map(([key, child]) => [key, schema(child, path + '.' + key)])) };
  return { type: typeof value, ...(enums[path] ? { enum: enums[path] } : {}), ...(bounds[path] || {}) };
}
const CONFIGURATION_SCHEMA = Object.fromEntries(Object.entries(DEFAULT_CONFIG).map(([key, value]) => [key, schema(value, key)]));
CONFIGURATION_SCHEMA.disk.properties.customFsExclude = { type: 'string' };
CONFIGURATION_SCHEMA.disk.properties.customPathExclude = { type: 'string' };
CONFIGURATION_SCHEMA.timeouts.additionalProperties = false;
function settingSchema(key, path = []) {
  let definition = CONFIGURATION_SCHEMA[key];
  for (const segment of path) definition = typeof segment === 'string' && Object.hasOwn(definition?.properties || {}, segment) ? definition.properties[segment] : null;
  return definition;
}
function manifestConfiguration() {
  const descriptions = { refreshInterval: 'cfgRefreshInterval', statusBar: 'cfgStatusBar', disk: 'cfgDisk', display: 'cfgDisplay', servers: 'cfgServers', timeouts: 'cfgTimeouts' };
  const properties = Object.fromEntries(Object.entries(CONFIGURATION_SCHEMA).map(([key, definition]) => ['sysmonitor.' + key,
    { scope: 'application', ...definition, default: DEFAULT_CONFIG[key], description: '%' + descriptions[key] + '%' }]));
  properties['sysmonitor.timeouts'].properties = Object.fromEntries(Object.entries(CONFIGURATION_SCHEMA.timeouts.properties).map(([key, definition]) => [key, { ...definition,
    description: '%' + ({ enabled: 'cfgTimeoutEnabled', connection: 'cfgTimeoutConnection', standard: 'cfgTimeoutStandard', extended: 'cfgTimeoutExtended', sshPoolSize: 'cfgSshPoolSize' })[key] + '%' }]));
  return properties;
}
module.exports = { CONFIGURATION_SCHEMA, settingSchema, manifestConfiguration };
