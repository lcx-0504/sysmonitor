'use strict';

const ACTION_CONTEXTS = Object.freeze({
  editor: 'sysmonitor.actionEditorVisible',
  window: 'sysmonitor.actionWindowVisible',
  terminal: 'sysmonitor.actionTerminalVisible',
  remoteWindow: 'sysmonitor.actionRemoteWindowVisible',
});

const TITLE_CONTEXTS = Object.freeze({
  sidebarSsh: 'sysmonitor.sidebarSshActive',
  sidebarFixed: 'sysmonitor.sidebarFixedActive',
  editorSsh: 'sysmonitor.editorSshActive',
});

function setActionVisibilityContexts(vscode, serverConfig, previous = null) {
  const actions = serverConfig && serverConfig.actions || {};
  const next = {};
  for (const [key, context] of Object.entries(ACTION_CONTEXTS)) {
    next[key] = actions[key] !== false;
    if ((!previous || previous[key] !== next[key]) && vscode.commands && vscode.commands.executeCommand) {
      vscode.commands.executeCommand('setContext', context, next[key]);
    }
  }
  return next;
}

function setTitleContexts(vscode, active = {}) {
  for (const [key, context] of Object.entries(TITLE_CONTEXTS)) {
    vscode.commands.executeCommand('setContext', context, active[key] === true);
  }
}

module.exports = { ACTION_CONTEXTS, TITLE_CONTEXTS, setActionVisibilityContexts, setTitleContexts };
