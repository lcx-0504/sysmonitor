'use strict';
const { parseDfOutput, parseFindmntOutput } = require('../domain/disk');
class DiskTopologyCollector {
  constructor({ commandRunner, getDiskConfig }) { this.commandRunner = commandRunner; this.getDiskConfig = getDiskConfig; }
  async collect() {
    const diskConfig = this.getDiskConfig();
    try {
      const { stdout } = await this.commandRunner.execFile('findmnt', ['-l', '-b', '-o', 'FSTYPE,SIZE,USED,AVAIL,USE%,TARGET', '--json'], { timeoutMilliseconds: 5000 });
      return parseFindmntOutput(stdout, diskConfig);
    } catch {
      const { stdout } = await this.commandRunner.execFile('df', ['-PT', '--local'], { timeoutMilliseconds: 5000 });
      return parseDfOutput(stdout, diskConfig);
    }
  }
}
module.exports = { DiskTopologyCollector };
