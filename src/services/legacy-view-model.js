'use strict';
const { formatBytesPerSecond, formatBytesPerSecondShort, formatDiskBytes, formatMemoryBytes, formatSize, formatSizePair, formatDuration } = require('../utils/format');
const { getAcceleratorAvailability } = require('../domain/accelerator-availability');

const valueOf = (partition, fallback) => partition && partition.value !== null ? partition.value : fallback;
const numeric = (value) => typeof value === 'number' && Number.isFinite(value) ? value : 0;

function displayDeviceName(name) {
  const original = String(name || '').trim();
  return original.replace(/^(?:(?:NVIDIA|GeForce|Tesla)\s+)+/i, '').trim() || original || 'GPU';
}

function buildLegacyViewModel(snapshot, language) {
  const cpu = valueOf(snapshot.cpu, { usagePercent: null, coreCount: 0, loadAverage: { oneMinute: 0, fiveMinutes: 0, fifteenMinutes: 0 } });
  const memory = valueOf(snapshot.memory, { usagePercent: 0, usedBytes: 0, availableBytes: 0, totalBytes: 0 });
  const network = valueOf(snapshot.network, { receiveBytesPerSecond: null, transmitBytesPerSecond: null });
  const diskIo = valueOf(snapshot.diskIo, { readBytesPerSecond: null, writeBytesPerSecond: null });
  const ssh = valueOf(snapshot.sshTraffic, { isSsh: false, clientUploadBytesPerSecond: null, clientDownloadBytesPerSecond: null });
  const topology = valueOf(snapshot.diskTopology, []);
  const acceleratorData = valueOf(snapshot.accelerators, { devices: [], usagesByPid: new Map(), currentUserDeviceKeys: [] });
  const processes = valueOf(snapshot.processes, []);
  const receive = numeric(network.receiveBytesPerSecond); const transmit = numeric(network.transmitBytesPerSecond);
  const read = numeric(diskIo.readBytesPerSecond); const write = numeric(diskIo.writeBytesPerSecond);
  const currentUserDeviceKeys = new Set(acceleratorData.currentUserDeviceKeys);
  const gpuUsers = new Map();
  for (const processInfo of processes) {
    const usages = acceleratorData.usagesByPid.get(processInfo.pid) || [];
    for (const usage of usages) {
      if (!usage.deviceKey || (usage.processKey && usage.processKey !== processInfo.processKey)) continue;
      if (!gpuUsers.has(usage.deviceKey)) gpuUsers.set(usage.deviceKey, new Map());
      const users = gpuUsers.get(usage.deviceKey);
      const name = processInfo.userName;
      users.set(name, (users.get(name) || 0) + numeric(usage.memoryUsedBytes));
    }
  }
  const devices = acceleratorData.devices.map((device) => ({
    idx: device.nativeIndex, name: device.name, uuid: device.providerDeviceId,
    displayName: displayDeviceName(device.name), isMine: currentUserDeviceKeys.has(device.deviceKey),
    util: numeric(device.utilizationPercent), memUsed: Math.round(numeric(device.memory.usedBytes) / 1048576), memTotal: Math.round(numeric(device.memory.totalBytes) / 1048576),
    memUsedStr: formatSize(numeric(device.memory.usedBytes)), memTotalStr: formatSize(numeric(device.memory.totalBytes)),
    memPairStr: formatSizePair(numeric(device.memory.usedBytes), numeric(device.memory.totalBytes)),
    users: [...(gpuUsers.get(device.deviceKey) || new Map())].map(([name, usedBytes]) => ({ name, usedBytes, usedStr: formatSize(usedBytes, { compact: true }), percent: device.memory.totalBytes > 0 ? usedBytes / device.memory.totalBytes * 100 : 0 })).sort((left, right) => right.usedBytes - left.usedBytes || left.name.localeCompare(right.name)),
    temp: numeric(device.temperatureCelsius), power: device.power ? { draw: device.power.drawWatts.toFixed(0), limit: device.power.limitWatts.toFixed(0) } : null,
    deviceKey: device.deviceKey, availability: getAcceleratorAvailability(device), isIdle: getAcceleratorAvailability(device) === 'idle',
  }));
  const allProcessRows = processes.map((processInfo) => {
    const usages = (acceleratorData.usagesByPid.get(processInfo.pid) || []).filter((usage) => !usage.processKey || usage.processKey === processInfo.processKey);
    const gpus = usages.map((usage) => ({ idx: usage.nativeIndex, vram: Math.round(usage.memoryUsedBytes / 1048576), memTotal: usage.memoryTotalBytes === null ? 0 : Math.round(usage.memoryTotalBytes / 1048576), vramStr: formatSize(usage.memoryUsedBytes, { compact: true }), memTotalStr: usage.memoryTotalBytes === null ? '—' : formatSize(usage.memoryTotalBytes, { compact: true }), mappingStatus: usage.mappingStatus }));
    return { pid: processInfo.pid, processKey: processInfo.processKey, user: processInfo.userName, cpu: processInfo.cpuUsagePercent, cpuWhole: processInfo.cpuUsagePercent / Math.max(1, cpu.coreCount), mem: processInfo.memoryUsedBytes, memStr: formatSize(processInfo.memoryUsedBytes), memPct: processInfo.memoryUsagePercent, name: processInfo.processName, cmd: processInfo.commandLine, gpus, vram: gpus.reduce((sum, usage) => sum + usage.vram, 0) };
  });
  const candidateProcessKeys = new Set();
  [...allProcessRows].sort((left, right) => right.cpu - left.cpu).slice(0, 100).forEach((row) => candidateProcessKeys.add(row.processKey));
  [...allProcessRows].sort((left, right) => right.mem - left.mem).slice(0, 100).forEach((row) => candidateProcessKeys.add(row.processKey));
  allProcessRows.filter((row) => row.gpus.length > 0).forEach((row) => candidateProcessKeys.add(row.processKey));
  const processRows = allProcessRows.filter((row) => candidateProcessKeys.has(row.processKey));
  const disks = topology.map((disk) => ({ mount: disk.mountPath, usedStr: formatDiskBytes(disk.usedBytes), totalStr: formatDiskBytes(disk.totalBytes), pct: disk.usagePercent }));
  const diskIoModel = { r: read, w: write, rStr: formatBytesPerSecond(read), wStr: formatBytesPerSecond(write), rShort: formatBytesPerSecondShort(read), wShort: formatBytesPerSecondShort(write), total: read + write, totalStr: formatBytesPerSecond(read + write) };
  return {
    payload: {
      lang: language, cpu: numeric(cpu.usagePercent), cpuCores: cpu.coreCount,
      load1: cpu.loadAverage.oneMinute.toFixed(2), load5: cpu.loadAverage.fiveMinutes.toFixed(2), load15: cpu.loadAverage.fifteenMinutes.toFixed(2),
      mem: { percent: memory.usagePercent, usedStr: formatMemoryBytes(memory.usedBytes), availStr: formatMemoryBytes(memory.availableBytes), totalStr: formatMemoryBytes(memory.totalBytes) },
      gpus: devices, gpuLoading: snapshot.accelerators.status === 'loading',
      net: { rx: receive, tx: transmit, rxStr: formatBytesPerSecond(receive), txStr: formatBytesPerSecond(transmit), totalStr: formatBytesPerSecond(receive + transmit) },
      ssh: ssh.isSsh ? { isSSH: true, tx: numeric(ssh.clientUploadBytesPerSecond), rx: numeric(ssh.clientDownloadBytesPerSecond), txStr: formatBytesPerSecond(numeric(ssh.clientUploadBytesPerSecond)), rxStr: formatBytesPerSecond(numeric(ssh.clientDownloadBytesPerSecond)), latencyStr: formatDuration(ssh.latencyMilliseconds) } : { isSSH: false },
      disks, diskIO: diskIoModel,
    },
    processes: processRows,
    currentUserNativeIndices: acceleratorData.currentUserDeviceKeys.map((key) => devices.find((device) => device.deviceKey === key)).filter(Boolean).map((device) => device.idx),
  };
}
module.exports = { buildLegacyViewModel, displayDeviceName };
