'use strict';
const { parseDfOutput, parseFindmntOutput } = require('../domain/disk');
class DiskTopologyCollector {
  constructor({ commandRunner, getDiskConfig, timeoutMilliseconds = 10000 }) { this.commandRunner = commandRunner; this.getDiskConfig = getDiskConfig; this.timeoutMilliseconds = timeoutMilliseconds; }
  async collect() {
    const diskConfig = this.getDiskConfig();
    try {
      const { stdout } = await this.commandRunner.execFile('findmnt', ['-l', '-b', '-o', 'FSTYPE,SIZE,USED,AVAIL,USE%,TARGET', '--json'], { timeoutMilliseconds: this.timeoutMilliseconds });
      return parseFindmntOutput(stdout, diskConfig);
    } catch (error) {
      if (error && ['ETIMEDOUT', 'ABORT_ERR'].includes(error.code)) throw error;
      const { stdout } = await this.commandRunner.execFile('df', ['-PTk'], { timeoutMilliseconds: this.timeoutMilliseconds });
      return parseDfOutput(stdout, diskConfig);
    }
  }
}
module.exports = { DiskTopologyCollector };
