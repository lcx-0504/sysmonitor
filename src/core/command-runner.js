'use strict';

const { spawn } = require('node:child_process');
const { COLLECTION_ENV, executionOptions, timeoutError } = require('./collection-context');
const { COMMAND_OUTPUT_LIMIT_BYTES, DEFAULT_COMMAND_TIMEOUT_MILLISECONDS } = require('./execution-defaults');

const PROCESS_GROUPS = process.platform !== 'win32';
const activeChildren = new Set();
let exitHandlerInstalled = false;

function terminate(child) {
  if (PROCESS_GROUPS && child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch (error) {
      if (error.code === 'ESRCH') return;
    }
  }
  child.kill('SIGKILL');
}

function trackChild(child) {
  activeChildren.add(child);
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.once('exit', () => { for (const active of activeChildren) terminate(active); });
}

class CommandRunner {
  constructor({ defaultTimeoutMilliseconds = DEFAULT_COMMAND_TIMEOUT_MILLISECONDS, maxBufferBytes = COMMAND_OUTPUT_LIMIT_BYTES } = {}) {
    this.defaultTimeoutMilliseconds = defaultTimeoutMilliseconds;
    this.maxBufferBytes = maxBufferBytes;
    this.children = new Set();
    this.closed = false;
  }

  execFile(command, args = [], options = {}) {
    if (this.closed) return Promise.reject(new Error('Command runner disposed'));
    try { options = executionOptions(options); } catch (error) { return Promise.reject(error); }
    const timeout = Number.isFinite(options.timeoutMilliseconds) ? options.timeoutMilliseconds : this.defaultTimeoutMilliseconds;
    const limit = options.maxBufferBytes || this.maxBufferBytes;
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(command, args, { detached: PROCESS_GROUPS, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...COLLECTION_ENV, ...(options.env || {}) } });
      } catch (error) {
        reject(error);
        return;
      }
      const output = { stdout: { text: '', bytes: 0 }, stderr: { text: '', bytes: 0 } };
      let failure = null;
      let inputError = null;
      let settled = false;
      const stop = (error) => {
        failure ||= error;
        terminate(child);
      };
      const onAbort = () => stop(options.signal.reason || new Error('Command cancelled'));
      const timer = setTimeout(() => stop(timeoutError('Command timed out: ' + command)), timeout);
      const finish = (error, exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (options.signal) options.signal.removeEventListener('abort', onAbort);
        this.children.delete(child);
        activeChildren.delete(child);
        const stdout = output.stdout.text;
        const stderr = output.stderr.text;
        if (failure || error) {
          reject(Object.assign(failure || error, { stderr }));
          return;
        }
        if (exitCode !== 0) {
          const status = signal ? 'Command terminated (' + signal + ')' : 'Command exited (' + exitCode + ')';
          reject(Object.assign(new Error(stderr.trim() || status), { code: exitCode, exitCode, signal, stderr }));
          return;
        }
        if (inputError) {
          reject(inputError);
          return;
        }
        resolve({ stdout, stderr });
      };
      for (const stream of ['stdout', 'stderr']) {
        child[stream].setEncoding('utf8');
        child[stream].on('data', (chunk) => {
          if (failure) return;
          const target = output[stream];
          target.text += chunk;
          target.bytes += Buffer.byteLength(chunk);
          if (target.bytes > limit) stop(Object.assign(new Error('Command output exceeds limit'), { code: 'EMAXBUFFER' }));
        });
      }
      child.once('error', (error) => finish(error));
      child.once('close', (exitCode, signal) => finish(null, exitCode, signal));
      if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') inputError = error; });
      child.stdin.end(options.input);
      this.children.add(child);
      trackChild(child);
    });
  }

  dispose() {
    this.closed = true;
    for (const child of this.children) terminate(child);
    this.children.clear();
  }
}

module.exports = { CommandRunner };
