'use strict';

function resourceCommandFiles(command) {
  return [...command.matchAll(/cat '([^']+)'/g)].map(match => match[1]);
}

function resourceCommandRunner(readFile, { uptime } = {}) {
  let seconds = 100;
  const runner = {
    commands: [],
    async execFile(command, args) {
      if (command !== 'sh' || args[0] !== '-c') throw new Error('Unexpected resource command: ' + command);
      runner.commands.push(args[1]);
      const files = resourceCommandFiles(args[1]);
      let stdout = '';
      for (const [index, file] of files.entries()) {
        let text;
        try { text = await readFile(file); }
        catch (error) {
          if (file !== '/proc/net/route') throw error;
          text = '';
        }
        stdout += '__SYSMON_RESOURCE_' + index + '__\n' + (text ?? '') + '\n';
      }
      const at = uptime ? uptime() : (seconds += 1);
      return { stdout: stdout + '__SYSMON_RESOURCE_' + files.length + '__\n' + at.toFixed(2) + ' ' + at.toFixed(2) + '\n' };
    },
    dispose() {},
  };
  return runner;
}

module.exports = { resourceCommandFiles, resourceCommandRunner };
