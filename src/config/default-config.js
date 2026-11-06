'use strict';

const { SETTINGS, defaultValue } = require('./config-schema');

const range = ({ default: initial, minimum, maximum }) => Object.freeze({ default: initial, minimum, maximum });

const DEFAULT_CONFIG = defaultValue({ type: 'object', properties: SETTINGS });
const REFRESH_SETTING = range(SETTINGS.refreshInterval);
const SSH_POOL_SIZE = range(SETTINGS.collection.properties.sshPoolSize);
const COLLECTION_FIELDS = Object.freeze(Object.entries(SETTINGS.collection.properties)
  .filter(([, definition]) => definition.label)
  .map(([key, definition]) => Object.freeze({ key, label: definition.label, help: definition.help, ...range(definition) })));

module.exports = { DEFAULT_CONFIG, COLLECTION_FIELDS, REFRESH_SETTING, SSH_POOL_SIZE };
