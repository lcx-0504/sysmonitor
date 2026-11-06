'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { WEBVIEW_SCRIPT_FILES } = require('../src/view/webview-html');
const { catalogs } = require('../src/i18n');
const { createFakeVscode, requireWithVscode } = require('./fake-vscode');

const projectRoot = path.resolve(__dirname, '..');
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), 'utf8'));

test('extension manifest points to a CommonJS entry point exporting the extension activate and deactivate', () => {
  const manifest = readJson('package.json');
  assert.deepEqual(manifest.extensionKind, ['workspace']);
  const vscode = createFakeVscode();
  const entry = requireWithVscode(path.resolve(projectRoot, manifest.main), vscode);
  assert.equal(entry, requireWithVscode(path.join(projectRoot, 'src/extension.js'), vscode));
  assert.deepEqual(Object.keys(entry).sort(), ['activate', 'deactivate']);
  assert.equal(typeof entry.activate, 'function');
  assert.equal(typeof entry.deactivate, 'function');
});

test('English and Chinese package localization expose the same keys', () => {
  const english = readJson('package.nls.json');
  const chinese = readJson('package.nls.zh-cn.json');
  assert.deepEqual(Object.keys(chinese).sort(), Object.keys(english).sort());
  assert.equal(english.cmdEditorMoveWindow, english.cmdOpenWindow);
  assert.equal(chinese.cmdEditorMoveWindow, chinese.cmdOpenWindow);
  assert.equal(chinese.cmdCopyToWindow, '系统监控: 在新窗口打开');
  assert.equal(chinese.cmdOpenRemoteWindow, '系统监控: 打开远程窗口');
  const settingsLabels = catalogs['zh-CN'];
  assert.equal(settingsLabels.actionEditorView, '新建 / 切换编辑器视图');
  assert.equal(settingsLabels.actionNewWindow, '新建 / 移动到新窗口');
  assert.equal(settingsLabels.openSSHTerminal, '打开 SSH 终端');
  assert.equal(settingsLabels.openRemoteWindow, '打开远程窗口');
});

test('public configuration defaults remain characterized', () => {
  const manifest = readJson('package.json');
  const properties = manifest.contributes.configuration.properties;

  assert.deepEqual(properties['sysmonitor.servers'].default.actions, {
    editor: true, window: true, terminal: true, remoteWindow: true,
  });
  assert.equal(properties['sysmonitor.servers'].default.remoteWindowMode, 'menu');

  assert.equal(properties['sysmonitor.refreshInterval'].default, 2);
  assert.deepEqual(properties['sysmonitor.statusBar'].default, {
    barEnabled: true,
    alignment: 'left',
    priority: 10,
    cpu: true,
    ram: true,
    disk: false,
    diskIO: 'off',
    net: 'off',
    ssh: false,
    gpu: {
      summary: true,
      showIdleIds: false,
      mode: 'off',
      cards: [],
      firstN: 2,
      metric: 'both',
      skipIdle: false,
    },
  });
  assert.deepEqual(properties['sysmonitor.disk'].default, {
    mountFilter: 'default',
    hideVirtualFs: true,
    hideParentMounts: true,
  });
  assert.deepEqual(properties['sysmonitor.display'].default, {
    charts: true,
    sparkMinutes: 5,
    tabularNums: true,
    hiddenGroups: { cpu: false, memory: false, disk: false, network: false, gpuSummary: false, gpuCards: false },
    highlightMyGpus: true,
    showGpuPicker: true,
    showGpuUsers: true,
  });
});

test('native title actions distinguish creating a view from moving one', () => {
  const manifest = readJson('package.json');
  assert.equal(manifest.contributes.commands.some((command) => command.command === 'sysmonitor.openEditor' && command.icon === '$(arrow-swap)'), true);
  assert.equal(manifest.contributes.menus['view/title'].some((item) => item.command === 'sysmonitor.openEditor' && item.when === 'view == sysmonitor.panel && sysmonitor.sidebarSshActive && sysmonitor.actionEditorVisible'), true);
  assert.equal(manifest.contributes.commands.some((item) => item.command === 'sysmonitor.openWindow' && item.icon === '$(multiple-windows)'), true);
  assert.equal(manifest.contributes.menus['view/title'].some((item) => item.command === 'sysmonitor.openWindow' && item.when === 'view == sysmonitor.panel && sysmonitor.sidebarSshActive && sysmonitor.actionWindowVisible'), true);
  assert.equal(manifest.contributes.commands.some((item) => item.command === 'sysmonitor.copyToEditor' && item.icon === '$(open-in-product)'), true);
  assert.equal(manifest.contributes.commands.some((item) => item.command === 'sysmonitor.copyToWindow' && item.icon === '$(empty-window)'), true);
  assert.equal(manifest.contributes.commands.some((item) => item.command === 'sysmonitor.editorReturnSidebar' && item.icon === '$(arrow-swap)'), true);
  assert.equal(manifest.contributes.menus['view/title'].some((item) => item.command === 'sysmonitor.copyToEditor' && item.when === 'view == sysmonitor.panel && sysmonitor.sidebarFixedActive && sysmonitor.actionEditorVisible'), true);
  assert.equal(manifest.contributes.menus['view/title'].some((item) => item.command === 'sysmonitor.copyToWindow' && item.when === 'view == sysmonitor.panel && sysmonitor.sidebarFixedActive && sysmonitor.actionWindowVisible'), true);
  assert.equal(manifest.contributes.menus['view/title'].some((item) => item.command === 'sysmonitor.openTerminal' && item.when === 'view == sysmonitor.panel && sysmonitor.sidebarSshActive && sysmonitor.actionTerminalVisible'), true);
  assert.equal(manifest.contributes.menus['view/title'].some((item) => item.command === 'sysmonitor.openRemoteWindow' && item.when === 'view == sysmonitor.panel && sysmonitor.sidebarSshActive && sysmonitor.actionRemoteWindowVisible'), true);
  assert.equal(manifest.contributes.commands.some((item) => item.command === 'sysmonitor.openRemoteWindow' && item.icon === '$(vm-connect)'), true);
  assert.equal(manifest.contributes.menus.commandPalette.some((item) => item.command === 'sysmonitor.openRemoteWindow' && item.when === 'sysmonitor.sidebarSshActive'), true);
  const editorActions = manifest.contributes.menus['editor/title'];
  assert.deepEqual(editorActions.map((item) => item.command), [
    'sysmonitor.editorReturnSidebar', 'sysmonitor.editorMoveWindow', 'sysmonitor.editorTerminal', 'sysmonitor.editorRemoteWindow',
  ]);
  assert.deepEqual(editorActions.map((item) => item.when), [
    'activeWebviewPanelId == sysmonitor.editor && sysmonitor.actionEditorVisible',
    'activeWebviewPanelId == sysmonitor.editor && sysmonitor.actionWindowVisible',
    'activeWebviewPanelId == sysmonitor.editor && sysmonitor.editorSshActive && sysmonitor.actionTerminalVisible',
    'activeWebviewPanelId == sysmonitor.editor && sysmonitor.editorSshActive && sysmonitor.actionRemoteWindowVisible',
  ]);
});

test('development files are excluded from VSIX and runtime assets exist', () => {
  const vscodeIgnore = fs.readFileSync(path.join(projectRoot, '.vscodeignore'), 'utf8').split(/\r?\n/);
  assert.equal(vscodeIgnore.includes('test/'), true);
  assert.equal(vscodeIgnore.includes('scripts/'), true);
  assert.equal(vscodeIgnore.includes('.trash/'), true);
  assert.equal(vscodeIgnore.some((entry) => entry === 'src/' || entry === 'src/**'), false);
  assert.equal(fs.existsSync(path.join(projectRoot, 'src/view/assets/webview.css')), true);
  for (const fileName of WEBVIEW_SCRIPT_FILES) assert.equal(fs.existsSync(path.join(projectRoot, 'src/view/assets', fileName)), true);
});
