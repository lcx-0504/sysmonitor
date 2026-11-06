'use strict';
const { formatBytesPerSecond, formatDiskBytes, formatMemoryBytes, formatSize, formatSizePair, formatDuration } = require('../utils/format');
const { getAcceleratorAvailability } = require('../domain/accelerator-availability');
const { shouldExclude } = require('../domain/disk');

const SOURCE_KEYS = ['cpu', 'memory', 'network', 'diskIo', 'diskTopology', 'sshTraffic', 'processes', 'accelerators'];
const MEBIBYTE = 1048576;

const valueOf = (partition, fallback) => partition && partition.value != null ? partition.value : fallback;
const numeric = (value) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const optionalNumber = (value) => Number.isFinite(value) ? value : null;
const roundedPercent = (used, total) => total > 0 ? Math.min(100, Math.max(0, Math.round(numeric(used) / total * 100))) : 0;
const knownPercent = (used, total) => Number.isFinite(used) && Number.isFinite(total) ? roundedPercent(used, total) : null;
const fixedText = (value, digits) => Number.isFinite(value) ? value.toFixed(digits) : '--';

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
      const ownedByProcess = processInfo && (!usage.processKey || usage.processKey === processInfo.processKey);
      const name = usage.userName || (ownedByProcess ? processInfo.userName : null);
      if (!name) continue;
      if (!gpuUsers.has(usage.deviceKey)) gpuUsers.set(usage.deviceKey, new Map());
      const users = gpuUsers.get(usage.deviceKey);
      const previous = users.get(name);
      users.set(name, previous === null || !Number.isFinite(usage.memoryUsedBytes) ? null : (previous || 0) + usage.memoryUsedBytes);
    }
  }
  return gpuUsers;
}

function gpuUserRows(users, totalBytes) {
  const byUsage = ([leftName, leftBytes], [rightName, rightBytes]) => numeric(rightBytes) - numeric(leftBytes) || leftName.localeCompare(rightName);
  return [...users].sort(byUsage).map(([name, usedBytes]) => ({
    name,
    usedStr: formatSize(usedBytes, { compact: true }),
    percent: Number.isFinite(usedBytes) ? roundedPercent(usedBytes, totalBytes) : null,
  }));
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
    const { usedBytes, totalBytes } = device.memory;
    return {
      idx: device.nativeIndex,
      name: device.name,
      displayName: displayDeviceName(device.name),
      isMine: currentUserDeviceKeys.has(device.deviceKey),
      util: optionalNumber(device.utilizationPercent),
      memPairStr: formatSizePair(usedBytes, totalBytes),
      memPct: knownPercent(usedBytes, totalBytes),
      users: gpuUserRows(gpuUsers.get(device.deviceKey) || new Map(), totalBytes),
      temp: optionalNumber(device.temperatureCelsius),
      power: device.power ? { draw: fixedText(device.power.drawWatts, 0), limit: fixedText(device.power.limitWatts, 0) } : null,
      deviceKey: device.deviceKey,
      availability,
      isIdle: availability === 'idle',
    };
  });
}

function processGpuUsage(usage) {
  return {
    idx: usage.nativeIndex,
    vram: Number.isFinite(usage.memoryUsedBytes) ? Math.round(usage.memoryUsedBytes / MEBIBYTE) : null,
    vramStr: formatSize(usage.memoryUsedBytes, { compact: true }),
    memTotalStr: formatSize(usage.memoryTotalBytes, { compact: true }),
    pct: knownPercent(usage.memoryUsedBytes, usage.memoryTotalBytes),
    mappingStatus: usage.mappingStatus,
  };
}

function buildProcessRows(processes, acceleratorData) {
  return processes.map((processInfo) => {
    const belongsToProcess = (usage) => usage.identityKnown !== false && (!usage.processKey || usage.processKey === processInfo.processKey);
    const gpus = (acceleratorData.usagesByPid.get(processInfo.pid) || []).filter(belongsToProcess).map(processGpuUsage);
    return {
      pid: processInfo.pid,
      processKey: processInfo.processKey,
      user: processInfo.userName,
      cpu: processInfo.cpuUsagePercent,
      cpuWhole: processInfo.cpuWhole,
      mem: processInfo.memoryUsedBytes,
      memStr: formatSize(processInfo.memoryUsedBytes),
      memPct: processInfo.memoryUsagePercent,
      name: processInfo.processName,
      cmd: processInfo.commandLine,
      gpus,
      vram: gpus.reduce((sum, usage) => sum + usage.vram, 0),
      session: processInfo.session || null,
    };
  });
}

function buildDisks(topology, diskConfig) {
  let disks = topology.filter(disk => !shouldExclude(disk.fileSystemType, disk.mountPath, diskConfig)).map((disk) => {
    const totalBytes = Math.max(0, numeric(disk.totalBytes));
    const usedBytes = Math.max(0, numeric(disk.usedBytes));
    const reportedAvailable = disk.availableBytes === undefined ? totalBytes - usedBytes : numeric(disk.availableBytes);
    const availableBytes = Math.min(totalBytes, Math.max(0, reportedAvailable));
    const reservedBytes = Math.max(0, totalBytes - usedBytes - availableBytes);
    const occupiedBytes = totalBytes - availableBytes;
    return {
      mount: disk.mountPath,
      occupiedStr: formatDiskBytes(occupiedBytes),
      usedStr: formatDiskBytes(usedBytes),
      availableStr: formatDiskBytes(availableBytes),
      reservedStr: formatDiskBytes(reservedBytes),
      totalStr: formatDiskBytes(totalBytes),
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

function sourceState(partition) {
  const hasValue = partition?.value != null;
  if (partition?.status === 'disabled') return 'disabled';
  if (partition?.lastError) {
    if (hasValue) return 'stale';
    return partition.status === 'unavailable' ? 'unavailable' : 'error';
  }
  return hasValue ? 'ready' : 'loading';
}

function buildSources(snapshot) {
  return Object.fromEntries(SOURCE_KEYS.map((key) => {
    const partition = snapshot[key];
    const revision = [partition?.status, partition?.collectedSequence || 0, partition?.failureSequence || 0].join(':');
    return [key, { state: sourceState(partition), revision }];
  }));
}

function cpuModel(cpu, available) {
  const load = cpu.loadAverage;
  return {
    available,
    usagePercent: optionalNumber(cpu.usagePercent),
    coreCount: cpu.coreCount,
    loadAverage: { oneMinute: fixedText(load.oneMinute, 1), fiveMinutes: fixedText(load.fiveMinutes, 1), fifteenMinutes: fixedText(load.fifteenMinutes, 1) },
  };
}

function memoryModel(memory, available) {
  const text = (bytes) => available ? formatMemoryBytes(bytes) : '--';
  return {
    available,
    usagePercent: available ? optionalNumber(memory.usagePercent) : null,
    usedText: text(memory.usedBytes),
    availableText: text(memory.availableBytes),
    totalText: text(memory.totalBytes),
  };
}

function networkModel(network) {
  const receive = optionalNumber(network.receiveBytesPerSecond);
  const transmit = optionalNumber(network.transmitBytesPerSecond);
  return {
    receiveBytesPerSecond: receive,
    transmitBytesPerSecond: transmit,
    receiveText: formatBytesPerSecond(receive),
    transmitText: formatBytesPerSecond(transmit),
    totalText: formatBytesPerSecond(receive !== null && transmit !== null ? receive + transmit : null),
  };
}

function sshTrafficModel(ssh) {
  if (!ssh.isSsh) return { isSsh: false };
  return {
    isSsh: true,
    uploadBytesPerSecond: optionalNumber(ssh.clientUploadBytesPerSecond),
    downloadBytesPerSecond: optionalNumber(ssh.clientDownloadBytesPerSecond),
    uploadText: formatBytesPerSecond(ssh.clientUploadBytesPerSecond),
    downloadText: formatBytesPerSecond(ssh.clientDownloadBytesPerSecond),
    latencyText: formatDuration(ssh.latencyMilliseconds),
  };
}

function diskIoModel(diskIo) {
  const read = optionalNumber(diskIo.readBytesPerSecond);
  const write = optionalNumber(diskIo.writeBytesPerSecond);
  const rateText = (value) => value !== null ? formatBytesPerSecond(value) : '--';
  return {
    readBytesPerSecond: read,
    writeBytesPerSecond: write,
    readText: rateText(read),
    writeText: rateText(write),
    totalText: read !== null && write !== null ? formatBytesPerSecond(read + write) : '--',
  };
}

function buildMonitorViewModel(snapshot, diskConfig = {}) {
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
  const devices = buildGpuModels(acceleratorData, processes, !snapshot.accelerators.lastError);
  const currentUserDevices = acceleratorData.currentUserDeviceKeys.map((key) => devices.find((device) => device.deviceKey === key)).filter(Boolean);
  return {
    sources: buildSources(snapshot),
    performance: {
      cpu: cpuModel(cpu, available('cpu')),
      memory: memoryModel(memory, available('memory')),
      gpus: devices,
      network: networkModel(network),
      sshTraffic: sshTrafficModel(ssh),
      disks: buildDisks(topology, diskConfig),
      diskIo: diskIoModel(diskIo),
    },
    processes: buildProcessRows(processes, acceleratorData),
    processTotalCount: processSample.totalCount,
    processRevision: [snapshot.processes?.collectedSequence || 0, snapshot.accelerators.collectedSequence || 0].join(':'),
    currentUserNativeIndices: currentUserDevices.map((device) => device.idx),
  };
}
module.exports = { buildMonitorViewModel, displayDeviceName };
