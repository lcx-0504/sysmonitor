'use strict';

const SIZE_UNITS = ['K', 'M', 'G', 'T'];
const SIZE_BASE = 1024;

function formatSize(bytes, { compact = false } = {}) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—';
  let value = Math.max(0, bytes) / SIZE_BASE;
  let index = 0;
  while (value >= SIZE_BASE && index < SIZE_UNITS.length - 1) {
    value /= SIZE_BASE;
    index++;
  }
  return `${value.toFixed(1)}${compact ? '' : ' '}${SIZE_UNITS[index]}`;
}

function formatRate(bytesPerSecond, options = {}) {
  const size = formatSize(bytesPerSecond, options);
  return size === '—' ? size : `${size}/s`;
}

function formatSizePair(usedBytes, totalBytes) {
  const used = formatSize(usedBytes, { compact: true });
  const total = formatSize(totalBytes, { compact: true });
  if (used === '—' || total === '—') return `${used} / ${total}`;
  return `${used.slice(-1) === total.slice(-1) ? used.slice(0, -1) : used} / ${total}`;
}

function formatDuration(milliseconds) {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds)) return '—';
  const value = Math.max(0, milliseconds);
  if (value < 1000) return `${value.toFixed(1)} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)} s`;
  if (value < 3600000) return `${(value / 60000).toFixed(1)} m`;
  return `${(value / 3600000).toFixed(1)} h`;
}

const formatBytesPerSecond = (value) => formatRate(value);
const formatBytesPerSecondShort = (value) => formatRate(value, { compact: true });
const formatMemoryBytes = (value) => formatSize(value);
const formatDiskBytes = (value) => formatSize(value, { compact: true });

module.exports = {
  formatSize,
  formatSizePair,
  formatRate,
  formatDuration,
  formatBytesPerSecond,
  formatBytesPerSecondShort,
  formatDiskBytes,
  formatMemoryBytes,
};
