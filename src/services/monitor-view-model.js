'use strict';
const { formatBytesPerSecond, formatDiskBytes, formatMemoryBytes, formatSize, formatSizePair, formatDuration } = require('../utils/format');
const { getAcceleratorAvailability } = require('../domain/accelerator-availability');

const valueOf = (partition, fallback) => partition && partition.value !== null ? partition.value : fallback;
const numeric = (value) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const roundedPercent = (used, total) => total > 0 ? Math.min(100, Math.max(0, Math.round(numeric(used) / total * 100))) : 0;

function displayDeviceName(name) {
  const original = String(name || '').trim();
  return original.replace(/^(?:(?:NVIDIA|GeForce|Tesla)\s+)+/i, '').trim() || original || 'GPU';
}

function groupGpuUsers(processes, usagesByPid) {
  const gpuUsers = new Map();
  for (const processInfo of processes) {
    const usages = usagesByPid.get(processInfo.pid) || [];
    for (const usage of usages) {
      if (!usage.deviceKey || (usage.processKey && usage.processKey !== processInfo.processKey)) continue;
      if (!gpuUsers.has(usage.deviceKey)) gpuUsers.set(usage.deviceKey, new Map());
      const users = gpuUsers.get(usage.deviceKey);
      const name = processInfo.userName;
      users.set(name, (users.get(name) || 0) + numeric(usage.memoryUsedBytes));
    }
  }
  return gpuUsers;
}

function buildGpuModels(acceleratorData, processes) {
  const currentUserDeviceKeys = new Set(acceleratorData.currentUserDeviceKeys);
  const gpuUsers = groupGpuUsers(processes, acceleratorData.usagesByPid);
  return acceleratorData.devices.map((device) => ({
    idx: device.nativeIndex, name: device.name, uuid: device.providerDeviceId,
    displayName: displayDeviceName(device.name), isMine: currentUserDeviceKeys.has(device.deviceKey),
    util: numeric(device.utilizationPercent), memUsed: Math.round(numeric(device.memory.usedBytes) / 1048576), memTotal: Math.round(numeric(device.memory.totalBytes) / 1048576),
    memUsedStr: formatSize(numeric(device.memory.usedBytes)), memTotalStr: formatSize(numeric(device.memory.totalBytes)),
    memPairStr: formatSizePair(numeric(device.memory.usedBytes), numeric(device.memory.totalBytes)),
    memPct: roundedPercent(device.memory.usedBytes, device.memory.totalBytes),
    users: [...(gpuUsers.get(device.deviceKey) || new Map())].map(([name, usedBytes]) => ({ name, usedBytes, usedStr: formatSize(usedBytes, { compact: true }), percent: roundedPercent(usedBytes, device.memory.totalBytes) })).sort((left, right) => right.usedBytes - left.usedBytes || left.name.localeCompare(right.name)),
    temp: numeric(device.temperatureCelsius), power: device.power ? { draw: device.power.drawWatts.toFixed(0), limit: device.power.limitWatts.toFixed(0) } : null,
    deviceKey: device.deviceKey, availability: getAcceleratorAvailability(device), isIdle: getAcceleratorAvailability(device) === 'idle',
  }));
}

function buildProcessRows(processes, acceleratorData, coreCount) {
  const allProcessRows = processes.map((processInfo) => {
    const usages = (acceleratorData.usagesByPid.get(processInfo.pid) || []).filter((usage) => !usage.processKey || usage.processKey === processInfo.processKey);
    const gpus = usages.map((usage) => ({ idx: usage.nativeIndex, vram: Math.round(usage.memoryUsedBytes / 1048576), memTotal: usage.memoryTotalBytes === null ? 0 : Math.round(usage.memoryTotalBytes / 1048576), vramStr: formatSize(usage.memoryUsedBytes, { compact: true }), memTotalStr: usage.memoryTotalBytes === null ? '—' : formatSize(usage.memoryTotalBytes, { compact: true }), pct: roundedPercent(usage.memoryUsedBytes, usage.memoryTotalBytes), mappingStatus: usage.mappingStatus }));
    return { pid: processInfo.pid, processKey: processInfo.processKey, user: processInfo.userName, cpu: processInfo.cpuUsagePercent, cpuWhole: processInfo.cpuUsagePercent / Math.max(1, coreCount), mem: processInfo.memoryUsedBytes, memStr: formatSize(processInfo.memoryUsedBytes), memPct: processInfo.memoryUsagePercent, name: processInfo.processName, cmd: processInfo.commandLine, gpus, vram: gpus.reduce((sum, usage) => sum + usage.vram, 0) };
  });
  const candidateProcessKeys = new Set();
  [...allProcessRows].sort((left, right) => right.cpu - left.cpu).slice(0, 100).forEach((row) => candidateProcessKeys.add(row.processKey));
  [...allProcessRows].sort((left, right) => right.mem - left.mem).slice(0, 100).forEach((row) => candidateProcessKeys.add(row.processKey));
  allProcessRows.filter((row) => row.gpus.length > 0).forEach((row) => candidateProcessKeys.add(row.processKey));
  return allProcessRows.filter((row) => candidateProcessKeys.has(row.processKey));
}

function buildDisks(topology, diskConfig) {
  let disks = topology.map((disk) => {
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
  const cpu = valueOf(snapshot.cpu, { usagePercent: null, coreCount: 0, loadAverage: { oneMinute: 0, fiveMinutes: 0, fifteenMinutes: 0 } });
  const memory = valueOf(snapshot.memory, { usagePercent: 0, usedBytes: 0, availableBytes: 0, totalBytes: 0 });
  const network = valueOf(snapshot.network, { receiveBytesPerSecond: null, transmitBytesPerSecond: null });
  const diskIo = valueOf(snapshot.diskIo, { readBytesPerSecond: null, writeBytesPerSecond: null });
  const ssh = valueOf(snapshot.sshTraffic, { isSsh: false, clientUploadBytesPerSecond: null, clientDownloadBytesPerSecond: null });
  const topology = valueOf(snapshot.diskTopology, []);
  const acceleratorData = valueOf(snapshot.accelerators, { devices: [], usagesByPid: new Map(), currentUserDeviceKeys: [] });
  const processes = valueOf(snapshot.processes, []);
  const receive = numeric(network.receiveBytesPerSecond);
  const transmit = numeric(network.transmitBytesPerSecond);
  const read = numeric(diskIo.readBytesPerSecond);
  const write = numeric(diskIo.writeBytesPerSecond);
  const devices = buildGpuModels(acceleratorData, processes);
  const processRows = buildProcessRows(processes, acceleratorData, cpu.coreCount);
  const disks = buildDisks(topology, diskConfig);
  return {
    performance: {
      language,
      cpu: { usagePercent: numeric(cpu.usagePercent), coreCount: cpu.coreCount, loadAverage: {
        oneMinute: cpu.loadAverage.oneMinute.toFixed(1), fiveMinutes: cpu.loadAverage.fiveMinutes.toFixed(1), fifteenMinutes: cpu.loadAverage.fifteenMinutes.toFixed(1),
      } },
      memory: { usagePercent: memory.usagePercent, usedText: formatMemoryBytes(memory.usedBytes), availableText: formatMemoryBytes(memory.availableBytes), totalText: formatMemoryBytes(memory.totalBytes) },
      gpus: devices, gpuLoading: snapshot.accelerators.status === 'loading',
      network: { receiveBytesPerSecond: receive, transmitBytesPerSecond: transmit, receiveText: formatBytesPerSecond(receive), transmitText: formatBytesPerSecond(transmit), totalText: formatBytesPerSecond(receive + transmit) },
      sshTraffic: ssh.isSsh ? { isSsh: true, uploadBytesPerSecond: numeric(ssh.clientUploadBytesPerSecond), downloadBytesPerSecond: numeric(ssh.clientDownloadBytesPerSecond), uploadText: formatBytesPerSecond(numeric(ssh.clientUploadBytesPerSecond)), downloadText: formatBytesPerSecond(numeric(ssh.clientDownloadBytesPerSecond)), latencyText: formatDuration(ssh.latencyMilliseconds) } : { isSsh: false },
      disks, diskIo: {
        readBytesPerSecond: read, writeBytesPerSecond: write,
        readText: formatBytesPerSecond(read), writeText: formatBytesPerSecond(write),
        totalBytesPerSecond: read + write, totalText: formatBytesPerSecond(read + write),
      },
    },
    processes: processRows,
    currentUserNativeIndices: acceleratorData.currentUserDeviceKeys.map((key) => devices.find((device) => device.deviceKey === key)).filter(Boolean).map((device) => device.idx),
  };
}
module.exports = { buildMonitorViewModel, displayDeviceName };
