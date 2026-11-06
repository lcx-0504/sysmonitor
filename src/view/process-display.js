'use strict';

const PROCESS_DISPLAY_KEY = 'sysmonitor.processDisplay';
const PROCESS_DISPLAY_CHOICES = Object.freeze({ cpu: ['core', 'whole', 'both'], ram: ['size', 'percent', 'both'] });
const PROCESS_DISPLAY_FLAGS = ['expandName', 'expandCmd'];
const DEFAULT_PROCESS_DISPLAY = Object.freeze({ cpu: 'core', ram: 'size', expandName: false, expandCmd: false });

function isProcessDisplayValue(key, value) {
  if (PROCESS_DISPLAY_FLAGS.includes(key)) return typeof value === 'boolean';
  return Object.hasOwn(PROCESS_DISPLAY_CHOICES, key) && PROCESS_DISPLAY_CHOICES[key].includes(value);
}

function normalizeProcessDisplay(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const display = {};
  for (const [key, fallback] of Object.entries(DEFAULT_PROCESS_DISPLAY)) {
    display[key] = isProcessDisplayValue(key, source[key]) ? source[key] : fallback;
  }
  return display;
}

class ProcessDisplayPreference {
  constructor({ store = null, logger = () => {} } = {}) {
    this.store = store;
    this.logger = logger;
    this.value = null;
  }

  get() {
    if (!this.value) this.value = normalizeProcessDisplay(this.store ? this.store.get(PROCESS_DISPLAY_KEY, {}) : {});
    return this.value;
  }

  set(key, value) {
    if (!isProcessDisplayValue(key, value)) return null;
    const next = { ...this.get(), [key]: value };
    this.value = next;
    if (this.store) Promise.resolve().then(() => this.store.update(PROCESS_DISPLAY_KEY, next)).catch((error) => this.logger(error.message));
    return next;
  }
}

module.exports = { PROCESS_DISPLAY_KEY, DEFAULT_PROCESS_DISPLAY, normalizeProcessDisplay, ProcessDisplayPreference };
