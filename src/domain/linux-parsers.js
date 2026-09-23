'use strict';

const { parseProcessName } = require('./process');

function parseCpuStat(raw) {
  const values = raw.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  return { idle: values[3] + (values[4] || 0), total: values.reduce((sum, value) => sum + value, 0) };
}

function parseMemoryInfo(raw) {
  const readKilobytes = (key) => {
    const match = raw.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
    return match ? Number(match[1]) * 1024 : null;
  };
  const totalBytes = readKilobytes('MemTotal');
  const availableBytes = readKilobytes('MemAvailable');
  if (totalBytes === null || availableBytes === null) throw new Error('Incomplete /proc/meminfo');
  const usedBytes = totalBytes - availableBytes;
  return { totalBytes, availableBytes, usedBytes, usagePercent: Math.round(usedBytes / totalBytes * 100) };
}

function parseDefaultRouteInterfaces(raw) {
  const interfaces = new Set();
  for (const line of raw.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const flags = Number.parseInt(fields[3], 16);
    if (fields[1] === '00000000' && (flags & 0x2) !== 0) interfaces.add(fields[0]);
  }
  return interfaces;
}

function parseNetworkCounters(raw, selectedInterfaces) {
  let receiveBytes = 0;
  let transmitBytes = 0;
  const availableInterfaces = [];
  for (const line of raw.split('\n').slice(2)) {
    const [namePart, countersPart] = line.split(':');
    if (!countersPart) continue;
    const interfaceName = namePart.trim();
    if (interfaceName === 'lo') continue;
    availableInterfaces.push(interfaceName);
    if (selectedInterfaces && selectedInterfaces.size > 0 && !selectedInterfaces.has(interfaceName)) continue;
    const counters = countersPart.trim().split(/\s+/);
    receiveBytes += Number(counters[0]) || 0;
    transmitBytes += Number(counters[8]) || 0;
  }
  return { receiveBytes, transmitBytes, availableInterfaces };
}

function parseDiskIoCounters(raw) {
  let readSectors = 0;
  let writeSectors = 0;
  for (const line of raw.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 14) continue;
    const deviceName = fields[2];
    if (/\d$/.test(deviceName) && !/^(nvme|mmc)\d+n\d+$/.test(deviceName)) continue;
    if (/^(loop|ram|dm-)/.test(deviceName)) continue;
    readSectors += Number.parseInt(fields[5], 10) || 0;
    writeSectors += Number.parseInt(fields[9], 10) || 0;
  }
  return { readBytes: readSectors * 512, writeBytes: writeSectors * 512 };
}

function parseProcessOutput(raw, totalMemoryBytes) {
  const processes = [];
  const linePattern = /^(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d{4})\s+(.+)$/;
  for (const line of raw.trim().split('\n')) {
    const match = line.trim().match(linePattern);
    if (!match) continue;
    const pid = Number(match[1]);
    const cpuUsagePercent = Number(match[3]) || 0;
    const memoryUsedBytes = Number(match[4]) * 1024;
    if (memoryUsedBytes <= 1e6 && cpuUsagePercent <= 0) continue;
    const startedAt = Date.parse(`${match[5]} ${match[6]} ${match[7]} ${match[8]} ${match[9]}`);
    const commandLine = match[10].trim();
    processes.push({
      pid,
      processKey: `${pid}:${Number.isFinite(startedAt) ? startedAt : 'unknown'}`,
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
      userName: match[2],
      processName: parseProcessName(commandLine),
      commandLine,
      cpuUsagePercent,
      memoryUsedBytes,
      memoryUsagePercent: totalMemoryBytes > 0 ? +(memoryUsedBytes / totalMemoryBytes * 100).toFixed(1) : 0,
      acceleratorUsages: [],
    });
  }
  return processes;
}

module.exports = { parseCpuStat, parseDefaultRouteInterfaces, parseDiskIoCounters, parseMemoryInfo, parseNetworkCounters, parseProcessOutput };
