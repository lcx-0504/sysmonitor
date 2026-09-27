// extension.js
const vscode = require('vscode');
const { ConfigStore } = require('./config/config-store');
const { MonitorSession } = require('./services/monitor-session');
const { MonitorViewProvider } = require('./view/monitor-view-provider');
const { MultiMonitorViewProvider } = require('./view/multi-monitor-view-provider');
const { DeviceMonitorManager } = require('./services/device-monitor-manager');
const { StatusBarController } = require('./view/status-bar-controller');

const isSSH = !!(process.env.SSH_CLIENT || process.env.SSH_CONNECTION || process.env.SSH_TTY);
const sshClientIp = (process.env.SSH_CONNECTION || '').split(/\s+/)[0] || '';
let outputChannel = null;
let currentUserNativeIndices = [];
function logDebug(msg) { if (outputChannel) outputChannel.appendLine('[' + new Date().toISOString().slice(11, 23) + '] ' + msg); }

// ── 统一配置存储层 ──────────────────────────────────────────────────────────
const configStore = new ConfigStore({
  vscode,
  onError: (error) => logDebug('config write failed: ' + (error && error.message ? error.message : error)),
});

function getConfig() { return configStore.getCurrent(); }

let currentStatusBarViewModel = {};
let statusBarController = null;
function updateBar() { if (statusBarController) statusBarController.setViewModel(currentStatusBarViewModel, currentUserNativeIndices); }

function activate(context) {
  outputChannel = vscode.window.createOutputChannel('System Monitor');
  context.subscriptions.push(outputChannel);
  logDebug('activate');
  configStore.refresh();
  context.subscriptions.push({ dispose: () => configStore.dispose() });
  const lang = vscode.env.language || '';
  const zh = lang.startsWith('zh');

  if (!vscode.env.remoteName) {
    const localLinux = process.platform === 'linux';
    const sshConfigFile = vscode.workspace.getConfiguration('remote.SSH').get('configFile') || null;
    let provider = null;
    const manager = new DeviceMonitorManager({
      configStore,
      language: vscode.env.language,
      localLinux,
      configFile: sshConfigFile,
      onLog: logDebug,
      onUpdate: (id, device) => { if (provider) provider.onDeviceUpdate(id, device); },
      onPauseChange: (paused) => { if (provider) provider.broadcast({ cmd: 'uiState', paused }); },
      onResidualProcesses: (host, pids, acknowledge) => {
        if (provider) return provider.notifyResidualProcesses(host, pids, acknowledge);
      },
    });
    provider = new MultiMonitorViewProvider({
      vscode, manager, configStore, workspaceState: context.workspaceState, uiStateStore: context.globalState, localLinux, logger: logDebug,
      onLocalUpdate: (viewModel) => {
        currentStatusBarViewModel = viewModel.performance;
        currentUserNativeIndices = viewModel.currentUserNativeIndices;
        updateBar();
      },
    });
    context.subscriptions.push({ dispose: () => { provider.dispose(); manager.dispose(); } });
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('sysmonitor.panel', provider, { webviewOptions: { retainContextWhenHidden: true } }));
    context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('sysmonitor.editor', {
      deserializeWebviewPanel: (panel, state) => {
        if (!configStore.getCurrent().servers.restoreTabs) { panel.dispose(); return; }
        return provider.attachEditor(panel, state && state.navigation ? state.navigation : state);
      },
    }));
    if (localLinux) statusBarController = new StatusBarController({ vscode, configStore, subscriptions: context.subscriptions });
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('sysmonitor')) {
        if (!configStore.isWriting) configStore.refresh();
        manager.updateConfig();
        provider.updateActionVisibility();
        provider.pushConfig();
        if (statusBarController) { statusBarController.recreate(); updateBar(); }
      }
      if (event.affectsConfiguration('remote.SSH.configFile')) provider.refreshHosts();
      if (event.affectsConfiguration('remote.SSH.defaultExtensions')) provider.pushConfig();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.openPanel', () => vscode.commands.executeCommand('workbench.view.extension.sysmonitor-container')));
    context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.openEditor', () => provider.moveSidebarDeviceToEditor()));
    context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.openWindow', () => provider.moveSidebarDeviceToEditor(true)));
    context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.copyToEditor', () => provider.openEditorPanel()));
    context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.copyToWindow', () => provider.openFloatingPanel()));
    context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.openTerminal', () => provider.openTerminalForSidebar()));
    context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.openRemoteWindow', () => provider.openRemoteWindowForSidebar()));
    context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.editorReturnSidebar', () => provider.returnActiveEditorToSidebar()));
    context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.editorMoveWindow', () => provider.moveActiveEditorToNewWindow()));
    context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.editorTerminal', () => provider.openTerminalForEditor()));
    context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.editorRemoteWindow', () => provider.openRemoteWindowForEditor()));
    return;
  }

  if (process.platform !== 'linux') {
    vscode.commands.executeCommand('setContext', 'sysmonitor.sidebarDeviceActive', false);
    vscode.commands.executeCommand('setContext', 'sysmonitor.sidebarSshActive', false);
    vscode.commands.executeCommand('setContext', 'sysmonitor.sidebarFixedActive', false);
    vscode.commands.executeCommand('setContext', 'sysmonitor.editorSshActive', false);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('sysmonitor.panel', {
        resolveWebviewView(view) {
          const nonce = Math.random().toString(36).slice(2, 18);
          const title = zh ? '仅支持 Linux' : 'Linux only';
          const body = zh
            ? '当前远程环境不是 Linux（' + process.platform + '），本扩展无法采集系统指标。请在 Linux 服务器、WSL、Linux 容器或本地 Linux 中使用。'
            : 'This remote is not Linux (' + process.platform + '). System Monitor requires Linux. Use a Linux server, WSL, Linux container, or local Linux.';
          view.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:16px;font-size:12px;line-height:1.6}h3{margin:0 0 10px;font-size:13px}p{color:var(--vscode-descriptionForeground);margin:0}</style></head><body>
<h3>${title}</h3><p>${body}</p></body></html>`;
        }
      })
    );
    context.subscriptions.push(
      vscode.commands.registerCommand('sysmonitor.openPanel', () => {
        vscode.commands.executeCommand('workbench.view.extension.sysmonitor-container');
      })
    );
    context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.openTerminal', () => {}));
    context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.openRemoteWindow', () => {}));
    context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.copyToEditor', () => {}));
    context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.copyToWindow', () => {}));
    context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.editorReturnSidebar', () => {}));
    context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.editorMoveWindow', () => {}));
    context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.editorTerminal', () => {}));
    context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.editorRemoteWindow', () => {}));
    return;
  }

  vscode.commands.executeCommand('setContext', 'sysmonitor.sidebarDeviceActive', true);
  vscode.commands.executeCommand('setContext', 'sysmonitor.sidebarSshActive', false);
  vscode.commands.executeCommand('setContext', 'sysmonitor.sidebarFixedActive', true);
  vscode.commands.executeCommand('setContext', 'sysmonitor.editorSshActive', false);

  let provider = null;
  const session = new MonitorSession({
    configStore,
    language: vscode.env.language,
    serviceOptions: { isSsh: isSSH, sshClientIp },
    onLog: logDebug,
    onUpdate: (current) => {
      if (provider) provider.renderSession();
      if (current.model) {
        currentStatusBarViewModel = current.model.performance;
        currentUserNativeIndices = current.model.currentUserNativeIndices;
      }
      updateBar();
    },
  });
  provider = new MonitorViewProvider({
    vscode,
    session,
    configStore,
    uiStateStore: context.globalState,
    logger: logDebug,
    onConfigUpdated: () => updateBar(),
  });
  context.subscriptions.push({ dispose: () => session.dispose() });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('sysmonitor.panel', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  statusBarController = new StatusBarController({ vscode, configStore, subscriptions: context.subscriptions });

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('sysmonitor')) {
      logDebug('onDidChangeConfiguration: selfWriting=' + configStore.isWriting);
      if (!configStore.isWriting) {
        configStore.refresh();
        provider.updateActionVisibility();
        provider.pushConfig();
      }
      session.updateConfig();
      statusBarController.recreate();
      updateBar();
    }
  }));

  context.subscriptions.push(
    vscode.commands.registerCommand('sysmonitor.openPanel', () => {
      vscode.commands.executeCommand('workbench.view.extension.sysmonitor-container');
    })
  );
  context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.openEditor', () => {}));
  context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.openWindow', () => {}));
  context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.copyToEditor', () => provider.openEditorPanel()));
  context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.copyToWindow', () => provider.openFloatingPanel()));
  context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.openTerminal', () => {}));
  context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.openRemoteWindow', () => {}));
  context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.editorReturnSidebar', () => provider.returnActiveEditorToSidebar()));
  context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.editorMoveWindow', () => provider.moveActiveEditorToNewWindow()));
  context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.editorTerminal', () => {}));
  context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.editorRemoteWindow', () => {}));
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('sysmonitor.editor', {
    deserializeWebviewPanel: (panel, state) => {
      if (!configStore.getCurrent().servers.restoreTabs) { panel.dispose(); return; }
      return provider.attachEditorPanel(panel, state);
    },
  }));
  session.start();
}

function deactivate() { }
module.exports = { activate, deactivate };
