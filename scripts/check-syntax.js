'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const projectRoot = path.resolve(__dirname, '..');
const SHELL_SCRIPTS = ['src/collectors/process-snapshot.sh', 'src/ssh/dispatcher.sh'];
// sh is required; dash and bash are optional extra parsers, since the scripts run under whichever sh the remote host has.
const SHELL_PARSERS = [{ command: 'sh', required: true }, { command: 'dash' }, { command: 'bash' }];

function listJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listJavaScriptFiles(absolutePath);
    return entry.isFile() && /\.(?:js|mjs)$/.test(entry.name) ? [absolutePath] : [];
  });
}

function fail(result) {
  process.stderr.write(result.stderr || result.stdout || `${result.error ? result.error.message : 'unknown error'}\n`);
  process.exit(result.status || 1);
}

function checkJavaScript() {
  const sourceFiles = [
    path.join(projectRoot, 'extension.js'),
    ...['src', 'test', 'scripts'].flatMap((directory) => listJavaScriptFiles(path.join(projectRoot, directory))),
  ];
  for (const filePath of sourceFiles) {
    const result = spawnSync(process.execPath, ['--check', filePath], { encoding: 'utf8' });
    if (result.status !== 0) fail(result);
  }
}

function checkShellSyntax() {
  for (const { command, required } of SHELL_PARSERS) {
    for (const script of SHELL_SCRIPTS) {
      const result = spawnSync(command, ['-n', script], { cwd: projectRoot, encoding: 'utf8' });
      if (result.error && result.error.code === 'ENOENT') {
        if (!required) break;
        process.stderr.write(`${command} is required to check ${script}, but it was not found.\n`);
        process.exit(1);
      }
      if (result.status !== 0) {
        process.stderr.write(`${command} -n ${script} failed:\n`);
        fail(result);
      }
    }
  }
}

// shellcheck is optional: when it is installed its findings are reported without failing the check.
function runShellcheck() {
  const result = spawnSync('shellcheck', ['--shell=sh', ...SHELL_SCRIPTS], { cwd: projectRoot, encoding: 'utf8' });
  if (result.error && result.error.code === 'ENOENT') return;
  if (result.error) {
    process.stderr.write(`shellcheck could not run: ${result.error.message}\n`);
    return;
  }
  if (result.status !== 0) process.stdout.write(`shellcheck reported findings:\n${result.stdout}${result.stderr}`);
}

checkJavaScript();
checkShellSyntax();
runShellcheck();
