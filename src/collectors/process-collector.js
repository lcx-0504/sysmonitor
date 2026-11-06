'use strict';
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { parseProcessOutput } = require('../domain/linux-parsers');
const PROCESS_SNAPSHOT_COMMAND = fs.readFileSync(path.join(__dirname, 'process-snapshot.sh'), 'utf8');
class ProcessCollector {
  constructor({ commandRunner, osModule = os, systemInfo = null, gpuEnabled = () => true, timeoutMilliseconds = 3000 }) { this.commandRunner = commandRunner; this.osModule = osModule; this.systemInfo = systemInfo; this.gpuEnabled = gpuEnabled; this.timeoutMilliseconds = timeoutMilliseconds; }
  async collect({ onPartial = () => {} } = {}) {
    const { stdout } = await this.commandRunner.execFile('sh', ['-c', PROCESS_SNAPSHOT_COMMAND, 'sysmonitor-processes', this.gpuEnabled() ? '1' : '0'], { timeoutMilliseconds: this.timeoutMilliseconds, maxBufferBytes: 16 * 1024 * 1024 });
    const header = stdout.match(/^__SYSMON_PROCESSES__ (\d+) (\d+)\n/);
    if (!header) throw Object.assign(new Error('Incomplete process snapshot'), { code: 'EINCOMPLETE' });
    const [totalMemory, coreCount] = this.systemInfo
      ? await Promise.all([this.systemInfo.totalMemoryBytes(), this.systemInfo.coreCount()])
      : [this.osModule.totalmem(), this.osModule.cpus().length];
    const rows = parseProcessOutput(stdout.slice(header[0].length), totalMemory).map(row => ({ ...row, cpuWhole:row.cpuUsagePercent / Math.max(1, coreCount) }));
    const totalCount = Number(header[1]);
    if (!Number.isSafeInteger(totalCount) || rows.length > 300 || rows.length > totalCount || totalCount > 0 && !rows.length || new Set(rows.map(row => row.pid)).size !== rows.length) {
      throw Object.assign(new Error('Invalid process candidate list'), { code: 'EINCOMPLETE' });
    }
    const sample = { rows, totalCount };
    if (Number(header[2]) !== 0) {
      onPartial({ value: sample });
      throw Object.assign(new Error('GPU process ranking query failed (exit ' + header[2] + ')'), { code: 'GPU_OCCUPANCY_UNAVAILABLE' });
    }
    return sample;
  }
}
module.exports = { ProcessCollector, PROCESS_SNAPSHOT_COMMAND };
