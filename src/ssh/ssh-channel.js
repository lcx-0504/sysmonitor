'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { COLLECTION_ENV, timeoutError } = require('../core/collection-context');
const dispatcher = fs.readFileSync(path.join(__dirname, 'dispatcher.sh'), 'utf8');

function shellQuote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }

class SshChannel {
  constructor({ host, configFile, spawnProcess, requireLinux, onClose, onExit = () => {}, onInterrupted = () => {} }) {
    Object.assign(this, { host, configFile, spawnProcess, requireLinux, onClose, onExit, onInterrupted });
    this.prefix = '__SYSMON_' + crypto.randomBytes(12).toString('hex') + '_';
    this.ready = false;
    this.closed = false;
    this.exited = false;
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    this.request = null;
    this.connection = null;
    this.startup = { stdout: '', stderr: '' };
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.handshake = { resolve, reject };
      this.timer = setTimeout(() => this.close(timeoutError('SSH connection timed out')), 12000);
      const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2'];
      if (this.configFile) args.push('-F', this.configFile);
      args.push('--', this.host, 'sh', '-s');
      try {
        this.child = this.spawnProcess('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (error) { this.close(error); return; }
      const child = this.child;
      for (const stream of ['stdout', 'stderr']) {
        child[stream].setEncoding('utf8');
        child[stream].on('data', (chunk) => this.receive(stream, chunk));
      }
      child.on('error', (error) => { this.close(error); if (!child.pid) this.markExited(); });
      child.on('exit', (code) => {
        this.close(new Error(this.startup.stderr.trim() || 'SSH exited (' + code + ')'));
        this.markExited();
      });
      child.once('close', () => this.markExited());
      child.stdin.on('error', (error) => this.close(error));
      child.stdin.write('SYSMON_PREFIX=' + shellQuote(this.prefix) + '; SYSMON_REQUIRE_LINUX=' + (this.requireLinux ? '1' : '0') + '; eval ' + shellQuote(dispatcher) + '\n');
    });
  }

  receive(stream, chunk) {
    if (this.closed) return;
    if (!this.ready) {
      this.startup[stream] = (this.startup[stream] + chunk).slice(-16000);
      if (stream !== 'stdout') return;
      if (this.startup.stdout.includes(this.prefix + 'NONLINUX\n')) {
        this.close(Object.assign(new Error('Remote host is not Linux'), { code: 'EPLATFORM' }));
        return;
      }
      const match = this.startup.stdout.match(new RegExp(this.prefix + 'READY ([^\n]*)\n'));
      if (!match) return;
      const fields = match[1].trim().split(/\s+/);
      if (fields.length === 4 && Number(fields[1]) > 0 && Number(fields[3]) > 0) {
        this.connection = { clientIp: fields[0], clientPort: Number(fields[1]), serverIp: fields[2], serverPort: Number(fields[3]) };
      }
      this.ready = true;
      clearTimeout(this.timer);
      const handshake = this.handshake;
      this.handshake = null;
      handshake.resolve();
      return;
    }
    const request = this.request;
    if (!request) return;
    const output = request[stream];
    output.text += chunk;
    output.bytes += Buffer.byteLength(chunk);
    if (stream === 'stdout' && !request.started) {
      const newline = output.text.indexOf('\n');
      if (newline < 0) {
        if (output.bytes > 512) this.close(new Error('Invalid SSH process header'));
        return;
      }
      const start = this.prefix + 'START ' + request.id + ' ';
      const header = output.text.slice(0, newline);
      if (!header.startsWith(start)) { this.close(new Error('Invalid SSH process header')); return; }
      const [pid, startTime, bootId] = header.slice(start.length).split(' ');
      if (/^[1-9]\d*$/.test(pid) && /^\d+$/.test(startTime) && /^[a-f\d-]+$/.test(bootId)) {
        request.remoteProcess = { pid: Number(pid), startTime, bootId };
      }
      request.started = true;
      output.text = output.text.slice(newline + 1);
      output.bytes = Buffer.byteLength(output.text);
    }
    const marker = '\n' + this.prefix + 'END ' + request.id + ' ';
    const at = output.text.indexOf(marker);
    const end = at < 0 ? -1 : output.text.indexOf('\n', at + marker.length);
    if (end >= 0) {
      const code = output.text.slice(at + marker.length, end);
      if (!/^\d+$/.test(code)) { this.close(new Error('Invalid SSH response')); return; }
      output.code = Number(code);
      output.text = output.text.slice(0, at);
      output.bytes = Buffer.byteLength(output.text);
    }
    if (output.bytes > request.limit + (end < 0 ? marker.length + 20 : 0)) {
      this.close(Object.assign(new Error('Command output exceeds limit'), { code: 'EMAXBUFFER' }), true);
      return;
    }
    if (request.stdout.code === null || request.stderr.code === null) return;
    if (request.stdout.code !== request.stderr.code) { this.close(new Error('Invalid SSH exit status')); return; }
    this.request = null;
    const stdout = request.stdout.text, stderr = request.stderr.text, code = request.stdout.code;
    if (code === 0) request.resolve({ stdout, stderr });
    else request.reject(Object.assign(new Error(stderr.trim() || stdout.trim() || 'Remote command exited (' + code + ')'), {
      code: code === 127 ? 'ENOENT' : 'EREMOTE', stderr,
    }));
  }

  execFile(id, command, args, limit, trackProcess = true) {
    return new Promise((resolve, reject) => {
      if (!this.ready || this.closed || this.request) { reject(new Error('SSH channel unavailable')); return; }
      this.request = { id, limit, resolve, reject, trackProcess, started: false,
        stdout: { text: '', bytes: 0, code: null }, stderr: { text: '', bytes: 0, code: null } };
      const environment = Object.entries(COLLECTION_ENV).map(([key, value]) => key + '=' + shellQuote(value)).join(' ');
      const invocation = 'exec env ' + environment + ' ' + [command, ...args].map(shellQuote).join(' ');
      this.child.stdin.write('RUN ' + id + ' ' + Buffer.from(invocation).toString('base64') + '\n');
    });
  }

  close(error, intentional = false) {
    if (this.closed) return;
    const wasReady = this.ready;
    this.closed = true;
    this.ready = false;
    clearTimeout(this.timer);
    const interrupted = this.request && this.request.trackProcess && this.request.remoteProcess;
    if (this.handshake) { this.handshake.reject(error); this.handshake = null; }
    if (this.request) { this.request.reject(error); this.request = null; }
    const child = this.child;
    if (interrupted && child) {
      const report = () => this.onInterrupted(interrupted);
      if (child.exitCode !== null || child.signalCode !== null) report();
      else child.once('exit', report);
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin.end('QUIT\n');
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      }, 1000);
      timer.unref();
      child.once('exit', () => clearTimeout(timer));
    }
    this.onClose(this, error, intentional, wasReady);
    if (!child || child.exitCode !== null || child.signalCode !== null) this.markExited();
  }

  markExited() {
    if (this.exited) return;
    this.exited = true;
    this.resolveExit();
    this.onExit(this);
  }
}

module.exports = { SshChannel };
