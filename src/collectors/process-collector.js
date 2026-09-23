'use strict';
const os = require('node:os');
const { parseProcessOutput } = require('../domain/linux-parsers');
class ProcessCollector {
  constructor({ commandRunner, osModule = os }) { this.commandRunner = commandRunner; this.osModule = osModule; }
  async collect() {
    const { stdout } = await this.commandRunner.execFile('ps', ['-eo', 'pid=,user:32=,%cpu=,rss=,lstart=,args='], { timeoutMilliseconds: 3000, maxBufferBytes: 16 * 1024 * 1024 });
    return parseProcessOutput(stdout, this.osModule.totalmem());
  }
}
module.exports = { ProcessCollector };
