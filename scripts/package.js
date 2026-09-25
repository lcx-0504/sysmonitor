'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { name, version } = require('../package.json');
const projectRoot = path.resolve(__dirname, '..');
const releaseDirectory = path.join(projectRoot, 'release');

fs.mkdirSync(releaseDirectory, { recursive: true });
const result = spawnSync('vsce', ['package', '--out', path.join('release', `${name}-${version}.vsix`)], {
  cwd: projectRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.error) process.stderr.write(`${result.error.message}\n`);
process.exit(result.status ?? 1);
