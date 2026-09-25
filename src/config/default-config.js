'use strict';

const DEFAULT_CONFIG = Object.freeze({
  refreshInterval: 2,
  servers: Object.freeze({
    visibleOnly: false,
    restoreTabs: true,
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

module.exports = { DEFAULT_CONFIG };
