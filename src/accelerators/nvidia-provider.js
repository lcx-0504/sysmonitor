'use strict';
const { executionOptions } = require('../core/collection-context');
const { processStartTime } = require('../domain/linux-parsers');
const { incompleteError } = require('../utils/errors');

const CARD_FIELDS = 'index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,gpu_uuid';
const CARD_QUERY = ['--query-gpu=' + CARD_FIELDS, '--format=csv,noheader,nounits'];
const PROCESS_QUERY = ['--query-compute-apps=pid,gpu_uuid,used_memory', '--format=csv,noheader,nounits'];
const MEBIBYTE = 1024 * 1024;

function optionalInteger(raw) {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

function mebibytesToBytes(raw) {
  const value = optionalInteger(raw);
  return value === null ? null : value * MEBIBYTE;
}

function parseNvidiaCards(raw) {
  return raw.trim().split('\n').filter(Boolean).map((line) => {
    const fields = line.split(',').map((value) => value.trim());
    const [index, name, utilization, memoryUsed, memoryTotal, temperature, powerDraw, powerLimit, uuid] = fields;
    const complete = fields.length === 9 && Number.isInteger(Number(index)) && name && uuid && uuid !== 'N/A';
    if (!complete) throw incompleteError('Incomplete GPU query output');
    const drawWatts = Number.parseFloat(powerDraw);
    return {
      provider: 'nvidia', deviceKey: `nvidia:${uuid}`, providerDeviceId: uuid, nativeIndex: Number.parseInt(index, 10), name,
      utilizationPercent: optionalInteger(utilization),
      memory: { usedBytes: mebibytesToBytes(memoryUsed), totalBytes: mebibytesToBytes(memoryTotal) },
      temperatureCelsius: optionalInteger(temperature),
      power: Number.isFinite(drawWatts) ? { drawWatts, limitWatts: Number.parseFloat(powerLimit) } : null,
    };
  });
}

function parseNvidiaProcesses(raw, devicesById) {
  const usagesByPid = new Map();
  for (const line of raw.trim().split('\n').filter(Boolean)) {
    const [pidRaw, uuid, memoryRaw] = line.split(',').map((value) => value.trim());
    const pid = Number(pidRaw);
    if (!Number.isInteger(pid) || pid <= 0 || !uuid || memoryRaw === undefined) throw incompleteError('Incomplete GPU process query output');
    const device = devicesById.get(uuid);
    const usage = {
      pid,
      deviceKey: device ? device.deviceKey : null,
      nativeIndex: device ? device.nativeIndex : null,
      providerDeviceId: uuid,
      memoryUsedBytes: mebibytesToBytes(memoryRaw),
      memoryTotalBytes: device ? device.memory.totalBytes : null,
      mappingStatus: device ? 'matched' : 'unmatched',
    };
    if (!usagesByPid.has(pid)) usagesByPid.set(pid, []);
    usagesByPid.get(pid).push(usage);
  }
  return usagesByPid;
}

class NvidiaProvider {
  constructor({ commandRunner, userId = typeof process.getuid === 'function' ? process.getuid() : null, systemInfo = null }) {
    Object.assign(this, { commandRunner, userId, systemInfo });
    this.id = 'nvidia';
  }

  async readProcessIdentities(pids) {
    let stdout;
    try {
      ({ stdout } = await this.commandRunner.execFile('ps', ['-p', pids.join(','), '-o', 'pid=,uid=,user:32=,lstart='], executionOptions()));
    } catch (error) {
      if ((error.exitCode === 1 || error.code === 1) && !error.stderr?.trim()) return new Map();
      throw error;
    }
    const identities = new Map();
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) throw incompleteError('Incomplete GPU process identity output');
      const startedAt = processStartTime(match[4]);
      if (!Number.isFinite(startedAt)) throw incompleteError('Incomplete GPU process start time');
      const pid = Number(match[1]);
      identities.set(pid, { processKey: pid + ':' + startedAt, userId: Number(match[2]), userName: match[3] });
    }
    return identities;
  }

  async collect({ onPartial = () => {} } = {}) {
    const { stdout: cardOutput } = await this.commandRunner.execFile('nvidia-smi', CARD_QUERY, executionOptions());
    const devices = parseNvidiaCards(cardOutput);
    const cards = { devices, usagesByPid: new Map(), currentUserDeviceKeys: [], occupancyKnown: false, sampledAt: Date.now() };
    if (!devices.length) return { ...cards, occupancyKnown: true };
    onPartial({ value: cards, failureCode: 'GPU_OCCUPANCY_UNAVAILABLE' });
    const devicesById = new Map(devices.map(device => [device.providerDeviceId, device]));
    let usagesByPid;
    try {
      const { stdout } = await this.commandRunner.execFile('nvidia-smi', PROCESS_QUERY, executionOptions());
      usagesByPid = parseNvidiaProcesses(stdout, devicesById);
    } catch (error) {
      return { ...cards, collectionErrors: [{ code: 'GPU_OCCUPANCY_UNAVAILABLE', message: error.message }] };
    }
    for (const usages of usagesByPid.values()) for (const usage of usages) usage.identityKnown = false;
    const occupied = { ...cards, usagesByPid, occupancyKnown: true };
    if (!usagesByPid.size) return occupied;
    onPartial({ value: occupied, failureCode: 'GPU_IDENTITY_UNAVAILABLE' });
    try {
      const identityResults = await Promise.allSettled([
        this.readProcessIdentities([...usagesByPid.keys()]),
        this.systemInfo ? this.systemInfo.userId() : this.userId,
      ]);
      const failure = identityResults.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      const [identities, userId] = identityResults.map(result => result.value);
      const currentUserDeviceKeys = new Set();
      const identifiedUsages = new Map();
      for (const [pid, usages] of usagesByPid) {
        const identity = identities.get(pid);
        identifiedUsages.set(pid, usages.map(usage => {
          if (identity && identity.userId === userId && usage.deviceKey) currentUserDeviceKeys.add(usage.deviceKey);
          return { ...usage, identityKnown: !!identity, processKey: identity?.processKey || null, userName: identity?.userName || null };
        }));
      }
      return { ...occupied, usagesByPid: identifiedUsages, currentUserDeviceKeys: [...currentUserDeviceKeys] };
    } catch (error) {
      return { ...occupied, collectionErrors: [{ code: 'GPU_IDENTITY_UNAVAILABLE', message: error.message }] };
    }
  }
}
module.exports = { NvidiaProvider, parseNvidiaCards, parseNvidiaProcesses };
