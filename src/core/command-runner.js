'use strict';

const { execFile } = require('node:child_process');
const { COLLECTION_ENV, executionOptions, timeoutError } = require('./collection-context');

class CommandRunner {
  constructor({ defaultTimeoutMilliseconds = 5000, maxBufferBytes = 4 * 1024 * 1024 } = {}) {
    this.defaultTimeoutMilliseconds = defaultTimeoutMilliseconds;
    this.maxBufferBytes = maxBufferBytes;
    this.children = new Set();
    this.closed = false;
  }

  execFile(command, args = [], options = {}) {
    if (this.closed) return Promise.reject(new Error('Command runner disposed'));
    try { options = executionOptions(options); } catch (error) { return Promise.reject(error); }
    const timeout = Number.isFinite(options.timeoutMilliseconds) ? options.timeoutMilliseconds : this.defaultTimeoutMilliseconds;
    return new Promise((resolve, reject) => {
      const child = execFile(command, args, {
        timeout,
        maxBuffer: options.maxBufferBytes || this.maxBufferBytes,
        encoding: 'utf8',
        signal: options.signal,
        killSignal: 'SIGKILL',
        env: { ...process.env, ...COLLECTION_ENV, ...(options.env || {}) },
      }, (error, stdout, stderr) => {
        this.children.delete(child);
        if (options.signal && options.signal.aborted) { reject(options.signal.reason || error); return; }
        if (error) {
          if (error.killed && error.signal === 'SIGKILL' && !error.code) error = timeoutError('Command timed out: ' + command);
          if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') error = Object.assign(new Error('Command output exceeds limit'), { code: 'EMAXBUFFER' });
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
    this.closed = true;
    for (const child of this.children) child.kill();
    this.children.clear();
  }
}

module.exports = { CommandRunner };
