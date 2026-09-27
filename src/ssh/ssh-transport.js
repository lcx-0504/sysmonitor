'use strict';

const { spawn } = require('node:child_process');
const { expandHome } = require('./ssh-config');
const { executionOptions, timeoutError } = require('../core/collection-context');
const { SshChannel } = require('./ssh-channel');
const { SshProcessGuard } = require('./ssh-process-guard');

const MAX_CONNECTIONS = 4;

class SshTransport {
  constructor({ host, configFile = null, spawnProcess = spawn, onState = () => {}, requireLinux = true,
    shouldReconnect = () => true, retryDelayMilliseconds = 10000, maxConnections = MAX_CONNECTIONS,
    onResidualProcesses = () => {}, onLog = () => {} }) {
    if (!host || /[\s\0]/.test(host) || host.startsWith('-')) throw new Error('Invalid SSH host alias');
    if (!Number.isInteger(maxConnections) || maxConnections < 1) throw new Error('Invalid SSH pool size');
    Object.assign(this, { host, spawnProcess, onState, requireLinux, shouldReconnect, retryDelayMilliseconds, maxConnections });
    this.configFile = configFile ? expandHome(configFile) : null;
    this.channels = new Set();
    this.pending = new Map();
    this.sequence = 0;
    this.opening = null;
    this.connected = false;
    this.closed = false;
    this.retryAfter = 0;
    this.expansionAfter = 0;
    this.retryTimer = null;
    this.lastError = null;
    this.generation = 0;
    this.processGuard = new SshProcessGuard({ execFile: (...args) => this.execFile(...args),
      canCheck: () => !this.closed && this.ready && this.shouldReconnect(), onLimit: onResidualProcesses,
      onError: (error) => onLog('SSH process verification: ' + error.message) });
  }

  get ready() { return [...this.channels].some((channel) => channel.ready); }
  get sshConnections() {
    const connections = [...this.channels].filter((channel) => channel.ready && channel.connection).map((channel) => channel.connection);
    return [...new Map(connections.map((connection) => [JSON.stringify(connection), connection])).values()];
  }

  connect() {
    if (this.closed) return Promise.reject(new Error('SSH transport disposed'));
    if (this.ready) return Promise.resolve();
    if (this.opening) return this.opening;
    if (Date.now() < this.retryAfter) return Promise.reject(this.lastError || new Error('SSH reconnect waiting'));
    if (this.channels.size >= this.maxConnections) {
      return Promise.race([...this.channels].map((channel) => channel.exitPromise)).then(() => this.connect());
    }
    if (!this.connected) this.onState('connecting');
    return this.openChannel();
  }

  openChannel() {
    const generation = this.generation;
    const channel = new SshChannel({
      host: this.host, configFile: this.configFile, spawnProcess: this.spawnProcess, requireLinux: this.requireLinux,
      onInterrupted: (process) => { if (!this.closed) this.processGuard.track(process); },
      onExit: (channel) => { this.channels.delete(channel); queueMicrotask(() => this.drain()); },
      onClose: (closed, error, intentional, wasReady) => {
        if (wasReady && !intentional && !this.closed && !this.ready) this.disconnect(error);
        else queueMicrotask(() => this.drain());
      },
    });
    this.channels.add(channel);
    const opening = channel.connect().then(() => {
      if (this.closed || channel.closed || generation !== this.generation) throw new Error('SSH connection closed');
      this.lastError = null;
      this.retryAfter = 0;
      this.processGuard.schedule();
      if (!this.connected) {
        this.connected = true;
        this.onState('connected');
      }
    }).catch((error) => {
      if (!this.closed && generation === this.generation) {
        if (!this.ready) this.disconnect(error);
        else this.expansionAfter = Date.now() + this.retryDelayMilliseconds;
      }
      throw error;
    }).finally(() => {
      if (this.opening === opening) this.opening = null;
      this.drain();
    });
    this.opening = opening;
    return opening;
  }

  retryNow() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAfter = 0;
    this.expansionAfter = 0;
    this.lastError = null;
    return this.connect();
  }

  execFile(command, args = [], options = {}) {
    try { options = executionOptions(options); } catch (error) { return Promise.reject(error); }
    if (this.closed) return Promise.reject(new Error('SSH transport disposed'));
    if (Date.now() < this.retryAfter) return Promise.reject(this.lastError || new Error('SSH reconnect waiting'));
    const timeout = Number.isFinite(options.timeoutMilliseconds) ? options.timeoutMilliseconds : 10000;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const onAbort = () => cancel(options.signal.reason || new Error('SSH command cancelled'));
      const onPause = () => {
        if (!task.channel) task.finish(options.dispatchSignal.reason || new Error('Monitoring paused'));
      };
      const task = { id, command, args, limit: options.maxBufferBytes || 4 * 1024 * 1024, trackProcess: options.trackProcess !== false, channel: null,
        finish: (error, result) => {
          if (!this.pending.delete(id)) return;
          clearTimeout(task.timer);
          if (options.signal) options.signal.removeEventListener('abort', onAbort);
          if (options.dispatchSignal) options.dispatchSignal.removeEventListener('abort', onPause);
          error ? reject(error) : resolve(result);
          if (!error && task.trackProcess) this.processGuard.schedule();
          queueMicrotask(() => this.drain());
        },
      };
      const cancel = (error) => {
        if (task.channel) task.channel.close(error, true);
        task.finish(error);
      };
      this.pending.set(id, task);
      task.timer = setTimeout(() => cancel(timeoutError('Command timed out: ' + command)), timeout);
      if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
      if (options.dispatchSignal) options.dispatchSignal.addEventListener('abort', onPause, { once: true });
      this.drain();
    });
  }

  nextQueuedTask() {
    let next = null;
    for (const task of this.pending.values()) {
      if (task.channel) continue;
      // Residual verification must not sit behind the sampling backlog.
      if (!task.trackProcess) return task;
      if (!next) next = task;
    }
    return next;
  }

  drain() {
    if (this.closed || Date.now() < this.retryAfter) return;
    for (const channel of this.channels) {
      if (!channel.ready || channel.request) continue;
      const task = this.nextQueuedTask();
      if (!task) return;
      task.channel = channel;
      channel.execFile(task.id, task.command, task.args, task.limit, task.trackProcess).then(
        (result) => task.finish(null, result), (error) => task.finish(error));
    }
    if (this.nextQueuedTask() && !this.opening
      && this.channels.size < this.maxConnections && Date.now() >= this.expansionAfter) {
      if (!this.connected) this.onState('connecting');
      this.openChannel().catch(() => {});
    }
  }

  readFile(file, encoding) {
    if (encoding !== 'utf8') return Promise.reject(new Error('Only UTF-8 remote files are supported'));
    return this.execFile('cat', [file]).then(({ stdout }) => stdout);
  }

  disconnect(error) {
    this.generation++;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connected = false;
    if (!this.closed) {
      this.retryAfter = error && error.code === 'EPLATFORM' ? Infinity : Date.now() + this.retryDelayMilliseconds;
      this.lastError = error;
    }
    for (const channel of this.channels) channel.close(error, true);
    for (const task of this.pending.values()) task.finish(error);
    if (this.closed) return;
    this.onState('disconnected', error);
    const retry = () => {
      this.retryTimer = null;
      if (this.closed || !this.shouldReconnect()) return;
      const remaining = this.retryAfter - Date.now();
      if (remaining > 0) { this.retryTimer = setTimeout(retry, remaining); return; }
      this.connect().catch(() => {});
    };
    if (Number.isFinite(this.retryAfter)) this.retryTimer = setTimeout(retry, Math.max(0, this.retryAfter - Date.now()));
  }

  dispose() {
    this.closed = true;
    this.processGuard.dispose();
    this.disconnect(new Error('SSH transport disposed'));
  }
}

module.exports = { SshTransport };
