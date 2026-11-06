// State shared across webview modules. Each field has a single writer:
// bridge, initial, environment and locale are set by app.mjs at startup; config by app.mjs from extension
// messages and by settings.mjs for user edits; ui.paused and ui.page by app.mjs; ui.deviceId and
// ui.navigation by navigation.mjs; data.viewModel by app.mjs; data.status by connection.mjs;
// charts by chart-state.mjs. Module-private state lives in the owning module.
export const state = {
  bridge: null,
  initial: {},
  environment: {},
  locale: {},
  config: {},
  ui: {},
  data: { viewModel: null, status: null },
  charts: {},
};

export function currentGpus() {
  return state.data.viewModel?.performance?.gpus || [];
}
