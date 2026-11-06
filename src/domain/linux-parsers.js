'use strict';

const { parseProcessName } = require('./process');
const { incompleteError } = require('../utils/errors');

function parseCpuStat(raw) {
  const values = raw.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  if (!/^cpu\s/.test(raw) || values.length < 4 || !values.every(Number.isFinite)) throw incompleteError('Incomplete /proc/stat');
  // Guest time is already included in the user and nice counters.
  return { idle: values[3] + (values[4] || 0), total: values.slice(0, 8).reduce((sum, value) => sum + value, 0) };
}

function parseMemoryInfo(raw) {
  const readKilobytes = (key) => {
    const match = raw.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
    return match ? Number(match[1]) * 1024 : null;
  };
  const totalBytes = readKilobytes('MemTotal');
  const reclaimable = ['MemFree', 'Buffers', 'Cached'].map(readKilobytes);
  const availableBytes = readKilobytes('MemAvailable') ?? (reclaimable.includes(null) ? null : reclaimable.reduce((sum, value) => sum + value, 0));
  if (totalBytes === null || availableBytes === null || totalBytes <= 0 || availableBytes > totalBytes) throw incompleteError('Incomplete /proc/meminfo');
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
  if (raw.trim() && raw.split('\n').length < 3) throw incompleteError('Incomplete /proc/net/dev');
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
    const received = Number(counters[0]); const transmitted = Number(counters[8]);
    if (counters.length < 9 || !Number.isFinite(received) || !Number.isFinite(transmitted) || received < 0 || transmitted < 0) throw incompleteError('Incomplete /proc/net/dev');
    receiveBytes += received;
    transmitBytes += transmitted;
  }
  return { receiveBytes, transmitBytes, availableInterfaces };
}

function parseDiskIoCounters(raw) {
  let readSectors = 0;
  let writeSectors = 0;
  const devices = [];
  let parsedRows = 0;
  for (const line of raw.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 14) continue;
    parsedRows++;
    const deviceName = fields[2];
    if (/\d$/.test(deviceName) && !/^(?:nvme\d+n\d+|mmcblk\d+)$/.test(deviceName)) continue;
    if (/^(loop|ram|dm-)/.test(deviceName)) continue;
    const read = Number(fields[5]); const written = Number(fields[9]);
    if (!Number.isFinite(read) || !Number.isFinite(written) || read < 0 || written < 0) throw incompleteError('Incomplete /proc/diskstats');
    devices.push(`${fields[0]}:${fields[1]}:${deviceName}`);
    readSectors += read;
    writeSectors += written;
  }
  if (raw.trim() && !parsedRows) throw incompleteError('Incomplete /proc/diskstats');
  return { readBytes: readSectors * 512, writeBytes: writeSectors * 512, devices };
}

function processStartTime(text) { return Date.parse(text.trim() + ' UTC'); }

function parseProcessOutput(raw, totalMemoryBytes) {
  const processes = [];
  let parsedRows = 0;
  const linePattern = /^(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d{4})\s+(.+)$/;
  for (const line of raw.trim().split('\n')) {
    const match = line.trim().match(linePattern);
    if (!match) continue;
    parsedRows++;
    const pid = Number(match[1]);
    const cpuUsagePercent = Number(match[3]) || 0;
    const memoryUsedBytes = Number(match[4]) * 1024;
    if (memoryUsedBytes <= 1e6 && cpuUsagePercent <= 0) continue;
    const startedAt = processStartTime(`${match[5]} ${match[6]} ${match[7]} ${match[8]} ${match[9]}`);
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
  if (raw.trim() && !parsedRows) throw incompleteError('Incomplete process query output');
  return processes;
}

function parseProcessSessions(raw) {
  const sessions = new Map();
  for (const line of raw.split('\n')) {
    const [pid, type, ...parts] = line.split('\t');
    const id = parts.join('\t');
    if (!/^\d+$/.test(pid) || !id) continue;
    if (type === 'tmux') sessions.set(Number(pid), { type, name: id, id });
    const screen = type === 'screen' && id.match(/^\d+\.(.+)$/s);
    if (screen) sessions.set(Number(pid), { type, name: screen[1], id });
  }
  return sessions;
}

module.exports = { parseCpuStat, parseDefaultRouteInterfaces, parseDiskIoCounters, parseMemoryInfo, parseNetworkCounters, parseProcessOutput, parseProcessSessions, processStartTime };
