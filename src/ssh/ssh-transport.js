'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { expandHome } = require('./ssh-config');

function shellQuote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }

class SshTransport {
  constructor({ host, configFile = null, spawnProcess = spawn, onState = () => {}, requireLinux = true, shouldReconnect = () => true, retryDelayMilliseconds = 10000 }) {
    if (!host || /[\s\0]/.test(host) || host.startsWith('-')) throw new Error('Invalid SSH host alias');
    this.host = host;
    this.configFile = configFile ? expandHome(configFile) : null;
    this.spawnProcess = spawnProcess;
    this.onState = onState;
    this.requireLinux = requireLinux;
    this.shouldReconnect = shouldReconnect;
    this.retryDelayMilliseconds = retryDelayMilliseconds;
    this.child = null;
    this.buffer = '';
    this.waiting = null;
    this.queue = [];
    this.connecting = null;
    this.closed = false;
    this.sequence = 0;
    this.retryAfter = 0;
    this.retryTimer = null;
    this.lastError = null;
    this.sshConnection = null;
    this.prefix = '__SYSMON_' + crypto.randomBytes(12).toString('hex') + '_';
  }

  async connect() {
    if (this.closed) throw new Error('SSH transport disposed');
    if (Date.now() < this.retryAfter) throw this.lastError || new Error('SSH reconnect waiting');
    if (this.connecting) return this.connecting;
    if (this.child) return;
    this.onState('connecting');
    this.connecting = new Promise((resolve, reject) => {
      const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2'];
      if (this.configFile) args.push('-F', this.configFile);
      args.push('--', this.host, 'sh', '-s');
      const child = this.spawnProcess('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.child = child;
      this.buffer = '';
      let stderr = '';
      const timeout = setTimeout(() => this.disconnect(new Error('SSH connection timed out')), 12000);
      this.waiting = { kind: 'connect', resolve: () => { clearTimeout(timeout); if (this.retryTimer) clearTimeout(this.retryTimer); this.retryTimer = null; this.retryAfter = 0; this.lastError = null; this.onState('connected'); resolve(); }, reject: (error) => { clearTimeout(timeout); reject(error); } };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this.receive(chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
      child.on('error', (error) => { if (this.child === child) this.disconnect(error); });
      child.on('exit', (code) => { if (this.child === child) this.disconnect(new Error(stderr.trim() || `SSH exited (${code})`)); });
      child.stdin.on('error', () => {});
      child.stdin.write(this.requireLinux
        ? `if [ "$(uname -s)" = Linux ]; then printf '%s %s\\n' '${this.prefix}READY' "$SSH_CONNECTION"; else printf '%s\\n' '${this.prefix}NONLINUX'; exit 65; fi\n`
        : `printf '%s %s\\n' '${this.prefix}READY' "$SSH_CONNECTION"\n`);
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  retryNow() {
    if (this.closed) return Promise.reject(new Error('SSH transport disposed'));
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAfter = 0;
    this.lastError = null;
    return this.connect();
  }

  receive(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 40 * 1024 * 1024) { this.disconnect(new Error('SSH response too large')); return; }
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, '');
      this.buffer = this.buffer.slice(end + 1);
      const waiting = this.waiting;
      if (!waiting) continue;
      if (waiting.kind === 'connect' && (line === this.prefix + 'READY' || line.startsWith(this.prefix + 'READY '))) {
        const fields = line.slice((this.prefix + 'READY').length).trim().split(/\s+/);
        const clientPort = Number(fields[1]); const serverPort = Number(fields[3]);
        this.sshConnection = fields.length === 4 && Number.isInteger(clientPort) && clientPort > 0 && Number.isInteger(serverPort) && serverPort > 0
          ? { clientIp: fields[0], clientPort, serverIp: fields[2], serverPort }
          : null;
        this.waiting = null; waiting.resolve(); this.drain();
      }
      else if (waiting.kind === 'connect' && line === this.prefix + 'NONLINUX') {
        const error = new Error('Remote host is not Linux');
        error.code = 'EPLATFORM';
        this.disconnect(error);
      }
      else if (waiting.kind === 'command') {
        if (line === this.prefix + 'BEGIN_' + waiting.id) waiting.lines = [];
        else if (line.startsWith(this.prefix + 'END_' + waiting.id + '_')) {
          this.waiting = null;
          clearTimeout(waiting.timeout);
          const code = Number(line.slice((this.prefix + 'END_' + waiting.id + '_').length));
          const stdout = Buffer.from(waiting.lines.join(''), 'base64').toString('utf8');
          if (code === 0) waiting.resolve({ stdout, stderr: '' });
          else { const error = new Error(stdout.trim() || `Remote command exited (${code})`); error.code = code === 127 ? 'ENOENT' : 'EREMOTE'; waiting.reject(error); }
          this.drain();
        } else if (waiting.lines) waiting.lines.push(line);
      }
    }
  }

  async drain() {
    if (this.closed || this.waiting || this.queue.length === 0) return;
    try { await this.connect(); } catch (error) {
      for (const next of this.queue.splice(0)) next.reject(error);
      return;
    }
    if (this.waiting || !this.child) return;
    let next = this.queue.shift();
    while (next && next.deadline - Date.now() < Math.min(2000, Math.max(1000, next.timeoutMilliseconds / 4))) {
      const error = new Error(`SSH command timed out while queued: ${next.command}`);
      error.code = 'ETIMEDOUT';
      next.reject(error);
      next = this.queue.shift();
    }
    if (!next) return;
    const id = ++this.sequence;
    const command = [next.command, ...next.args].map(shellQuote).join(' ');
    const timeout = setTimeout(() => this.disconnect(new Error(`SSH command timed out: ${next.command}`)), next.deadline - Date.now());
    this.waiting = { kind: 'command', id, lines: null, timeout, resolve: next.resolve, reject: next.reject };
    this.child.stdin.write(`printf '%s\\n' '${this.prefix}BEGIN_${id}'; _sm_out=$(LC_ALL=C ${command} 2>&1); _sm_rc=$?; printf '%s' "$_sm_out" | base64 | tr -d '\\n'; printf '\\n%s%s\\n' '${this.prefix}END_${id}_' "$_sm_rc"\n`);
  }

  execFile(command, args = [], options = {}) {
    if (this.closed) return Promise.reject(new Error('SSH transport disposed'));
    return new Promise((resolve, reject) => {
      const timeoutMilliseconds = options.timeoutMilliseconds || 10000;
      this.queue.push({ command, args, timeoutMilliseconds, deadline: Date.now() + timeoutMilliseconds, resolve, reject });
      this.drain();
    });
  }

  readFile(file, encoding) {
    if (encoding !== 'utf8') return Promise.reject(new Error('Only UTF-8 remote files are supported'));
    return this.execFile('cat', [file], { timeoutMilliseconds: 5000 }).then(({ stdout }) => stdout);
  }

  disconnect(error) {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (!this.child && !this.waiting) return;
    this.sshConnection = null;
    if (!this.closed) { this.retryAfter = error && error.code === 'EPLATFORM' ? Infinity : Date.now() + this.retryDelayMilliseconds; this.lastError = error; }
    const child = this.child;
    this.child = null;
    if (child) child.kill();
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting) { if (waiting.timeout) clearTimeout(waiting.timeout); waiting.reject(error); }
    if (!this.closed) this.onState('disconnected', error);
    if (!this.closed && Number.isFinite(this.retryAfter)) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (!this.closed && this.shouldReconnect()) this.connect().catch(() => {});
      }, Math.max(0, this.retryAfter - Date.now()));
    }
    if (this.queue.length && !this.closed && !this.connecting) setTimeout(() => this.drain(), 1000);
  }

  dispose() {
    this.closed = true;
    this.disconnect(new Error('SSH transport disposed'));
    for (const next of this.queue.splice(0)) next.reject(new Error('SSH transport disposed'));
  }
}

module.exports = { SshTransport, shellQuote };
