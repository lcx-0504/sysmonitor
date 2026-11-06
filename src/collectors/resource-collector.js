'use strict';
const { CpuCollector } = require('./cpu-collector');
const { parseMemoryInfo } = require('../domain/linux-parsers');
const { NetworkCollector } = require('./network-collector');
const { DiskIoCollector } = require('./disk-io-collector');

const RESOURCE_INPUTS = {
  cpu: ['/proc/stat', '/proc/loadavg'], memory: ['/proc/meminfo'],
  network: ['/proc/net/dev', '/proc/net/route'], diskIo: ['/proc/diskstats'],
};
const OPTIONAL_FILES = new Set(['/proc/net/route']);
const marker = index => `__SYSMON_RESOURCE_${index}__\n`;
const incomplete = () => Object.assign(new Error('Incomplete resource sample'), { code: 'EINCOMPLETE' });
const resourceCommand = files => [
  'read -r started ignored < /proc/uptime || exit 1',
  ...files.map((file, index) =>
    `printf '${marker(index)}'; cat '${file}' ${OPTIONAL_FILES.has(file) ? '2>/dev/null || :' : '|| exit $?'}; printf '\\n'`),
  'read -r finished ignored < /proc/uptime || exit 1',
  `printf '${marker(files.length)}%s %s\\n' "$started" "$finished"`,
].join('\n');

function parseResourceFiles(stdout, files) {
  const values = new Map();
  let offset = 0;
  for (let index = 0; index < files.length; index++) {
    const start = marker(index), end = marker(index + 1);
    if (!stdout.startsWith(start, offset)) throw incomplete();
    const next = stdout.indexOf(end, offset + start.length);
    if (next < 0) throw incomplete();
    values.set(files[index], stdout.slice(offset + start.length, next));
    offset = next;
  }
  const end = marker(files.length);
  const timing = stdout.startsWith(end, offset) && stdout.slice(offset + end.length).match(/^(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)\n$/);
  if (!timing) throw incomplete();
  return { values, sampledAt: (Number(timing[1]) + Number(timing[2])) / 2 * 1000 };
}

class ResourceCollector {
  constructor({ commandRunner, keys = Object.keys(RESOURCE_INPUTS) }) {
    this.commandRunner = commandRunner;
    this.keys = keys;
    this.reset();
  }

  reset() {
    this.cpu = new CpuCollector();
    this.network = new NetworkCollector();
    this.diskIo = new DiskIoCollector();
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
    const { stdout } = await this.commandRunner.execFile('sh', ['-c', resourceCommand(inputs)]);
    const { values: files, sampledAt } = parseResourceFiles(stdout, inputs);
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

module.exports = { ResourceCollector };
