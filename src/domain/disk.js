'use strict';

const { incompleteError } = require('../utils/errors');

const VIRTUAL_FILE_SYSTEMS = new Set([
  'tmpfs', 'devtmpfs', 'sysfs', 'proc', 'efivarfs', 'squashfs', 'cgroup', 'cgroup2', 'configfs', 'debugfs', 'devpts',
  'fusectl', 'hugetlbfs', 'mqueue', 'pstore', 'securityfs', 'binfmt_misc', 'autofs', 'tracefs', 'ramfs', 'bpf',
]);
const DISK_PRESETS = Object.freeze({
  default: Object.freeze({ customFsExclude: 'vfat', customPathExclude: '/proc,/sys,/run,/snap,/usr,/etc,/dev,/init', hideVirtualFs: true }),
  more: Object.freeze({ customFsExclude: '', customPathExclude: '', hideVirtualFs: true }),
  all: Object.freeze({ customFsExclude: '', customPathExclude: '', hideVirtualFs: false }),
});
const DEFAULT_EXCLUSIONS = [DISK_PRESETS.default.customFsExclude, DISK_PRESETS.default.customPathExclude].join(',');

function normalizeMountRules(diskConfig) {
  const filter = diskConfig.mountFilter || 'default';
  if (filter === 'default') return DEFAULT_EXCLUSIONS;
  if (filter === 'more') return '';
  if (filter === 'all') return null;
  if (filter === 'custom') return [diskConfig.customFsExclude, diskConfig.customPathExclude].filter(Boolean).join(',');
  return DEFAULT_EXCLUSIONS;
}

function parseRules(rawRules) {
  const fileSystemTypes = [];
  const pathPrefixes = [];
  for (const rule of (rawRules || '').split(/[,\r\n]+/).map((value) => value.trim()).filter(Boolean)) {
    if (rule.startsWith('/')) pathPrefixes.push(rule); else fileSystemTypes.push(rule);
  }
  return { fileSystemTypes, pathPrefixes };
}

function shouldExclude(fileSystemType, mountPath, diskConfig) {
  const normalized = normalizeMountRules(diskConfig);
  if (normalized === null) return false;
  const showVirtual = diskConfig.mountFilter === 'custom' && diskConfig.hideVirtualFs === false;
  if (!showVirtual && VIRTUAL_FILE_SYSTEMS.has(fileSystemType)) return true;
  const { fileSystemTypes, pathPrefixes } = parseRules(normalized);
  return fileSystemTypes.includes(fileSystemType) || pathPrefixes.some((prefix) => mountPath === prefix || mountPath.startsWith(`${prefix.replace(/\/$/, '')}/`));
}

function hasCapacity(total, used, available) {
  return [total, used, available].every((value) => value != null && String(value).trim() !== '' && Number.isFinite(Number(value)))
    && Number(total) > 0 && Number(used) >= 0 && Number(available) >= 0;
}

function parseFindmntOutput(raw, diskConfig) {
  const filesystems = JSON.parse(raw).filesystems;
  if (!Array.isArray(filesystems)) throw incompleteError('Incomplete findmnt output');
  return filesystems.reduce((mounts, entry) => {
    const fileSystemType = entry.fstype || '';
    const mountPath = entry.target || '';
    if (shouldExclude(fileSystemType, mountPath, diskConfig)) return mounts;
    if (!hasCapacity(entry.size, entry.used, entry.avail)) return mounts;
    const totalBytes = Number(entry.size);
    const usedBytes = Number(entry.used);
    const availableBytes = Number(entry.avail);
    mounts.push({ mountPath, fileSystemType, totalBytes, usedBytes, availableBytes, usagePercent: Number.parseInt(entry['use%'], 10) || 0 });
    return mounts;
  }, []);
}

function diskSelectionSignature(config) {
  const rules = normalizeMountRules(config);
  return JSON.stringify({ rules, virtual: rules === null || config.mountFilter === 'custom' && config.hideVirtualFs === false });
}

function parseDfOutput(raw, diskConfig) {
  if (!raw.trim()) throw incompleteError('Empty df output');
  const lines = raw.trim().split('\n');
  if (lines.length < 2 || !/^Filesystem\s+Type\s+/.test(lines[0])) throw incompleteError('Incomplete df output');
  return lines.slice(1).reduce((mounts, line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 7) throw incompleteError('Incomplete df output');
    const [, fileSystemType, blocks, used, available, percent, ...mountParts] = fields;
    const mountPath = mountParts.join(' ');
    if (shouldExclude(fileSystemType, mountPath, diskConfig)) return mounts;
    if (!hasCapacity(blocks, used, available)) return mounts;
    mounts.push({
      mountPath, fileSystemType,
      totalBytes: Number(blocks) * 1024, usedBytes: Number(used) * 1024, availableBytes: Number(available) * 1024,
      usagePercent: Number.parseInt(percent, 10) || 0,
    });
    return mounts;
  }, []);
}

function parseMountInfo(raw, diskConfig) {
  if (!raw.trim()) throw incompleteError('Empty mount table');
  const decode = (value) => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
  const mounts = raw.trim().split('\n').filter(Boolean).map((line) => {
    const [mount, filesystem] = line.split(' - ');
    const fields = mount.split(' ');
    const fsFields = (filesystem || '').split(' ');
    if (fields.length < 6 || fsFields.length < 3) throw incompleteError('Incomplete mount table');
    // Capacity lookup needs the mount identifiers and paths, not large overlay superblock options.
    const mountInfo = fields.slice(0, 6).join(' ') + ' - ' + fsFields.slice(0, 2).join(' ') + ' rw';
    return { mountPath: decode(fields[4]), fileSystemType: fsFields[0], mountInfo };
  });
  return [...new Map(mounts.map((mount) => [mount.mountPath, mount])).values()].filter((mount) => !shouldExclude(mount.fileSystemType, mount.mountPath, diskConfig));
}

module.exports = { DISK_PRESETS, parseDfOutput, parseFindmntOutput, parseMountInfo, parseRules, shouldExclude, diskSelectionSignature };
