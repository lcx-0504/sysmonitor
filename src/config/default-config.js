'use strict';

const REFRESH_SETTING = Object.freeze({ default: 2, minimum: 1, maximum: 60 });
const COLLECTION_FIELDS = Object.freeze([
  { key: 'connection', label: 'connectionTimeout', help: 'connectionTimeoutInfo', default: 15, minimum: 5, maximum: 120 },
  { key: 'standard', label: 'standardTimeout', help: 'standardTimeoutInfo', default: 10, minimum: 5, maximum: 120 },
  { key: 'extended', label: 'extendedTimeout', help: 'extendedTimeoutInfo', default: 30, minimum: 5, maximum: 120 },
  { key: 'sshPoolSize', label: 'sshPoolSize', help: 'sshPoolInfo', default: 4, minimum: 1, maximum: 8 },
].map(Object.freeze));
const DEFAULT_CONFIG = Object.freeze({
  refreshInterval: REFRESH_SETTING.default,
  timeouts: Object.freeze({ enabled: false, ...Object.fromEntries(COLLECTION_FIELDS.map(field => [field.key, field.default])) }),
  servers: Object.freeze({
    visibleOnly: false,
    restoreTabs: true,
    remoteWindowMode: 'menu',
    actions: Object.freeze({ editor: true, window: true, terminal: true, remoteWindow: true }),
  }),
  statusBar: Object.freeze({
    barEnabled: true,
    alignment: 'left',
    priority: 10,
    cpu: true,
    ram: true,
    disk: false,
    diskIO: 'off',
    net: 'off',
    ssh: false,
    gpu: Object.freeze({
      summary: true,
      showIdleIds: false,
      mode: 'off',
      cards: Object.freeze([]),
      firstN: 2,
      metric: 'both',
      skipIdle: false,
    }),
  }),
  disk: Object.freeze({
    mountFilter: 'default',
    hideVirtualFs: true,
    hideParentMounts: true,
  }),
  display: Object.freeze({
    charts: true,
    sparkMinutes: 5,
    tabularNums: true,
    hiddenGroups: Object.freeze({ cpu: false, memory: false, disk: false, network: false, gpuSummary: false, gpuCards: false }),
    highlightMyGpus: true,
    showGpuPicker: true,
    showGpuUsers: true,
  }),
});

module.exports = { DEFAULT_CONFIG, COLLECTION_FIELDS, REFRESH_SETTING };
