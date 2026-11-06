// extension.js
const vscode = require('vscode');
const { ConfigStore } = require('./config/config-store');
const { MonitorSession } = require('./services/monitor-session');
const { MonitorViewProvider } = require('./view/monitor-view-provider');
const { MultiMonitorViewProvider } = require('./view/multi-monitor-view-provider');
const { DeviceMonitorManager } = require('./services/device-monitor-manager');
const { StatusBarController } = require('./view/status-bar-controller');
const { setTitleContexts } = require('./view/action-visibility');
const { revealMonitorContainer } = require('./view/editor-panel');
const { createTranslator } = require('./i18n');

const noop = () => {};

const COMMAND_DEFAULTS = Object.freeze({
  'sysmonitor.openPanel': () => revealMonitorContainer(vscode),
  'sysmonitor.openEditor': noop,
  'sysmonitor.openWindow': noop,
  'sysmonitor.copyToEditor': noop,
  'sysmonitor.copyToWindow': noop,
  'sysmonitor.openTerminal': noop,
  'sysmonitor.openRemoteWindow': noop,
  'sysmonitor.editorReturnSidebar': noop,
  'sysmonitor.editorMoveWindow': noop,
  'sysmonitor.editorTerminal': noop,
  'sysmonitor.editorRemoteWindow': noop,
});

let activeConfigStore = null;

function isPort(value) {
  return /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535;
}

function parseSshConnection(endpoint) {
  if (endpoint.length !== 4 || !isPort(endpoint[1]) || !isPort(endpoint[3])) return null;
  return { clientIp: endpoint[0], clientPort: Number(endpoint[1]), serverIp: endpoint[2], serverPort: Number(endpoint[3]) };
}

function sshServiceOptions(env) {
  const endpoint = (env.SSH_CONNECTION || '').trim().split(/\s+/);
  const sshConnectionInfo = () => parseSshConnection(endpoint);
  return {
    isSsh: !!(env.SSH_CLIENT || env.SSH_CONNECTION || env.SSH_TTY),
    sshClientIp: endpoint[0] || (env.SSH_CLIENT || '').split(/\s+/)[0] || '',
    sshConnectionInfo: sshConnectionInfo() ? sshConnectionInfo : null,
  };
}

function registerCommands(context, handlers) {
  for (const [id, fallback] of Object.entries(COMMAND_DEFAULTS)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handlers[id] || fallback));
  }
}

function registerViews(context, configStore, provider) {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('sysmonitor.panel', provider),
    vscode.window.registerWebviewPanelSerializer('sysmonitor.editor', {
      deserializeWebviewPanel: (panel, state) => {
        if (!configStore.getCurrent().servers.restoreTabs) {
          panel.dispose();
          return;
        }
        return provider.restoreEditor(panel, state);
      },
    }),
  );
}

function watchConfig({ context, configStore }, provider, { statusBar, updateCollection, onConfiguration = noop }) {
  const apply = () => {
    updateCollection();
    provider.updateActionVisibility();
    provider.pushConfig();
    if (statusBar) {
      statusBar.recreate();
      statusBar.update();
    }
  };
  context.subscriptions.push(
    configStore.onDidChange(apply),
    configStore.onDidChangeSaveState((state) => provider.saveStateChanged(state)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('sysmonitor')) configStore.refresh();
      onConfiguration(event);
    }),
  );
}

function activateDevices(environment) {
  const { context, configStore, log, t } = environment;
  const localLinux = process.platform === 'linux';
  const statusBar = localLinux ? new StatusBarController({ vscode, configStore }) : null;
  if (statusBar) context.subscriptions.push(statusBar);
  let provider = null;
  const manager = new DeviceMonitorManager({
    configStore,
    localLinux,
    configFile: vscode.workspace.getConfiguration('remote.SSH').get('configFile') || null,
    onLog: log,
    onWarning: (host, key) => vscode.window.showWarningMessage(t(key, { host })),
    onUpdate: (id, device) => {
      if (provider) provider.onDeviceUpdate(id, device);
    },
    onPauseChange: (paused) => {
      if (provider) provider.pauseChanged(paused);
    },
    onResidualProcesses: (host, pids, acknowledge) => {
      if (provider) return provider.notifyResidualProcesses(host, pids, acknowledge);
    },
  });
  provider = new MultiMonitorViewProvider({
    vscode,
    manager,
    configStore,
    workspaceState: context.workspaceState,
    uiStateStore: context.globalState,
    localLinux,
    logger: log,
    onLocalUpdate: (viewModel) => {
      if (statusBar) statusBar.setViewModel(viewModel.performance, viewModel.currentUserNativeIndices);
    },
  });
  context.subscriptions.push({
    dispose: () => {
      provider.dispose();
      manager.dispose();
    },
  });
  registerViews(context, configStore, provider);
  watchConfig(environment, provider, {
    statusBar,
    updateCollection: () => manager.updateConfig(),
    onConfiguration: (event) => {
      if (event.affectsConfiguration('remote.SSH.configFile')) provider.refreshHosts();
      if (event.affectsConfiguration('remote.SSH.defaultExtensions')) provider.pushConfig();
    },
  });
  return {
    'sysmonitor.openEditor': () => provider.moveSidebarDeviceToEditor(),
    'sysmonitor.openWindow': () => provider.moveSidebarDeviceToEditor(true),
    'sysmonitor.copyToEditor': () => provider.openEditorPanel(),
    'sysmonitor.copyToWindow': () => provider.openFloatingPanel(),
    'sysmonitor.openTerminal': () => provider.openTerminalForSidebar(),
    'sysmonitor.openRemoteWindow': () => provider.openRemoteWindowForSidebar(),
    'sysmonitor.editorReturnSidebar': () => provider.returnActiveEditorToSidebar(),
    'sysmonitor.editorMoveWindow': () => provider.moveActiveEditorToNewWindow(),
    'sysmonitor.editorTerminal': () => provider.openTerminalForEditor(),
    'sysmonitor.editorRemoteWindow': () => provider.openRemoteWindowForEditor(),
  };
}

function unsupportedViewHtml(title, body) {
  const nonce = Math.random().toString(36).slice(2, 18);
  const style = [
    'body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:16px;font-size:12px;line-height:1.6}',
    'h3{margin:0 0 10px;font-size:13px}',
    'p{color:var(--vscode-descriptionForeground);margin:0}',
  ].join('');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">${style}</style></head><body>
<h3>${title}</h3><p>${body}</p></body></html>`;
}

function activateUnsupported({ context, t }, localInRemoteWindow) {
  setTitleContexts(vscode);
  const title = localInRemoteWindow ? t('runTheExtensionInTheRemoteEnvironment') : t('linuxOnly');
  const body = localInRemoteWindow
    ? t('systemMonitorIsRunningLocallyInstallOrEnable')
    : t('thisRemoteIsNotLinuxSystemMonitorRequires', { process });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('sysmonitor.panel', {
      resolveWebviewView(view) {
        view.webview.html = unsupportedViewHtml(title, body);
      },
    }),
    vscode.window.registerWebviewPanelSerializer('sysmonitor.editor', {
      deserializeWebviewPanel: (panel) => {
        panel.dispose();
      },
    }),
  );
  return {};
}

function activateSession(environment) {
  const { context, configStore, log } = environment;
  setTitleContexts(vscode, { sidebarFixed: true });
  const statusBar = new StatusBarController({ vscode, configStore });
  context.subscriptions.push(statusBar);
  let provider = null;
  const session = new MonitorSession({
    configStore,
    serviceOptions: sshServiceOptions(process.env),
    onLog: log,
    onUpdate: (current) => {
      if (provider) provider.renderSession();
      if (current.model) statusBar.setViewModel(current.model.performance, current.model.currentUserNativeIndices);
    },
  });
  provider = new MonitorViewProvider({ vscode, session, configStore, uiStateStore: context.globalState, logger: log });
  context.subscriptions.push({
    dispose: () => {
      provider.dispose();
      session.dispose();
    },
  });
  registerViews(context, configStore, provider);
  watchConfig(environment, provider, { statusBar, updateCollection: () => session.updateConfig() });
  session.start();
  return {
    'sysmonitor.copyToEditor': () => provider.openEditorPanel(),
    'sysmonitor.copyToWindow': () => provider.openFloatingPanel(),
    'sysmonitor.editorReturnSidebar': () => provider.returnActiveEditorToSidebar(),
    'sysmonitor.editorMoveWindow': () => provider.moveActiveEditorToNewWindow(),
  };
}

async function activate(context) {
  const outputChannel = vscode.window.createOutputChannel('System Monitor');
  context.subscriptions.push(outputChannel);
  const log = (message) => outputChannel.appendLine('[' + new Date().toISOString().slice(11, 23) + '] ' + message);
  log('activate');
  const configStore = new ConfigStore({
    vscode,
    onError: (error) => log('config write failed: ' + (error && error.message ? error.message : error)),
    onUpgradeError: (error) => {
      log('config upgrade write failed: ' + error.message);
      vscode.window.showWarningMessage(createTranslator(vscode.env.language)('configUpgradeFailed'));
    },
  });
  activeConfigStore = configStore;
  await configStore.upgrade();
  context.subscriptions.push({ dispose: () => configStore.dispose() });
  const environment = { context, configStore, log, t: createTranslator(vscode.env.language || '') };
  const remoteWindow = !!vscode.env.remoteName;
  const localInRemoteWindow = remoteWindow && context.extension.extensionKind !== vscode.ExtensionKind.Workspace;
  let commands;
  if (!remoteWindow) commands = activateDevices(environment);
  else if (localInRemoteWindow || process.platform !== 'linux') commands = activateUnsupported(environment, localInRemoteWindow);
  else commands = activateSession(environment);
  registerCommands(context, commands);
}

function deactivate() {
  if (!activeConfigStore) return Promise.resolve();
  return activeConfigStore.flush().catch(() => {});
}

module.exports = { activate, deactivate };
