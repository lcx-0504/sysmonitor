'use strict';

const { execFile } = require('node:child_process');

class CommandRunner {
  constructor({ defaultTimeoutMilliseconds = 5000, maxBufferBytes = 4 * 1024 * 1024 } = {}) {
    this.defaultTimeoutMilliseconds = defaultTimeoutMilliseconds;
    this.maxBufferBytes = maxBufferBytes;
    this.children = new Set();
  }

  execFile(command, args = [], options = {}) {
    const timeout = options.timeoutMilliseconds || this.defaultTimeoutMilliseconds;
    return new Promise((resolve, reject) => {
      const child = execFile(command, args, {
        timeout,
        maxBuffer: options.maxBufferBytes || this.maxBufferBytes,
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', ...(options.env || {}) },
      }, (error, stdout, stderr) => {
        this.children.delete(child);
        if (error) {
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
      this.children.add(child);
    });
  }

  dispose() {
    for (const child of this.children) child.kill();
    this.children.clear();
  }
}

module.exports = { CommandRunner };
