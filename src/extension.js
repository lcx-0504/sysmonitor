// extension.js
const vscode = require('vscode');
const path = require('path');
const { ConfigStore } = require('./config/config-store');
const { MonitorService } = require('./services/monitor-service');
const { MonitorViewProvider } = require('./view/monitor-view-provider');
const { StatusBarController } = require('./view/status-bar-controller');

const pkg = require(path.join(__dirname, '..', 'package.json'));
const EXTENSION_ID = `${pkg.publisher}.${pkg.name}`;

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
    if (process.platform === 'linux') {
      // local Linux → fall through to full monitoring
      const localDismissed = context.globalState.get('sysmonitor.localLinuxNotifyDismissed', false);
      const localSshCfg = vscode.workspace.getConfiguration('remote.SSH');
      const localDefaultExts = (localSshCfg.get('defaultExtensions') || []).map(s => s.toLowerCase());
      const localAlreadyAdded = localDefaultExts.includes(EXTENSION_ID.toLowerCase());
      if (!localDismissed && !localAlreadyAdded) {
        const autoBtn = zh ? '一键加入' : 'Add to SSH default extensions';
        const dismissBtn = zh ? '不再提醒' : "Don't remind me";
        vscode.window.showInformationMessage(
          zh
            ? 'System Monitor 支持在远程 Linux 环境中运行，是否将扩展 ID 写入到 Remote-SSH 设置以自动安装到服务器？'
            : 'System Monitor also runs on remote Linux. Add extension ID to Remote-SSH settings to auto-install on servers?',
          autoBtn, dismissBtn
        ).then(choice => {
          if (choice === autoBtn) {
            const remoteSshConfiguration = vscode.workspace.getConfiguration('remote.SSH');
            const list = (remoteSshConfiguration.get('defaultExtensions') || []).slice();
            if (!list.includes(EXTENSION_ID)) {
              list.push(EXTENSION_ID);
              remoteSshConfiguration.update('defaultExtensions', list, true).then(() => {
                context.globalState.update('sysmonitor.localLinuxNotifyDismissed', true);
                vscode.window.showInformationMessage(zh
                  ? '已添加 ' + EXTENSION_ID + ' 到 SSH 默认扩展。'
                  : 'Added ' + EXTENSION_ID + ' to SSH default extensions.');
              });
            }
          } else if (choice === dismissBtn) {
            context.globalState.update('sysmonitor.localLinuxNotifyDismissed', true);
          }
        });
      } else if (!localDismissed && localAlreadyAdded) {
        context.globalState.update('sysmonitor.localLinuxNotifyDismissed', true);
      }
    } else {
      const dismissed = context.globalState.get('sysmonitor.notifyDismissed', false);
      const sshCfg = vscode.workspace.getConfiguration('remote.SSH');
      const defaultExts = (sshCfg.get('defaultExtensions') || []).map(s => s.toLowerCase());
      const alreadyAdded = defaultExts.includes(EXTENSION_ID.toLowerCase());

      if (!dismissed && !alreadyAdded) {
        const autoBtn = zh ? '一键加入' : 'Add to SSH default extensions';
        const dismissBtn = zh ? '不再提醒' : "Don't remind me";
        vscode.window.showInformationMessage(
          zh
            ? 'System Monitor 仅支持远程/本地 Linux 环境中运行。是否将扩展 ID 写入到 Remote-SSH 设置以自动安装到服务器？'
            : 'System Monitor runs on remote/local Linux only. Add extension ID to Remote-SSH settings to auto-install on servers?',
          autoBtn, dismissBtn
        ).then(choice => {
          if (choice === autoBtn) {
            const remoteSshConfiguration = vscode.workspace.getConfiguration('remote.SSH');
            const list = (remoteSshConfiguration.get('defaultExtensions') || []).slice();
            if (!list.includes(EXTENSION_ID)) {
              list.push(EXTENSION_ID);
              remoteSshConfiguration.update('defaultExtensions', list, true).then(() => {
                context.globalState.update('sysmonitor.notifyDismissed', true);
                vscode.window.showInformationMessage(zh
                  ? '已添加 ' + EXTENSION_ID + ' 到 SSH 默认扩展。'
                  : 'Added ' + EXTENSION_ID + ' to SSH default extensions.');
              });
            }
          } else if (choice === dismissBtn) {
            context.globalState.update('sysmonitor.notifyDismissed', true);
          }
        });
      } else if (!dismissed && alreadyAdded) {
        context.globalState.update('sysmonitor.notifyDismissed', true);
        vscode.window.showInformationMessage(zh
          ? 'System Monitor 已在 SSH 默认扩展列表中，下次连接 Linux 服务器时将自动安装。'
          : 'System Monitor is already in your SSH default extensions and will auto-install on Linux servers.');
      }
      context.subscriptions.push(
        vscode.commands.registerCommand('sysmonitor.openPanel', () => {
          vscode.window.showInformationMessage(zh
            ? 'System Monitor 仅在远程/本地 Linux 环境中运行，连接到远程 Linux 服务器、WSL、Linux 容器等以开始使用。'
            : 'System Monitor runs on remote/local Linux only. Connect to a remote Linux server, WSL, Linux container, etc. to get started.');
        })
      );
      return;
    }
  }

  if (process.platform !== 'linux') {
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
    return;
  }

  let provider = null;
  const monitorService = new MonitorService({
    runtimeConfig: getConfig(),
    isSsh: isSSH,
    sshClientIp,
    onLog: logDebug,
    onTick: (snapshot) => {
      if (provider) {
        const viewModel = provider.renderSnapshot(snapshot);
        currentStatusBarViewModel = viewModel.performance;
        currentUserNativeIndices = viewModel.currentUserNativeIndices;
      }
      updateBar();
    },
  });
  provider = new MonitorViewProvider({
    vscode,
    monitorService,
    configStore,
    uiStateStore: context.globalState,
    logger: logDebug,
    onConfigUpdated: () => updateBar(),
  });
  context.subscriptions.push({ dispose: () => monitorService.dispose() });
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
        provider.pushConfig();
      }
      monitorService.updateConfig(getConfig());
      statusBarController.recreate();
      updateBar();
    }
  }));

  context.subscriptions.push(
    vscode.commands.registerCommand('sysmonitor.openPanel', () => {
      vscode.commands.executeCommand('workbench.view.extension.sysmonitor-container');
    })
  );
  context.subscriptions.push(vscode.commands.registerCommand('sysmonitor.openEditor', () => provider.openEditorPanel()));
  monitorService.start();
}

function deactivate() { }
module.exports = { activate, deactivate };
