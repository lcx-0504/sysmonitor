'use strict';
const fs = require('node:fs/promises');
const { parseMountInfo, parseDfOutput, parseFindmntOutput } = require('../domain/disk');
const CAPACITY_ARGS = ['--kernel', '--tab-file', '/proc/self/fd/0', '--list', '--bytes', '--output', 'FSTYPE,SIZE,USED,AVAIL,USE%,TARGET'];
class DiskTopologyCollector {
  constructor({ commandRunner, fileReader = fs, getDiskConfig }) {
    Object.assign(this, { commandRunner, fileReader, getDiskConfig });
  }

  async collect() {
    const config = this.getDiskConfig();
    const mounts = parseMountInfo(await this.fileReader.readFile('/proc/self/mountinfo', 'utf8'), config);
    if (!mounts.length) return [];
    const options = { input: mounts.map(mount => mount.mountInfo).join('\n') + '\n' };
    try {
      const { stdout } = await this.commandRunner.execFile('findmnt', [...CAPACITY_ARGS, '--json'], options);
      return parseFindmntOutput(stdout, config);
    } catch (error) {
      if (['ETIMEDOUT', 'ABORT_ERR'].includes(error.code)) throw error;
      const { stdout } = await this.commandRunner.execFile('df', ['-PTk', '--', ...mounts.map(mount => mount.mountPath)]);
      return parseDfOutput(stdout, config);
    }
  }
}
module.exports = { DiskTopologyCollector };
