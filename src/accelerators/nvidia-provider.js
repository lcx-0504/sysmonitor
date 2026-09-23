'use strict';
const fs = require('node:fs/promises');

const CARD_QUERY = ['--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,gpu_uuid', '--format=csv,noheader,nounits'];
const PROCESS_QUERY = ['--query-compute-apps=pid,gpu_uuid,used_memory', '--format=csv,noheader,nounits'];

function parseNvidiaCards(raw) {
  return raw.trim().split('\n').filter(Boolean).map((line) => {
    const [index, name, utilization, memoryUsed, memoryTotal, temperature, powerDraw, powerLimit, uuid] = line.split(',').map((value) => value.trim());
    const toBytes = (mebibytes) => Number.parseInt(mebibytes, 10) * 1024 * 1024;
    return {
      provider: 'nvidia', deviceKey: `nvidia:${uuid}`, providerDeviceId: uuid, nativeIndex: Number.parseInt(index, 10), name,
      utilizationPercent: Number.isFinite(Number.parseInt(utilization, 10)) ? Number.parseInt(utilization, 10) : null,
      memory: { usedBytes: toBytes(memoryUsed), totalBytes: toBytes(memoryTotal) },
      temperatureCelsius: Number.isFinite(Number.parseInt(temperature, 10)) ? Number.parseInt(temperature, 10) : null,
      power: Number.isFinite(Number.parseFloat(powerDraw)) ? { drawWatts: Number.parseFloat(powerDraw), limitWatts: Number.parseFloat(powerLimit) } : null,
      capabilities: { utilization: true, memory: true, temperature: true, power: Number.isFinite(Number.parseFloat(powerDraw)), processes: true, cudaVisibility: true },
    };
  });
}

function parseNvidiaProcesses(raw, devicesById) {
  const usagesByPid = new Map();
  for (const line of raw.trim().split('\n').filter(Boolean)) {
    const [pidRaw, uuid, memoryRaw] = line.split(',').map((value) => value.trim());
    const pid = Number.parseInt(pidRaw, 10); if (!pid) continue;
    const device = devicesById.get(uuid);
    const usage = { pid, deviceKey: device ? device.deviceKey : null, nativeIndex: device ? device.nativeIndex : null, providerDeviceId: uuid, memoryUsedBytes: (Number.parseInt(memoryRaw, 10) || 0) * 1024 * 1024, memoryTotalBytes: device ? device.memory.totalBytes : null, mappingStatus: device ? 'matched' : 'unmatched' };
    if (!usagesByPid.has(pid)) usagesByPid.set(pid, []);
    usagesByPid.get(pid).push(usage);
  }
  return usagesByPid;
}

class NvidiaProvider {
  constructor({ commandRunner, fileReader = fs, userId = typeof process.getuid === 'function' ? process.getuid() : null }) { this.commandRunner = commandRunner; this.fileReader = fileReader; this.userId = userId; this.id = 'nvidia'; this.clockTicksPerSecondPromise = null; }
  async readProcessKeys(pids) {
    if (!this.clockTicksPerSecondPromise) this.clockTicksPerSecondPromise = this.commandRunner.execFile('getconf', ['CLK_TCK'], { timeoutMilliseconds: 1000 }).then(({ stdout }) => Number.parseInt(stdout, 10) || 100).catch(() => 100);
    const [clockTicksPerSecond, procStat] = await Promise.all([this.clockTicksPerSecondPromise, this.fileReader.readFile('/proc/stat', 'utf8')]);
    const bootTimeMatch = procStat.match(/^btime\s+(\d+)/m); if (!bootTimeMatch) return new Map();
    const bootTimeSeconds = Number(bootTimeMatch[1]); const keys = new Map();
    await Promise.all(pids.map(async (pid) => {
      try {
        const stat = await this.fileReader.readFile(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/); const startTimeTicks = Number(fields[19]);
        // ps lstart has one-second precision; use the same precision on both sides
        // when matching a GPU process to the process table.
        if (Number.isFinite(startTimeTicks)) keys.set(pid, `${pid}:${Math.floor(bootTimeSeconds + startTimeTicks / clockTicksPerSecond) * 1000}`);
      } catch { /* process exited */ }
    }));
    return keys;
  }
  async collect() {
    const { stdout: cardOutput } = await this.commandRunner.execFile('nvidia-smi', CARD_QUERY, { timeoutMilliseconds: 15000 });
    const devices = parseNvidiaCards(cardOutput);
    if (devices.length === 0) return { devices: [], usagesByPid: new Map(), currentUserDeviceKeys: [] };
    const devicesById = new Map(devices.map((device) => [device.providerDeviceId, device]));
    const { stdout: processOutput } = await this.commandRunner.execFile('nvidia-smi', PROCESS_QUERY, { timeoutMilliseconds: 15000 });
    const usagesByPid = parseNvidiaProcesses(processOutput, devicesById);
    const processKeys = await this.readProcessKeys([...usagesByPid.keys()]);
    for (const [pid, usages] of usagesByPid) for (const usage of usages) usage.processKey = processKeys.get(pid) || null;
    const currentUserDeviceKeys = new Set();
    if (this.userId !== null) {
      await Promise.all([...usagesByPid.entries()].map(async ([pid, usages]) => {
        try {
          const status = await this.fileReader.readFile(`/proc/${pid}/status`, 'utf8');
          const match = status.match(/^Uid:\s+(\d+)/m);
          if (match && Number(match[1]) === this.userId) for (const usage of usages) if (usage.deviceKey) currentUserDeviceKeys.add(usage.deviceKey);
        } catch { /* process exited */ }
      }));
    }
    return { devices, usagesByPid, currentUserDeviceKeys: [...currentUserDeviceKeys] };
  }
}
module.exports = { NvidiaProvider, parseNvidiaCards, parseNvidiaProcesses };
