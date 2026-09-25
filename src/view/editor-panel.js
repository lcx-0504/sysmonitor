'use strict';

const path = require('node:path');
const os = require('node:os');
let moveQueue = Promise.resolve();

async function getMonitorEditorTitle(vscode) {
  if (vscode.env && vscode.env.remoteName === 'ssh-remote' && vscode.commands) {
    try {
      const host = await vscode.commands.executeCommand('remote-internal.getActiveSshRemote');
      if (host && typeof host.hostName === 'string' && host.hostName) return host.hostName;
    } catch (_) { /* Remote-SSH may not expose its connection details. */ }
  }
  const workspace = vscode.workspace || {};
  const uris = [...(workspace.workspaceFolders || []).map((folder) => folder.uri), workspace.workspaceFile];
  for (const uri of uris) {
    if (!uri || uri.scheme !== 'vscode-remote' || !uri.authority.startsWith('ssh-remote+')) continue;
    const authority = uri.authority.slice('ssh-remote+'.length);
    try {
      const host = JSON.parse(Buffer.from(authority, 'hex').toString('utf8'));
      if (host && typeof host.hostName === 'string' && host.hostName) return host.hostName;
    } catch (_) { /* Plain aliases are also valid remote authorities. */ }
    if (authority) return authority.slice(authority.lastIndexOf('@') + 1);
  }
  return os.hostname();
}

function setMonitorPanelIcon(vscode, panel) {
  panel.iconPath = {
    light: vscode.Uri.file(path.join(__dirname, '..', '..', 'icon-tab-light.svg')),
    dark: vscode.Uri.file(path.join(__dirname, '..', '..', 'icon-tab-dark.svg')),
  };
}

function createMonitorEditorPanel(vscode, title = 'System Monitor') {
  return vscode.window.createWebviewPanel('sysmonitor.editor', title, vscode.ViewColumn.Active, { enableScripts: true });
}

function moveMonitorPanelToNewWindow(vscode, panel, { disposeOnError = true } = {}) {
  const operation = moveQueue.then(async () => {
    try {
      panel.reveal();
      await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
      await new Promise((resolve) => setTimeout(resolve, 0));
      try { panel.reveal(); } catch (_) { /* VS Code may recreate the panel during the move. */ }
    } catch (error) {
      if (disposeOnError) panel.dispose();
      throw error;
    }
  });
  moveQueue = operation.catch(() => {});
  return operation;
}

module.exports = { setMonitorPanelIcon, createMonitorEditorPanel, moveMonitorPanelToNewWindow, getMonitorEditorTitle };
