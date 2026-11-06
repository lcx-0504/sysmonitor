'use strict';
const { CpuCollector } = require('./cpu-collector');
const { parseMemoryInfo } = require('../domain/linux-parsers');
const { performance } = require('node:perf_hooks');
const { NetworkCollector } = require('./network-collector');
const { DiskIoCollector } = require('./disk-io-collector');

const RESOURCE_INPUTS = {
  cpu: ['/proc/stat', '/proc/loadavg'], memory: ['/proc/meminfo'],
  network: ['/proc/net/dev', '/proc/net/route'], diskIo: ['/proc/diskstats'],
};
const RESOURCE_FILES = Object.values(RESOURCE_INPUTS).flat();
const OPTIONAL_FILES = new Set(['/proc/net/route']);
const marker = index => `__SYSMON_RESOURCE_${index}__\n`;
const resourceCommand = files => files.map((file, index) =>
  `printf '${marker(index)}'; cat '${file}' ${OPTIONAL_FILES.has(file) ? '2>/dev/null || :' : '|| exit $?'}; printf '\\n'`).join('\n') + `\nprintf '${marker(files.length)}'`;
const RESOURCE_COMMAND = resourceCommand(RESOURCE_FILES);

function parseResourceFiles(stdout, files = RESOURCE_FILES) {
  const values = new Map();
  let offset = 0;
  for (let index = 0; index < files.length; index++) {
    const start = marker(index), end = marker(index + 1);
    if (!stdout.startsWith(start, offset)) throw new Error('Incomplete resource sample');
    const next = stdout.indexOf(end, offset + start.length);
    if (next < 0) throw new Error('Incomplete resource sample');
    values.set(files[index], stdout.slice(offset + start.length, next));
    offset = next;
  }
  return values;
}

class ResourceCollector {
  constructor({ fileReader, commandRunner = null, keys = Object.keys(RESOURCE_INPUTS) }) {
    this.fileReader = fileReader;
    this.commandRunner = commandRunner;
    this.cpu = new CpuCollector();
    this.network = new NetworkCollector();
    this.diskIo = new DiskIoCollector();
    this.keys = keys;
  }

  setKeys(keys) {
    const counters = { cpu:CpuCollector, network:NetworkCollector, diskIo:DiskIoCollector };
    for (const key of new Set([...this.keys, ...keys])) {
      if (this.keys.includes(key) !== keys.includes(key) && counters[key]) this[key] = new counters[key]();
    }
    this.keys = keys;
  }

  async collect() {
    const keys = [...this.keys];
    const {cpu, network, diskIo} = this;
    const inputs = keys.flatMap(key => RESOURCE_INPUTS[key]);
    let files;
    if (this.commandRunner) {
      const { stdout } = await this.commandRunner.execFile('sh', ['-c', resourceCommand(inputs)]);
      files = parseResourceFiles(stdout, inputs);
    } else files = new Map(await Promise.all(inputs.map(async file => {
      try { return [file, await this.fileReader.readFile(file, 'utf8')]; }
      catch (error) { if (OPTIONAL_FILES.has(file)) return [file, '']; throw error; }
    })));
    const sampledAt = performance.now();
    const result = {};
    for (const key of keys) {
      if (key === 'cpu') {
        const stat = files.get('/proc/stat');
        result.cpu = cpu.accept(stat, { coreCount:(stat.match(/^cpu\d+\s/gm) || []).length,
          loadAverage:files.get('/proc/loadavg').trim().split(/\s+/).slice(0, 3).map(Number) });
      } else if (key === 'memory') result.memory = parseMemoryInfo(files.get('/proc/meminfo'));
      else if (key === 'network') result.network = network.accept(files.get('/proc/net/dev'), files.get('/proc/net/route'), sampledAt);
      else if (key === 'diskIo') result.diskIo = diskIo.accept(files.get('/proc/diskstats'), sampledAt);
    }
    return result;
  }

  needsWarmup(values) {
    return ['cpu', 'network', 'diskIo'].some(key => values[key] && this[key].needsWarmup(values[key]));
  }
}

module.exports = { ResourceCollector, RESOURCE_FILES, RESOURCE_COMMAND, parseResourceFiles };
