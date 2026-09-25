'use strict';

const VIRTUAL_FILE_SYSTEMS = new Set(['tmpfs', 'devtmpfs', 'sysfs', 'proc', 'efivarfs', 'squashfs', 'cgroup', 'cgroup2', 'configfs', 'debugfs', 'devpts', 'fusectl', 'hugetlbfs', 'mqueue', 'pstore', 'securityfs', 'binfmt_misc', 'autofs', 'tracefs', 'ramfs', 'bpf']);
const DEFAULT_EXCLUSIONS = 'vfat,/proc,/sys,/run,/snap,/usr,/etc,/dev,/init';

function normalizeMountRules(diskConfig) {
  const filter = typeof diskConfig === 'string' ? diskConfig : diskConfig.mountFilter || 'default';
  if (filter === 'default') return DEFAULT_EXCLUSIONS;
  if (filter === 'more') return '';
  if (filter === 'all') return null;
  if (filter === 'custom') return [diskConfig.customFsExclude, diskConfig.customPathExclude].filter(Boolean).join(',');
  return filter || DEFAULT_EXCLUSIONS;
}

function parseRules(rawRules) {
  const fileSystemTypes = []; const pathPrefixes = [];
  for (const rule of (rawRules || '').split(',').map((value) => value.trim()).filter(Boolean)) {
    if (rule.startsWith('/')) pathPrefixes.push(rule); else fileSystemTypes.push(rule);
  }
  return { fileSystemTypes, pathPrefixes };
}

function shouldExclude(fileSystemType, mountPath, diskConfig) {
  const normalized = normalizeMountRules(diskConfig);
  if (normalized === null) return false;
  const showVirtual = diskConfig.mountFilter === 'custom' && diskConfig.showVirtualFs;
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
  if (!Array.isArray(filesystems)) throw Object.assign(new Error('Incomplete findmnt output'), { code: 'EINCOMPLETE' });
  return filesystems.reduce((mounts, entry) => {
    const fileSystemType = entry.fstype || ''; const mountPath = entry.target || '';
    if (shouldExclude(fileSystemType, mountPath, diskConfig)) return mounts;
    if (!hasCapacity(entry.size, entry.used, entry.avail)) return mounts;
    const totalBytes = Number(entry.size); const usedBytes = Number(entry.used);
    const availableBytes = Number(entry.avail);
    mounts.push({ mountPath, fileSystemType, totalBytes, usedBytes, availableBytes, usagePercent: Number.parseInt(entry['use%'], 10) || 0 });
    return mounts;
  }, []);
}

function parseDfOutput(raw, diskConfig) {
  if (!raw.trim()) throw Object.assign(new Error('Empty df output'), { code: 'EINCOMPLETE' });
  return raw.trim().split('\n').slice(1).reduce((mounts, line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 7) throw Object.assign(new Error('Incomplete df output'), { code: 'EINCOMPLETE' });
    const [source, fileSystemType, blocks, used, available, percent, ...mountParts] = fields;
    void source;
    const mountPath = mountParts.join(' '); const totalBytes = Number(blocks) * 1024;
    if (shouldExclude(fileSystemType, mountPath, diskConfig)) return mounts;
    if (!hasCapacity(blocks, used, available)) return mounts;
    mounts.push({ mountPath, fileSystemType, totalBytes, usedBytes: Number(used) * 1024, availableBytes: Number(available) * 1024, usagePercent: Number.parseInt(percent, 10) || 0 });
    return mounts;
  }, []);
}

module.exports = { normalizeMountRules, parseDfOutput, parseFindmntOutput, parseRules, shouldExclude };
