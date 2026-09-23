'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), 'utf8'));

test('extension manifest points to an existing CommonJS entry point', () => {
  const manifest = readJson('package.json');
  const entryPath = path.resolve(projectRoot, manifest.main);
  assert.equal(fs.existsSync(entryPath), true);
  const source = fs.readFileSync(entryPath, 'utf8');
  assert.match(source, /module\.exports\s*=\s*require\('\.\/src\/extension'\)/);
  const implementation = fs.readFileSync(path.join(projectRoot, 'src/extension.js'), 'utf8');
  assert.match(implementation, /module\.exports\s*=\s*\{\s*activate,\s*deactivate\s*\}/);
});

test('English and Chinese package localization expose the same keys', () => {
  const english = readJson('package.nls.json');
  const chinese = readJson('package.nls.zh-cn.json');
  assert.deepEqual(Object.keys(chinese).sort(), Object.keys(english).sort());
});

test('public configuration defaults remain characterized', () => {
  const manifest = readJson('package.json');
  const properties = manifest.contributes.configuration.properties;

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
    hideParentMounts: true,
  });
  assert.deepEqual(properties['sysmonitor.display'].default, {
    charts: true,
    sparkMinutes: 5,
    tabularNums: true,
    hiddenGroups: { system: false, disk: false, network: false, gpuSummary: false, gpuCards: false },
    highlightMyGpus: true,
    showGpuPicker: true,
    showGpuUsers: true,
  });
});

test('Editor pop-out action is contributed to the native view title', () => {
  const manifest = readJson('package.json');
  assert.equal(manifest.contributes.commands.some((command) => command.command === 'sysmonitor.openEditor' && command.icon === '$(open-in-product)'), true);
  assert.equal(manifest.contributes.menus['view/title'].some((item) => item.command === 'sysmonitor.openEditor' && item.when === 'view == sysmonitor.panel'), true);
});

test('development-only refactor documents and tests are excluded from VSIX', () => {
  const vscodeIgnore = fs.readFileSync(path.join(projectRoot, '.vscodeignore'), 'utf8').split(/\r?\n/);
  assert.equal(vscodeIgnore.includes('test/'), true);
  assert.equal(vscodeIgnore.includes('REFACTOR.md'), true);
  assert.equal(vscodeIgnore.includes('REFACTOR_CHECKLIST.md'), true);
  assert.equal(vscodeIgnore.some((entry) => entry === 'src/' || entry === 'src/**'), false);
  assert.equal(fs.existsSync(path.join(projectRoot, 'src/view/assets/webview.css')), true);
  assert.equal(fs.existsSync(path.join(projectRoot, 'src/view/assets/webview.js')), true);
});

test('Webview resets topology keys on empty GPU results and restores translucent zero-percent tags', () => {
  const script = fs.readFileSync(path.join(projectRoot, 'src/view/assets/webview.js'), 'utf8');
  const style = fs.readFileSync(path.join(projectRoot, 'src/view/assets/webview.css'), 'utf8');
  assert.match(script, /gpuBody\.innerHTML = '';\s*renderedAcceleratorKeys = \[\];/);
  assert.match(script, /pct >= 70 \? ' tag-warn' : ' tag-accent'/);
  assert.match(style, /\.gpu-tag\.tag-accent[^}]*transparent/);
  assert.match(script, /function sendToExtension\(/);
  assert.doesNotMatch(script, /function postMessage\(/);
});
