'use strict';

const { SETTINGS } = require('./config-schema');

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNumberType = type => type === 'number' || type === 'integer';

function acceptsValue(value, definition) {
  if (isNumberType(definition.type)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    if (definition.type === 'integer' && !Number.isInteger(value)) return false;
    return value >= (definition.minimum ?? -Infinity) && value <= (definition.maximum ?? Infinity);
  }
  return typeof value === definition.type && (!definition.enum || definition.enum.includes(value));
}

function normalizeObject(value, definition) {
  const raw = isObject(value) ? value : {};
  const result = {};
  for (const [key, child] of Object.entries(definition.properties)) {
    if (child.optional && !Object.hasOwn(raw, key)) continue;
    result[key] = normalizeValue(raw[key], child);
  }
  return result;
}

function normalizeArray(value, definition) {
  const items = (Array.isArray(value) ? value : definition.default).filter(item => acceptsValue(item, definition.items));
  const unique = definition.uniqueItems ? [...new Set(items)] : items;
  return definition.sorted ? unique.sort((left, right) => left - right) : unique;
}

function normalizeNumber(value, definition) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return definition.default;
  const bounded = Math.min(definition.maximum ?? Infinity, Math.max(definition.minimum ?? -Infinity, value));
  return definition.type === 'integer' ? Math.round(bounded) : bounded;
}

function normalizeValue(value, definition) {
  if (definition.type === 'object') return normalizeObject(value, definition);
  if (definition.type === 'array') return normalizeArray(value, definition);
  if (isNumberType(definition.type)) return normalizeNumber(value, definition);
  return acceptsValue(value, definition) ? value : definition.default;
}

function normalizeConfig(value = {}) {
  return normalizeObject(value, { type: 'object', properties: SETTINGS });
}

module.exports = { normalizeConfig };
