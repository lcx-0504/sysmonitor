'use strict';

const catalogs = require('./catalogs');

const ERROR_KEYS = Object.freeze({
  ETIMEDOUT: 'collectionTimeout',
  EBUSY: 'collectionBusy',
  EINCOMPLETE: 'collectionIncomplete',
  EREMOTE: 'remoteCommandFailed',
  EPLATFORM: 'remoteNotLinux',
  EMAXBUFFER: 'commandOutputTooLarge',
  ENOENT: 'commandNotFound',
  PS_UNSUPPORTED: 'psUnsupported',
  GPU_OCCUPANCY_UNAVAILABLE: 'gpuOccupancyUnavailable',
  GPU_IDENTITY_UNAVAILABLE: 'gpuIdentityUnavailable',
});

function resolveLanguage(language) {
  const code = String(language || 'en').toLowerCase();
  if (/^zh(?:-|$)/.test(code)) return /(?:tw|hk|mo|hant)/.test(code) ? 'zh-TW' : 'zh-CN';
  return 'en';
}

function createTranslator(language) {
  const locale = resolveLanguage(language);
  const dictionary = catalogs[locale];
  return (key, parameters = {}) => {
    const value = dictionary[key] ?? catalogs.en[key];
    if (value === undefined) throw new Error('Unknown translation: ' + key);
    return typeof value === 'function' ? value(parameters) : value;
  };
}

function localizeError(error, language) {
  if (!error) return '';
  if (typeof error !== 'object') return String(error);
  const key = Object.hasOwn(ERROR_KEYS, error.code) ? ERROR_KEYS[error.code] : null;
  if (!key) return String(error.message || '');
  return createTranslator(language)(key, { message: String(error.message || '').trim() });
}

module.exports = { catalogs, resolveLanguage, createTranslator, localizeError };
