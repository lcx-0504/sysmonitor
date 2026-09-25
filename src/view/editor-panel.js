'use strict';

const path = require('node:path');
let moveQueue = Promise.resolve();

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

module.exports = { setMonitorPanelIcon, createMonitorEditorPanel, moveMonitorPanelToNewWindow };
