'use strict';

const { execFile, spawn } = require('node:child_process');
const { COLLECTION_ENV, executionOptions, timeoutError } = require('./collection-context');
const { COMMAND_OUTPUT_LIMIT_BYTES, DEFAULT_COMMAND_TIMEOUT_MILLISECONDS } = require('./execution-defaults');

const TIMEOUT_EXIT_CODES = new Set([124, 137]);
const COMMAND_NOT_FOUND_EXIT_CODE = 127;
let timeoutProbe = null;

// Same check as the SSH dispatcher: a GNU-compatible timeout exits with 124 when its own limit expires.
function probeTimeoutUtility() {
  if (process.platform === 'win32') return Promise.resolve(false);
  timeoutProbe ||= new Promise((resolve) => {
    execFile('timeout', ['-k', '1', '0.01', 'sleep', '1'], { windowsHide: true }, (error) => resolve(!!error && error.code === 124));
  });
  return timeoutProbe;
}

class CommandRunner {
  constructor({ defaultTimeoutMilliseconds = DEFAULT_COMMAND_TIMEOUT_MILLISECONDS, maxBufferBytes = COMMAND_OUTPUT_LIMIT_BYTES,
    timeoutUtility = probeTimeoutUtility } = {}) {
    this.defaultTimeoutMilliseconds = defaultTimeoutMilliseconds;
    this.maxBufferBytes = maxBufferBytes;
    this.timeoutUtility = timeoutUtility;
    this.children = new Map();
    this.closed = false;
  }

  async execFile(command, args = [], options = {}) {
    if (this.closed) throw new Error('Command runner disposed');
    options = executionOptions(options);
    const supervised = await this.timeoutUtility();
    if (this.closed) throw new Error('Command runner disposed');
    if (options.signal && options.signal.aborted) throw options.signal.reason || new Error('Command cancelled');
    const timeout = Number.isFinite(options.timeoutMilliseconds) ? options.timeoutMilliseconds : this.defaultTimeoutMilliseconds;
    return this.run(command, args, options, timeout, supervised);
  }

  run(command, args, options, timeout, supervised) {
    const limit = options.maxBufferBytes || this.maxBufferBytes;
    const file = supervised ? 'timeout' : command;
    const fileArgs = supervised ? ['-k', '1', String(timeout / 1000), command, ...args] : args;
    // A supervising timeout forwards SIGTERM to the whole command; without it only the direct child can be stopped.
    const stopSignal = supervised ? 'SIGTERM' : 'SIGKILL';
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(file, fileArgs, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
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
        child.kill(stopSignal);
      };
      const onAbort = () => stop(options.signal.reason || new Error('Command cancelled'));
      const timer = setTimeout(() => stop(timeoutError('Command timed out: ' + command)), timeout);
      const finish = (error, exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (options.signal) options.signal.removeEventListener('abort', onAbort);
        this.children.delete(child);
        const stdout = output.stdout.text;
        const stderr = output.stderr.text;
        if (failure || error) {
          reject(Object.assign(failure || error, { stderr }));
          return;
        }
        if (supervised && TIMEOUT_EXIT_CODES.has(exitCode)) {
          reject(Object.assign(timeoutError('Command timed out: ' + command), { exitCode, stderr }));
          return;
        }
        if (exitCode !== 0) {
          const status = signal ? 'Command terminated (' + signal + ')' : 'Command exited (' + exitCode + ')';
          const code = exitCode === COMMAND_NOT_FOUND_EXIT_CODE ? 'ENOENT' : exitCode;
          reject(Object.assign(new Error(stderr.trim() || status), { code, exitCode, signal, stderr }));
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
      this.children.set(child, stop);
    });
  }

  dispose() {
    this.closed = true;
    for (const stop of this.children.values()) stop(new Error('Command runner disposed'));
    this.children.clear();
  }
}

module.exports = { CommandRunner };
