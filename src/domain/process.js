'use strict';

function parseProcessName(commandLine) {
  const normalizedCommandLine = typeof commandLine === 'string' ? commandLine.trim() : '';
  if (!normalizedCommandLine) return '';

  if (normalizedCommandLine.startsWith('[') && normalizedCommandLine.endsWith(']')) {
    return normalizedCommandLine;
  }

  const executable = normalizedCommandLine.split(/\s+/, 1)[0];
  const pathParts = executable.split('/');
  return pathParts[pathParts.length - 1] || executable;
}

module.exports = { parseProcessName };
