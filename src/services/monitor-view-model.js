'use strict';
const { formatBytesPerSecond, formatDiskBytes, formatMemoryBytes, formatSize, formatSizePair, formatDuration } = require('../utils/format');
const { getAcceleratorAvailability } = require('../domain/accelerator-availability');
const { shouldExclude } = require('../domain/disk');

const valueOf = (partition, fallback) => partition && partition.value != null ? partition.value : fallback;
const numeric = (value) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const optionalNumber = (value) => Number.isFinite(value) ? value : null;
const roundedPercent = (used, total) => total > 0 ? Math.min(100, Math.max(0, Math.round(numeric(used) / total * 100))) : 0;

function displayDeviceName(name) {
  const original = String(name || '').trim();
  return original.replace(/^(?:(?:NVIDIA|GeForce|Tesla)\s+)+/i, '').trim() || original || 'GPU';
}

function groupGpuUsers(processes, usagesByPid) {
  const gpuUsers = new Map();
  const processByPid = new Map(processes.map(process => [process.pid, process]));
  for (const [pid, usages] of usagesByPid) {
    const processInfo = processByPid.get(pid);
    for (const usage of usages) {
      if (!usage.deviceKey || usage.identityKnown === false) continue;
      const name = usage.userName || (processInfo && (!usage.processKey || usage.processKey === processInfo.processKey) ? processInfo.userName : null);
      if (!name) continue;
      if (!gpuUsers.has(usage.deviceKey)) gpuUsers.set(usage.deviceKey, new Map());
      const users = gpuUsers.get(usage.deviceKey);
      const previous = users.get(name);
      users.set(name, previous === null || !Number.isFinite(usage.memoryUsedBytes) ? null : (previous || 0) + usage.memoryUsedBytes);
    }
  }
  return gpuUsers;
}

function buildGpuModels(acceleratorData, processes, current = true) {
  const currentUserDeviceKeys = new Set(acceleratorData.currentUserDeviceKeys);
  const gpuUsers = groupGpuUsers(processes, acceleratorData.usagesByPid);
  const occupiedDevices = new Set();
  let occupancyComplete = current && acceleratorData.occupancyKnown !== false;
  for (const usages of acceleratorData.usagesByPid.values()) for (const usage of usages) {
    if (usage.deviceKey) occupiedDevices.add(usage.deviceKey);
    else occupancyComplete = false;
  }
  return acceleratorData.devices.map((device) => {
    const availability = getAcceleratorAvailability(occupiedDevices.has(device.deviceKey), occupancyComplete);
    return {
    idx: device.nativeIndex, name: device.name, uuid: device.providerDeviceId,
    displayName: displayDeviceName(device.name), isMine: currentUserDeviceKeys.has(device.deviceKey),
    util: optionalNumber(device.utilizationPercent), memUsed: Number.isFinite(device.memory.usedBytes) ? Math.round(device.memory.usedBytes / 1048576) : null, memTotal: Number.isFinite(device.memory.totalBytes) ? Math.round(device.memory.totalBytes / 1048576) : null,
    memUsedStr: formatSize(device.memory.usedBytes), memTotalStr: formatSize(device.memory.totalBytes),
    memPairStr: formatSizePair(device.memory.usedBytes, device.memory.totalBytes),
    memPct: Number.isFinite(device.memory.usedBytes) && Number.isFinite(device.memory.totalBytes) ? roundedPercent(device.memory.usedBytes, device.memory.totalBytes) : null,
    users: [...(gpuUsers.get(device.deviceKey) || new Map())].map(([name, usedBytes]) => ({ name, usedBytes, usedStr: formatSize(usedBytes, { compact: true }), percent: Number.isFinite(usedBytes) ? roundedPercent(usedBytes, device.memory.totalBytes) : null })).sort((left, right) => numeric(right.usedBytes) - numeric(left.usedBytes) || left.name.localeCompare(right.name)),
    temp: optionalNumber(device.temperatureCelsius), power: device.power ? { draw: Number.isFinite(device.power.drawWatts) ? device.power.drawWatts.toFixed(0) : '--', limit: Number.isFinite(device.power.limitWatts) ? device.power.limitWatts.toFixed(0) : '--' } : null,
    deviceKey: device.deviceKey, availability, isIdle: availability === 'idle',
  }; });
}

function buildProcessRows(processes, acceleratorData) {
  const allProcessRows = processes.map((processInfo) => {
    const usages = (acceleratorData.usagesByPid.get(processInfo.pid) || []).filter((usage) => usage.identityKnown !== false && (!usage.processKey || usage.processKey === processInfo.processKey));
    const gpus = usages.map((usage) => ({ idx: usage.nativeIndex, vram: Number.isFinite(usage.memoryUsedBytes) ? Math.round(usage.memoryUsedBytes / 1048576) : null, memTotal: Number.isFinite(usage.memoryTotalBytes) ? Math.round(usage.memoryTotalBytes / 1048576) : null, vramStr: formatSize(usage.memoryUsedBytes, { compact: true }), memTotalStr: formatSize(usage.memoryTotalBytes, { compact: true }), pct: Number.isFinite(usage.memoryUsedBytes) && Number.isFinite(usage.memoryTotalBytes) ? roundedPercent(usage.memoryUsedBytes, usage.memoryTotalBytes) : null, mappingStatus: usage.mappingStatus }));
    return { pid: processInfo.pid, processKey: processInfo.processKey, user: processInfo.userName, cpu: processInfo.cpuUsagePercent, cpuWhole: processInfo.cpuWhole, mem: processInfo.memoryUsedBytes, memStr: formatSize(processInfo.memoryUsedBytes), memPct: processInfo.memoryUsagePercent, name: processInfo.processName, cmd: processInfo.commandLine, gpus, vram: gpus.reduce((sum, usage) => sum + usage.vram, 0) };
  });
  return allProcessRows;
}

function buildDisks(topology, diskConfig) {
  let disks = topology.filter(disk => !shouldExclude(disk.fileSystemType, disk.mountPath, diskConfig)).map((disk) => {
    const totalBytes = Math.max(0, numeric(disk.totalBytes));
    const usedBytes = Math.max(0, numeric(disk.usedBytes));
    const availableBytes = Math.min(totalBytes, Math.max(0, disk.availableBytes === undefined ? totalBytes - usedBytes : numeric(disk.availableBytes)));
    const reservedBytes = Math.max(0, totalBytes - usedBytes - availableBytes);
    const occupiedBytes = totalBytes - availableBytes;
    return {
      mount: disk.mountPath,
      occupiedStr: formatDiskBytes(occupiedBytes), usedStr: formatDiskBytes(usedBytes), availableStr: formatDiskBytes(availableBytes), reservedStr: formatDiskBytes(reservedBytes), totalStr: formatDiskBytes(totalBytes),
      reservedPct: totalBytes > 0 ? reservedBytes / totalBytes * 100 : 0,
      occupiedPct: totalBytes > 0 ? occupiedBytes / totalBytes * 100 : 0,
      pct: roundedPercent(occupiedBytes, totalBytes),
    };
  });
  if (diskConfig.hideParentMounts !== false) {
    const mounts = disks.map((disk) => disk.mount);
    disks = disks.filter((disk) => disk.mount === '/' || !mounts.some((mount) => mount !== disk.mount && mount.startsWith(`${disk.mount}/`)));
  }
  return disks;
}

function buildMonitorViewModel(snapshot, language, diskConfig = {}) {
  const available = (key) => !!snapshot[key] && snapshot[key].value != null;
  const cpu = valueOf(snapshot.cpu, { usagePercent: null, coreCount: 0, loadAverage: { oneMinute: 0, fiveMinutes: 0, fifteenMinutes: 0 } });
  const memory = valueOf(snapshot.memory, { usagePercent: 0, usedBytes: 0, availableBytes: 0, totalBytes: 0 });
  const network = valueOf(snapshot.network, { receiveBytesPerSecond: null, transmitBytesPerSecond: null });
  const diskIo = valueOf(snapshot.diskIo, { readBytesPerSecond: null, writeBytesPerSecond: null });
  const ssh = valueOf(snapshot.sshTraffic, { isSsh: false, clientUploadBytesPerSecond: null, clientDownloadBytesPerSecond: null });
  const topology = valueOf(snapshot.diskTopology, []);
  const acceleratorData = valueOf(snapshot.accelerators, { devices: [], usagesByPid: new Map(), currentUserDeviceKeys: [] });
  const processSample = valueOf(snapshot.processes, { rows: [], totalCount: 0 });
  const processes = processSample.rows;
  const receive = optionalNumber(network.receiveBytesPerSecond);
  const transmit = optionalNumber(network.transmitBytesPerSecond);
  const read = optionalNumber(diskIo.readBytesPerSecond);
  const write = optionalNumber(diskIo.writeBytesPerSecond);
  const devices = buildGpuModels(acceleratorData, processes, !snapshot.accelerators.lastError);
  const processRows = buildProcessRows(processes, acceleratorData);
  const disks = buildDisks(topology, diskConfig);
  return {
    sources: Object.fromEntries(['cpu', 'memory', 'network', 'diskIo', 'diskTopology', 'sshTraffic', 'processes', 'accelerators'].map((key) => {
      const partition = snapshot[key];
      const hasValue = partition?.value != null;
      return [key, {
        state: partition?.status === 'disabled' ? 'disabled' : partition?.lastError ? hasValue ? 'stale' : partition.status === 'unavailable' ? 'unavailable' : 'error' : hasValue ? 'ready' : 'loading',
        available: hasValue, sequence: partition?.collectedSequence || 0,
        sampledAt: partition?.collectedAt ?? null,
        error: partition?.lastError || null,
        revision: [partition?.status, partition?.collectedSequence || 0, partition?.failureSequence || 0].join(':'),
      }];
    })),
    performance: {
      language,
      cpu: { available: available('cpu'), usagePercent: optionalNumber(cpu.usagePercent), coreCount: cpu.coreCount, loadAverage: {
        oneMinute: Number.isFinite(cpu.loadAverage.oneMinute) ? cpu.loadAverage.oneMinute.toFixed(1) : '--', fiveMinutes: Number.isFinite(cpu.loadAverage.fiveMinutes) ? cpu.loadAverage.fiveMinutes.toFixed(1) : '--', fifteenMinutes: Number.isFinite(cpu.loadAverage.fifteenMinutes) ? cpu.loadAverage.fifteenMinutes.toFixed(1) : '--',
      } },
      memory: { available: available('memory'), usagePercent: available('memory') ? optionalNumber(memory.usagePercent) : null, usedText: available('memory') ? formatMemoryBytes(memory.usedBytes) : '--', availableText: available('memory') ? formatMemoryBytes(memory.availableBytes) : '--', totalText: available('memory') ? formatMemoryBytes(memory.totalBytes) : '--' },
      gpus: devices,
      network: { available: available('network'), receiveBytesPerSecond: receive, transmitBytesPerSecond: transmit, receiveText: formatBytesPerSecond(receive), transmitText: formatBytesPerSecond(transmit), totalText: formatBytesPerSecond(receive !== null && transmit !== null ? receive + transmit : null) },
      sshTraffic: ssh.isSsh ? { isSsh: true, uploadBytesPerSecond: optionalNumber(ssh.clientUploadBytesPerSecond), downloadBytesPerSecond: optionalNumber(ssh.clientDownloadBytesPerSecond), uploadText: formatBytesPerSecond(ssh.clientUploadBytesPerSecond), downloadText: formatBytesPerSecond(ssh.clientDownloadBytesPerSecond), latencyText: formatDuration(ssh.latencyMilliseconds) } : { isSsh: false },
      disks, diskIo: {
        available: available('diskIo'),
        readBytesPerSecond: read, writeBytesPerSecond: write,
        readText: read !== null ? formatBytesPerSecond(read) : '--', writeText: write !== null ? formatBytesPerSecond(write) : '--',
        totalBytesPerSecond: read !== null && write !== null ? read + write : null, totalText: read !== null && write !== null ? formatBytesPerSecond(read + write) : '--',
      },
    },
    processes: processRows,
    processTotalCount: processSample.totalCount,
    processRevision: [snapshot.processes?.collectedSequence || 0, snapshot.accelerators.collectedSequence || 0].join(':'),
    currentUserNativeIndices: acceleratorData.currentUserDeviceKeys.map((key) => devices.find((device) => device.deviceKey === key)).filter(Boolean).map((device) => device.idx),
  };
}
module.exports = { buildMonitorViewModel, displayDeviceName };
