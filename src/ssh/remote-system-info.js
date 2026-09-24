'use strict';

class RemoteSystemInfo {
  constructor({ fileReader, commandRunner }) {
    this.fileReader = fileReader;
    this.commandRunner = commandRunner;
    this.cache = new Map();
  }

  async cached(key, ttl, loader) {
    const previous = this.cache.get(key);
    if (previous && Date.now() - previous.at < ttl) return previous.value;
    const value = await loader();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  async cpuInfo() {
    const [loadRaw, coreCount] = await Promise.all([
      this.fileReader.readFile('/proc/loadavg', 'utf8'),
      this.cached('cores', 60000, async () => {
        const raw = await this.fileReader.readFile('/proc/stat', 'utf8');
        return (raw.match(/^cpu\d+\s/gm) || []).length;
      }),
    ]);
    const loadAverage = loadRaw.trim().split(/\s+/).slice(0, 3).map(Number);
    return { coreCount, loadAverage };
  }

  async totalMemoryBytes() {
    return this.cached('memory', 60000, async () => {
      const raw = await this.fileReader.readFile('/proc/meminfo', 'utf8');
      const match = raw.match(/^MemTotal:\s+(\d+)\s+kB/m);
      return match ? Number(match[1]) * 1024 : 0;
    });
  }

  async userId() {
    return this.cached('uid', 60000, async () => {
      const { stdout } = await this.commandRunner.execFile('id', ['-u'], { timeoutMilliseconds: 3000 });
      return Number.parseInt(stdout, 10);
    });
  }
}

module.exports = { RemoteSystemInfo };
