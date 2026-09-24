'use strict';
const os = require('node:os');
const { parseProcessOutput } = require('../domain/linux-parsers');
class ProcessCollector {
  constructor({ commandRunner, osModule = os, systemInfo = null, timeoutMilliseconds = 3000 }) { this.commandRunner = commandRunner; this.osModule = osModule; this.systemInfo = systemInfo; this.timeoutMilliseconds = timeoutMilliseconds; }
  async collect() {
    const { stdout } = await this.commandRunner.execFile('ps', ['-eo', 'pid=,user:32=,%cpu=,rss=,lstart=,args='], { timeoutMilliseconds: this.timeoutMilliseconds, maxBufferBytes: 16 * 1024 * 1024 });
    return parseProcessOutput(stdout, this.systemInfo ? await this.systemInfo.totalMemoryBytes() : this.osModule.totalmem());
  }
}
module.exports = { ProcessCollector };
