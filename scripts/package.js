'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { name, version } = require('../package.json');
const projectRoot = path.resolve(__dirname, '..');
const releaseDirectory = path.join(projectRoot, 'release');

fs.mkdirSync(releaseDirectory, { recursive: true });
const output = process.argv[2] || path.join('release', `${name}-${version}.vsix`);
const result = spawnSync('vsce', ['package', '--out', output], {
  cwd: projectRoot,
  stdio: 'inherit',
});
if (result.error) process.stderr.write(`${result.error.message}\n`);
process.exit(result.status ?? 1);
