'use strict';

const PROTOCOL_VERSION = 1;

const TO_EXTENSION = Object.freeze({
  ready: 'ready',
  setConfig: 'setConfig',
  retryConfigSave: 'retryConfigSave',
  openSettings: 'openSettings',
  openLink: 'openLink',
  addSshDefaultExtension: 'addSshDefaultExtension',
  dismissLocalIntro: 'dismissLocalIntro',
  setProcessDisplay: 'setProcessDisplay',
  pause: 'pause',
  switchPage: 'switchPage',
  retrySampling: 'retrySampling',
  retryConnection: 'retryConnection',
  openSessionTerminal: 'openSessionTerminal',
  refreshServers: 'refreshServers',
  openServer: 'openServer',
  openTerminal: 'openTerminal',
  activateRemoteWindow: 'activateRemoteWindow',
  openRemoteWindow: 'openRemoteWindow',
  switchDevice: 'switchDevice',
  reorderDevices: 'reorderDevices',
  closeDevice: 'closeDevice',
});

const TO_WEBVIEW = Object.freeze({
  config: 'config',
  configSaveState: 'configSaveState',
  uiState: 'uiState',
  snapshot: 'snapshot',
  deviceState: 'deviceState',
  navigation: 'navigation',
  navigatePage: 'navigatePage',
  servers: 'servers',
  localIntroDismissed: 'localIntroDismissed',
  sshDefaultExtensions: 'sshDefaultExtensions',
  retryConnectionResult: 'retryConnectionResult',
  remoteFolders: 'remoteFolders',
  remoteWindowActionDone: 'remoteWindowActionDone',
});

module.exports = { PROTOCOL_VERSION, TO_EXTENSION, TO_WEBVIEW };
