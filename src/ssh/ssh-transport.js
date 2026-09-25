'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { expandHome } = require('./ssh-config');
const { executionOptions, timeoutError } = require('../core/collection-context');
const dispatcher = fs.readFileSync(path.join(__dirname, 'dispatcher.sh'), 'utf8');

function shellQuote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }

class SshTransport {
  constructor({ host, configFile = null, spawnProcess = spawn, onState = () => {}, requireLinux = true, shouldReconnect = () => true, retryDelayMilliseconds = 10000 }) {
    if (!host || /[\s\0]/.test(host) || host.startsWith('-')) throw new Error('Invalid SSH host alias');
    Object.assign(this, { host, spawnProcess, onState, requireLinux, shouldReconnect, retryDelayMilliseconds });
    this.configFile = configFile ? expandHome(configFile) : null;
    this.child = null;
    this.connecting = null;
    this.handshake = null;
    this.ready = false;
    this.closed = false;
    this.sequence = 0;
    this.pending = new Map();
    this.buffer = '';
    this.frame = null;
    this.retryAfter = 0;
    this.retryTimer = null;
    this.lastError = null;
    this.sshConnection = null;
    this.prefix = '__SYSMON_' + crypto.randomBytes(12).toString('hex') + '_';
  }

  connect() {
    if (this.closed) return Promise.reject(new Error('SSH transport disposed'));
    if (this.connecting) return this.connecting;
    if (this.ready) return Promise.resolve();
    if (Date.now() < this.retryAfter) return Promise.reject(this.lastError || new Error('SSH reconnect waiting'));
    this.onState('connecting');
    this.connecting = new Promise((resolve, reject) => {
      const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2'];
      if (this.configFile) args.push('-F', this.configFile);
      args.push('--', this.host, 'sh', '-s');
      const child = this.spawnProcess('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.child = child;
      this.buffer = '';
      this.frame = null;
      let stderr = '';
      const timer = setTimeout(() => this.disconnect(timeoutError('SSH connection timed out')), 12000);
      this.handshake = { resolve, reject, timer };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { if (this.child === child) this.receive(chunk); });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
      child.on('error', (error) => { if (this.child === child) this.disconnect(error); });
      child.on('exit', (code) => { if (this.child === child) this.disconnect(new Error(stderr.trim() || 'SSH exited (' + code + ')')); });
      child.stdin.on('error', (error) => { if (this.child === child) this.disconnect(error); });
      child.stdin.write('SYSMON_PREFIX=' + shellQuote(this.prefix) + '; SYSMON_REQUIRE_LINUX=' + (this.requireLinux ? '1' : '0') + '; eval ' + shellQuote(dispatcher) + '\n');
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  retryNow() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAfter = 0;
    this.lastError = null;
    return this.connect();
  }

  receive(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 48 * 1024 * 1024) { this.disconnect(new Error('Invalid SSH response size')); return; }
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, '');
      this.buffer = this.buffer.slice(end + 1);
      if (this.handshake) {
        if (line === this.prefix + 'NONLINUX') {
          const error = new Error('Remote host is not Linux');
          error.code = 'EPLATFORM';
          this.disconnect(error);
          return;
        }
        if (!line.startsWith(this.prefix + 'READY ')) continue;
        const fields = line.slice((this.prefix + 'READY ').length).trim().split(/\s+/);
        const clientPort = Number(fields[1]), serverPort = Number(fields[3]);
        this.sshConnection = fields.length === 4 && Number.isInteger(clientPort) && clientPort > 0 && Number.isInteger(serverPort) && serverPort > 0
          ? { clientIp: fields[0], clientPort, serverIp: fields[2], serverPort } : null;
        const handshake = this.handshake;
        this.handshake = null;
        clearTimeout(handshake.timer);
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.retryAfter = 0;
        this.lastError = null;
        this.ready = true;
        this.onState('connected');
        handshake.resolve();
      } else if (line.startsWith(this.prefix + 'BEGIN ')) {
        const [id, code, limited] = line.slice((this.prefix + 'BEGIN ').length).split(' ').map(Number);
        this.frame = { id, code, limited, lines: [] };
      } else if (this.frame && line === this.prefix + 'END ' + this.frame.id) {
        const frame = this.frame;
        this.frame = null;
        const request = this.pending.get(frame.id);
        if (!request) continue;
        const stdout = Buffer.from(frame.lines[0] || '', 'base64').toString('utf8');
        const stderr = Buffer.from(frame.lines[1] || '', 'base64').toString('utf8');
        if (frame.code === 0 && !frame.limited) request.finish(null, { stdout, stderr });
        else {
          const error = new Error(frame.limited ? 'Command output exceeds limit' : stderr.trim() || stdout.trim() || 'Remote command exited (' + frame.code + ')');
          error.code = frame.limited ? 'EMAXBUFFER' : frame.code === 127 ? 'ENOENT' : 'EREMOTE';
          error.stderr = stderr;
          request.finish(error);
        }
      } else if (this.frame) this.frame.lines.push(line);
    }
  }

  async execFile(command, args = [], options = {}) {
    options = executionOptions(options);
    await this.connect();
    options = executionOptions(options);
    const timeoutMilliseconds = Number.isFinite(options.timeoutMilliseconds) ? options.timeoutMilliseconds : 10000;
    const maxBufferBytes = options.maxBufferBytes || 4 * 1024 * 1024;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      let timer;
      const cancel = (error) => {
        if (this.ready && this.child) this.child.stdin.write('CANCEL ' + id + '\n');
        finish(error);
      };
      const onAbort = () => cancel(options.signal.reason || new Error('SSH command cancelled'));
      const finish = (error, result) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        if (options.signal) options.signal.removeEventListener('abort', onAbort);
        error ? reject(error) : resolve(result);
      };
      this.pending.set(id, { finish });
      if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => cancel(timeoutError('Command timed out: ' + command)), timeoutMilliseconds);
      const invocation = 'exec env LC_ALL=C ' + [command, ...args].map(shellQuote).join(' ');
      const payload = Buffer.from(invocation).toString('base64');
      this.child.stdin.write('RUN ' + id + ' ' + maxBufferBytes + ' ' + payload + '\n');
    });
  }

  readFile(file, encoding) {
    if (encoding !== 'utf8') return Promise.reject(new Error('Only UTF-8 remote files are supported'));
    return this.execFile('cat', [file]).then(({ stdout }) => stdout);
  }

  disconnect(error) {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.sshConnection = null;
    if (child) {
      child.stdin.end('QUIT\n');
      const timer = setTimeout(() => child.kill(), 1000);
      timer.unref();
      child.once('exit', () => clearTimeout(timer));
    }
    if (this.handshake) {
      clearTimeout(this.handshake.timer);
      this.handshake.reject(error);
      this.handshake = null;
    }
    for (const request of this.pending.values()) request.finish(error);
    this.buffer = '';
    this.frame = null;
    if (!this.closed) {
      this.retryAfter = error && error.code === 'EPLATFORM' ? Infinity : Date.now() + this.retryDelayMilliseconds;
      this.lastError = error;
      this.onState('disconnected', error);
      if (Number.isFinite(this.retryAfter)) this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (!this.closed && this.shouldReconnect()) this.connect().catch(() => {});
      }, Math.max(0, this.retryAfter - Date.now()));
    }
  }

  dispose() {
    this.closed = true;
    this.disconnect(new Error('SSH transport disposed'));
  }
}

module.exports = { SshTransport, shellQuote };
