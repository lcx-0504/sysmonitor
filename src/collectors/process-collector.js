'use strict';
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { parseProcessOutput, parseProcessSessions } = require('../domain/linux-parsers');
const { incompleteError } = require('../utils/errors');
const { REFRESH_SETTING } = require('../config/default-config');
const PROCESS_SNAPSHOT_COMMAND = fs.readFileSync(path.join(__dirname, 'process-snapshot.sh'), 'utf8');
const UNSUPPORTED_PS_STATUS = 65;
const PROCESS_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const MAX_PROCESS_ROWS = 400;
const SESSIONS_MARKER = /(?:^|\n)__SYSMON_SESSIONS__\n/;

const positive = value => Number.isFinite(value) && value > 0;

class ProcessCollector {
  constructor({ commandRunner, osModule = os, systemInfo = null, knownTotals = () => ({}), gpuEnabled = () => true, refreshInterval = () => REFRESH_SETTING.default }) {
    Object.assign(this, { commandRunner, osModule, systemInfo, knownTotals, gpuEnabled, refreshInterval });
  }

  async systemTotals() {
    const known = this.knownTotals();
    const systemMemory = () => this.systemInfo ? this.systemInfo.totalMemoryBytes() : this.osModule.totalmem();
    const systemCores = () => this.systemInfo ? this.systemInfo.coreCount() : this.osModule.cpus().length;
    const [totalMemory, coreCount] = await Promise.all([
      positive(known.totalMemoryBytes) ? known.totalMemoryBytes : systemMemory(),
      positive(known.coreCount) ? known.coreCount : systemCores(),
    ]);
    return { totalMemory, coreCount };
  }

  async collect({ onPartial = () => {} } = {}) {
    let stdout;
    try {
      const args = ['-c', PROCESS_SNAPSHOT_COMMAND, 'sysmonitor-processes', this.gpuEnabled() ? '1' : '0', String(this.refreshInterval())];
      ({ stdout } = await this.commandRunner.execFile('sh', args, { maxBufferBytes: PROCESS_OUTPUT_LIMIT_BYTES }));
    } catch (error) {
      if ((error.exitCode ?? error.code) !== UNSUPPORTED_PS_STATUS) throw error;
      throw Object.assign(new Error('ps does not support the required output format'), { code: 'PS_UNSUPPORTED' });
    }
    const header = stdout.match(/^__SYSMON_PROCESSES__ (\d+) (\d+)\n/);
    const body = header ? stdout.slice(header[0].length) : '';
    const marker = body.match(SESSIONS_MARKER);
    if (!header || !marker) throw incompleteError('Incomplete process snapshot');
    const { totalMemory, coreCount } = await this.systemTotals();
    const sessions = parseProcessSessions(body.slice(marker.index + marker[0].length));
    const rows = parseProcessOutput(body.slice(0, marker.index), totalMemory).map(row => ({ ...row,
      cpuWhole: row.cpuUsagePercent / Math.max(1, coreCount), session: sessions.get(row.pid) || null }));
    const totalCount = Number(header[1]);
    const uniquePids = new Set(rows.map(row => row.pid)).size === rows.length;
    const countable = Number.isSafeInteger(totalCount) && rows.length <= MAX_PROCESS_ROWS && rows.length <= totalCount;
    if (!countable || totalCount > 0 && !rows.length || !uniquePids) throw incompleteError('Invalid process candidate list');
    const sample = { rows, totalCount };
    if (Number(header[2]) !== 0) {
      onPartial({ value: sample });
      throw Object.assign(new Error('GPU process ranking query failed (exit ' + header[2] + ')'), { code: 'GPU_OCCUPANCY_UNAVAILABLE' });
    }
    return sample;
  }
}
module.exports = { ProcessCollector };
