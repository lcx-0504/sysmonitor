'use strict';

const { DEFAULT_CONFIG } = require('./default-config');
const { CONFIGURATION_SCHEMA } = require('./config-schema');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function normalizeValue(value, definition, fallback) {
  if (definition.type === 'object') {
    const raw = isObject(value) ? value : {};
    const result = definition.additionalProperties === false ? {} : { ...raw };
    for (const [key, field] of Object.entries(definition.properties)) {
      if (Object.hasOwn(raw, key) || Object.hasOwn(fallback || {}, key)) result[key] = normalizeValue(raw[key], field, fallback?.[key]);
    }
    return result;
  }
  if (definition.type === 'array') {
    const values = Array.isArray(value) ? value : fallback;
    return [...new Set(values.filter(item => Number.isInteger(item) && item >= definition.items.minimum))].sort((a, b) => a - b);
  }
  if (definition.type === 'number' || definition.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    const bounded = Math.min(definition.maximum ?? Infinity, Math.max(definition.minimum ?? -Infinity, value));
    return definition.type === 'integer' ? Math.round(bounded) : bounded;
  }
  if (typeof value !== definition.type || definition.enum && !definition.enum.includes(value)) return fallback ?? (definition.type === 'string' ? '' : fallback);
  return value;
}

function normalizeConfig(value = {}) {
  const raw = isObject(value) ? value : {};
  return { ...raw, ...Object.fromEntries(Object.entries(CONFIGURATION_SCHEMA).map(([key, definition]) => [key, normalizeValue(raw[key], definition, DEFAULT_CONFIG[key])])) };
}

module.exports = { normalizeConfig };
