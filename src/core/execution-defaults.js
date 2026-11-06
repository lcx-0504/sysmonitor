'use strict';

const { DEFAULT_CONFIG } = require('../config/default-config');

// Output limit for one command, local or remote, unless the caller sets maxBufferBytes.
const COMMAND_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
// Commands issued outside a collection budget fall back to the default standard collection timeout.
const DEFAULT_COMMAND_TIMEOUT_MILLISECONDS = DEFAULT_CONFIG.collection.standardTimeout * 1000;
const DEFAULT_CONNECTION_TIMEOUT_MILLISECONDS = DEFAULT_CONFIG.collection.connectionTimeout * 1000;

module.exports = { COMMAND_OUTPUT_LIMIT_BYTES, DEFAULT_COMMAND_TIMEOUT_MILLISECONDS, DEFAULT_CONNECTION_TIMEOUT_MILLISECONDS };
