'use strict';

const fields = {
  cpu: ['usagePercent', 'coreCount', 'loadAverage.oneMinute', 'loadAverage.fiveMinutes', 'loadAverage.fifteenMinutes'],
  memory: ['usagePercent', 'usedBytes', 'availableBytes', 'totalBytes'],
  network: ['receiveBytesPerSecond', 'transmitBytesPerSecond'],
  diskIo: ['readBytesPerSecond', 'writeBytesPerSecond'],
  sshTraffic: ['clientUploadBytesPerSecond', 'clientDownloadBytesPerSecond', 'latencyMilliseconds'],
};
const gpuFields = ['utilizationPercent', 'memory.usedBytes', 'memory.totalBytes', 'temperatureCelsius', 'power.drawWatts', 'power.limitWatts'];

function at(value, path) { return path.split('.').reduce((part, key) => part == null ? undefined : part[key], value); }
function retainFields(previous, incoming, paths) {
  const value = { ...incoming };
  for (const path of paths) {
    if (Number.isFinite(at(incoming, path)) || (incoming.resetFields || []).includes(path) || !Number.isFinite(at(previous, path))) continue;
    const keys = path.split('.'); let target = value;
    for (const key of keys.slice(0, -1)) { target[key] = { ...(target[key] || {}) }; target = target[key]; }
    target[keys.at(-1)] = at(previous, path);
  }
  return value;
}

function mergeSampleValue(key, previous, incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;
  if (key === 'accelerators') {
    const devices = new Map((previous?.devices || []).map((device) => [device.deviceKey, device]));
    const usagesByPid = new Map([...incoming.usagesByPid].map(([pid, usages]) => [pid, usages.map((usage) => {
      const old = (previous?.usagesByPid?.get(pid) || []).find((item) => usage.processKey && item.processKey === usage.processKey && item.deviceKey === usage.deviceKey);
      return retainFields(old, usage, ['memoryUsedBytes', 'memoryTotalBytes']);
    })]));
    return { ...incoming, usagesByPid, devices: (incoming.devices || []).map((device) => retainFields(devices.get(device.deviceKey), device, gpuFields)) };
  }
  if (!fields[key]) return incoming;
  if (incoming.sampleIdentity !== undefined && incoming.sampleIdentity !== previous?.sampleIdentity) previous = null;
  return retainFields(previous, incoming, fields[key]);
}

module.exports = { mergeSampleValue };
