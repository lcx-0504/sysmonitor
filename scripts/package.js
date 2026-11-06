'use strict';
// Packages the extension: `node scripts/package.js [output path]`. Uses vsce from PATH when it is
// installed and otherwise runs @vscode/vsce through npx.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { name, version } = require('../package.json');

const projectRoot = path.resolve(__dirname, '..');
const releaseDirectory = path.join(projectRoot, 'release');
const isWindows = process.platform === 'win32';

function isExecutableFile(file) {
  try {
    fs.accessSync(file, isWindows ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isOnPath(command) {
  const extensions = isWindows ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  const directories = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return directories.some((directory) => extensions.some((extension) => isExecutableFile(path.join(directory, command + extension))));
}

function quoteForCmd(argument) {
  return /^[\w@+=:,./\\-]+$/.test(argument) ? argument : `"${argument}"`;
}

// npm installs vsce and npx as .cmd shims on Windows, which only a shell can start.
function run(command, args) {
  const options = { cwd: projectRoot, stdio: 'inherit' };
  if (!isWindows) return spawnSync(command, args, options);
  return spawnSync([command, ...args].map(quoteForCmd).join(' '), { ...options, shell: true });
}

fs.mkdirSync(releaseDirectory, { recursive: true });
const output = process.argv[2] || path.join('release', `${name}-${version}.vsix`);
const packageArgs = ['package', '--out', output];
let result;
if (isOnPath('vsce')) {
  result = run('vsce', packageArgs);
} else {
  process.stderr.write('vsce was not found on PATH; running @vscode/vsce through npx.\n');
  result = run('npx', ['--yes', '@vscode/vsce', ...packageArgs]);
}
if (result.error) process.stderr.write(`${result.error.message}\n`);
process.exit(result.status ?? 1);
