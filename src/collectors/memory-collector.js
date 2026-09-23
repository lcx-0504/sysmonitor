'use strict';
const fs = require('node:fs/promises');
const { parseMemoryInfo } = require('../domain/linux-parsers');
class MemoryCollector { constructor({ fileReader = fs } = {}) { this.fileReader = fileReader; } async collect() { return parseMemoryInfo(await this.fileReader.readFile('/proc/meminfo', 'utf8')); } }
module.exports = { MemoryCollector };
