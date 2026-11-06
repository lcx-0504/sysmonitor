'use strict';
const { isSshDefaultExtension } = require('./ssh-default-extensions');
function webviewConfig(configStore, vscode) {
  const config = configStore.getCurrent();
  return { interval: config.refreshInterval, timeouts: config.timeouts, barCfg: config.statusBar,
    diskCfg: config.disk, displayCfg: config.display, serversCfg: config.servers,
    sshDefaultInstalled: isSshDefaultExtension(vscode), saveState: configStore.getSaveState() };
}
module.exports = { webviewConfig };
