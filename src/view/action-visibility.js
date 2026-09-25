'use strict';

const ACTION_CONTEXTS = Object.freeze({
  editor: 'sysmonitor.actionEditorVisible',
  window: 'sysmonitor.actionWindowVisible',
  terminal: 'sysmonitor.actionTerminalVisible',
  remoteWindow: 'sysmonitor.actionRemoteWindowVisible',
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

module.exports = { ACTION_CONTEXTS, setActionVisibilityContexts };
