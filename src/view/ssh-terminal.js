'use strict';

const { expandHome } = require('../ssh/ssh-config');

function openSshTerminal(vscode, host, configFile) {
  const args = configFile ? ['-F', expandHome(configFile), host] : [host];
  const terminal = vscode.window.createTerminal({ name: `SSH: ${host}`, shellPath: 'ssh', shellArgs: args });
  terminal.show();
  return terminal;
}

module.exports = { openSshTerminal };
