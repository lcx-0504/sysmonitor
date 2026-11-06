'use strict';

const { incompleteError } = require('../utils/errors');

class RemoteSystemInfo {
  constructor({ fileReader, commandRunner }) {
    this.fileReader = fileReader;
    this.commandRunner = commandRunner;
    this.cache = new Map();
    this.pending = new Map();
  }

  cached(key, ttl, loader) {
    const previous = this.cache.get(key);
    if (previous && Date.now() - previous.at < ttl) return Promise.resolve(previous.value);
    if (this.pending.has(key)) return this.pending.get(key);
    const pending = Promise.resolve().then(loader).then((value) => {
      this.cache.set(key, { at: Date.now(), value });
      return value;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, pending);
    return pending;
  }

  totalMemoryBytes() {
    return this.cached('memory', 60000, async () => {
      const raw = await this.fileReader.readFile('/proc/meminfo', 'utf8');
      const match = raw.match(/^MemTotal:\s+(\d+)\s+kB/m);
      const bytes = match ? Number(match[1]) * 1024 : 0;
      if (!Number.isSafeInteger(bytes) || bytes <= 0) throw incompleteError('Incomplete memory total');
      return bytes;
    });
  }

  coreCount() {
    return this.cached('cores', 60000, async () => {
      const stat = await this.fileReader.readFile('/proc/stat', 'utf8');
      const count = (stat.match(/^cpu\d+\s/gm) || []).length;
      if (count < 1) throw incompleteError('Incomplete CPU core count');
      return count;
    });
  }

  userId() {
    return this.cached('uid', 60000, async () => {
      const { stdout } = await this.commandRunner.execFile('id', ['-u']);
      const value = stdout.trim();
      if (!/^\d+$/.test(value)) throw incompleteError('Incomplete user identity');
      return Number(value);
    });
  }
}

module.exports = { RemoteSystemInfo };
