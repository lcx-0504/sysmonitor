'use strict';

const boolean = (defaultValue, extra = {}) => ({ type: 'boolean', default: defaultValue, ...extra });
const choice = (values, defaultValue) => ({ type: 'string', enum: values, default: defaultValue });
const number = (defaultValue, minimum, maximum, extra = {}) => ({ type: 'number', default: defaultValue, minimum, maximum, ...extra });
const integer = (defaultValue, minimum, maximum, extra = {}) => ({ type: 'integer', default: defaultValue, minimum, maximum, ...extra });
const object = (properties, extra = {}) => ({ type: 'object', properties, ...extra });
// An optional text field is left out of the defaults until it is set; invalid values normalize to an empty string.
const optionalText = () => ({ type: 'string', default: '', optional: true });

function deepFreeze(value) {
  if (value && typeof value === 'object') for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

// The single definition of every setting. Fields other than JSON schema keywords:
// description is a manifest localization key, optional omits the field from the defaults,
// sorted orders array items, and label/help are the settings page translation keys.
const SETTINGS = deepFreeze({
  refreshInterval: number(2, 1, 60, { description: 'cfgRefreshInterval' }),
  collection: object({
    custom: boolean(false, { description: 'cfgCollectionCustom' }),
    connectionTimeout: integer(15, 5, 120, { description: 'cfgCollectionConnectionTimeout', label: 'connectionTimeout', help: 'connectionTimeoutInfo' }),
    standardTimeout: integer(10, 5, 120, { description: 'cfgCollectionStandardTimeout', label: 'standardTimeout', help: 'standardTimeoutInfo' }),
    extendedTimeout: integer(30, 5, 120, { description: 'cfgCollectionExtendedTimeout', label: 'extendedTimeout', help: 'extendedTimeoutInfo' }),
    sshPoolSize: integer(4, 1, 8, { description: 'cfgCollectionSshPoolSize', label: 'sshPoolSize', help: 'sshPoolInfo' }),
  }, { description: 'cfgCollection', additionalProperties: false }),
  servers: object({
    visibleOnly: boolean(false),
    restoreTabs: boolean(true),
    remoteWindowMode: choice(['new', 'recent', 'menu'], 'menu'),
    actions: object({
      editor: boolean(true),
      window: boolean(true),
      terminal: boolean(true),
      remoteWindow: boolean(true),
    }),
  }, { description: 'cfgServers' }),
  statusBar: object({
    barEnabled: boolean(true),
    alignment: choice(['left', 'right'], 'left'),
    priority: number(10, 0, Number.MAX_SAFE_INTEGER),
    cpu: boolean(true),
    ram: boolean(true),
    disk: boolean(false),
    diskIO: choice(['off', 'read', 'write', 'both', 'combined'], 'off'),
    net: choice(['off', 'up', 'down', 'both', 'combined'], 'off'),
    ssh: boolean(false),
    gpu: object({
      summary: boolean(true),
      showIdleIds: boolean(false),
      mode: choice(['off', 'all', 'first', 'specify', 'my'], 'off'),
      cards: { type: 'array', items: { type: 'integer', minimum: 0 }, uniqueItems: true, sorted: true, default: [] },
      firstN: integer(2, 1, 1024),
      metric: choice(['util', 'vram', 'both'], 'both'),
      skipIdle: boolean(false),
    }),
  }, { description: 'cfgStatusBar' }),
  disk: object({
    mountFilter: choice(['default', 'more', 'all', 'custom'], 'default'),
    hideVirtualFs: boolean(true),
    hideParentMounts: boolean(true),
    customFsExclude: optionalText(),
    customPathExclude: optionalText(),
  }, { description: 'cfgDisk' }),
  display: object({
    charts: boolean(true),
    sparkMinutes: number(5, 1, 30),
    tabularNums: boolean(true),
    hiddenGroups: object({
      cpu: boolean(false),
      memory: boolean(false),
      disk: boolean(false),
      network: boolean(false),
      gpuSummary: boolean(false),
      gpuCards: boolean(false),
    }),
    highlightMyGpus: boolean(true),
    showGpuPicker: boolean(true),
    showGpuUsers: boolean(true),
  }, { description: 'cfgDisplay' }),
});

const CONFIGURATION_KEYS = Object.freeze(Object.keys(SETTINGS));
const SCHEMA_KEYWORDS = ['type', 'enum', 'minimum', 'maximum', 'items', 'uniqueItems', 'properties', 'additionalProperties'];

function defaultValue(definition) {
  if (definition.type !== 'object') return definition.default;
  const entries = Object.entries(definition.properties).filter(([, child]) => !child.optional);
  return Object.freeze(Object.fromEntries(entries.map(([key, child]) => [key, defaultValue(child)])));
}

function settingSchema(key, path = []) {
  let definition = Object.hasOwn(SETTINGS, key) ? SETTINGS[key] : null;
  for (const segment of path) {
    const properties = definition?.properties || {};
    definition = typeof segment === 'string' && Object.hasOwn(properties, segment) ? properties[segment] : null;
  }
  return definition;
}

function jsonSchema(definition) {
  const schema = {};
  for (const keyword of SCHEMA_KEYWORDS) {
    if (definition[keyword] === undefined) continue;
    if (keyword === 'items') schema.items = jsonSchema(definition.items);
    else if (keyword === 'properties') schema.properties = propertySchemas(definition.properties);
    else schema[keyword] = definition[keyword];
  }
  return schema;
}

function propertySchemas(properties) {
  return Object.fromEntries(Object.entries(properties).map(([key, child]) => {
    const schema = jsonSchema(child);
    if (child.description) schema.description = '%' + child.description + '%';
    return [key, schema];
  }));
}

function manifestConfiguration() {
  return Object.fromEntries(Object.entries(SETTINGS).map(([key, definition]) => ['sysmonitor.' + key, {
    scope: 'application',
    ...jsonSchema(definition),
    default: defaultValue(definition),
    description: '%' + definition.description + '%',
  }]));
}

module.exports = { SETTINGS, CONFIGURATION_KEYS, defaultValue, settingSchema, manifestConfiguration };
