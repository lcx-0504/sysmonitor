'use strict';

const { expandHome } = require('../ssh/ssh-config');

const SESSION_TYPES = ['tmux', 'screen'];

function sshConfigArguments(configFile) {
  return configFile ? ['-F', expandHome(configFile)] : [];
}

function openSshTerminal(vscode, host, configFile) {
  const terminal = vscode.window.createTerminal({ name: `SSH: ${host}`, shellPath: 'ssh', shellArgs: [...sshConfigArguments(configFile), host] });
  terminal.show();
  return terminal;
}

function quoteShellArgument(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function quoteRemoteShellArgument(value) {
  return `'${String(value).replace(/['\\!]/g, (character) => `'\\${character}'`)}'`;
}

function processSession(viewModel, pid) {
  if (!viewModel || !Array.isArray(viewModel.processes) || !Number.isInteger(pid)) return null;
  const row = viewModel.processes.find((process) => process && process.pid === pid);
  const session = row && row.session;
  if (!session || !SESSION_TYPES.includes(session.type)) return null;
  if (typeof session.name !== 'string' || typeof session.id !== 'string' || !session.id) return null;
  if (/[\0\r\n]/.test(session.name + session.id)) return null;
  return { type: session.type, name: session.name, id: session.id };
}

function sessionAttachCommand(session) {
  if (session.type === 'tmux') {
    const target = quoteShellArgument('=' + session.id);
    return `tmux has-session -t ${target} 2>/dev/null && tmux attach-session -t ${target}`;
  }
  return `screen -x ${quoteShellArgument(session.id)}`;
}

function sessionTerminalScript(session, failureMessage) {
  return `unset TMUX TMUX_PANE; ${sessionAttachCommand(session)} || printf '%s\\n' ${quoteShellArgument(failureMessage)}; exec "\${SHELL:-/bin/sh}" -l`;
}

function sessionTerminalName(session, host = null) {
  const name = `${session.type}: ${session.name}`;
  return host ? `${host} · ${name}` : name;
}

function sessionTerminalOptions(session, { failureMessage, host = null, configFile = null }) {
  const script = sessionTerminalScript(session, failureMessage);
  const name = sessionTerminalName(session, host);
  if (!host) return { name, shellPath: '/bin/sh', shellArgs: ['-c', script], env: { TMUX: null, TMUX_PANE: null } };
  return { name, shellPath: 'ssh', shellArgs: [...sshConfigArguments(configFile), '-t', host, `sh -c ${quoteRemoteShellArgument(script)}`] };
}

function openSessionTerminal(vscode, session, options) {
  const terminal = vscode.window.createTerminal(sessionTerminalOptions(session, options));
  terminal.show();
  return terminal;
}

module.exports = {
  openSshTerminal, openSessionTerminal, processSession, sessionTerminalOptions, sessionTerminalScript,
  quoteShellArgument, quoteRemoteShellArgument,
};
