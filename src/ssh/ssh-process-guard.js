'use strict';

const { withCollectionContext } = require('../core/collection-context');

const LIMIT = 5;
const CHECK_INTERVAL_MS = 10000;
const VERIFY_PROCESSES = `
IFS= read -r boot < /proc/sys/kernel/random/boot_id || exit 1
printf 'BOOT %s\\n' "$boot"
for process in "$@"; do
  if [ ! -d "/proc/$process" ]; then
    printf 'GONE %s\\n' "$process"
  elif { IFS= read -r stat < "/proc/$process/stat"; } 2>/dev/null; then
    fields=\${stat##*) }
    set -- $fields
    state=$1
    shift 19
    printf 'LIVE %s %s %s\\n' "$process" "$1" "$state"
  else
    printf 'UNKNOWN %s\\n' "$process"
  fi
done`;

function processKey(process) { return [process.bootId, process.pid, process.startTime].join(':'); }

class SshProcessGuard {
  constructor({ execFile, canCheck = () => true, onLimit = () => {}, onError = () => {}, clock = () => Date.now() }) {
    Object.assign(this, { execFile, canCheck, onLimit, onError, clock });
    this.records = new Map();
    this.timer = null;
    this.checking = null;
    this.nextCheckAt = 0;
    this.closed = false;
  }

  track(process) {
    if (this.closed || !Number.isSafeInteger(process.pid) || process.pid <= 0
      || !/^\d+$/.test(process.startTime) || !/^[a-f\d-]+$/.test(process.bootId)) return;
    const key = processKey(process);
    if (!this.records.has(key)) this.records.set(key, { ...process, notified: false });
    this.schedule();
  }

  candidates() { return [...this.records.values()].filter((record) => !record.notified); }

  schedule() {
    if (this.closed || this.timer || this.checking || !this.canCheck() || this.candidates().length < LIMIT) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.check().catch(() => {});
    }, Math.max(1000, this.nextCheckAt - this.clock()));
  }

  check() {
    if (this.checking) return this.checking;
    if (this.closed || !this.canCheck() || this.candidates().length < LIMIT) return Promise.resolve();
    const batch = this.candidates();
    this.nextCheckAt = this.clock() + CHECK_INTERVAL_MS;
    this.checking = Promise.resolve().then(() => this.verify(batch)).then((result) => {
      if (this.closed || !result) return;
      const { stdout } = result;
      const lines = stdout.trim().split('\n');
      const boot = lines.shift().match(/^BOOT ([a-f\d-]+)$/);
      if (!boot) return;
      const statuses = new Map(lines.map((line) => {
        const [state, pid, startTime, status] = line.split(' ');
        return [Number(pid), { state, startTime, status }];
      }));
      const alive = [];
      for (const record of batch) {
        const key = processKey(record), result = statuses.get(record.pid);
        if (record.bootId !== boot[1] || result && (result.state === 'GONE'
          || result.state === 'LIVE' && (result.startTime !== record.startTime || ['Z', 'X'].includes(result.status)))) {
          this.records.delete(key);
        } else if (result && result.state === 'LIVE' && result.startTime === record.startTime
          && /^[RSDTtIWP]$/.test(result.status || '')) alive.push(record);
      }
      if (alive.length < LIMIT) return;
      const notification = this.onLimit(alive.map((record) => record.pid), () => {
        for (const record of alive) this.records.delete(processKey(record));
      });
      for (const record of alive) record.notified = true;
      Promise.resolve(notification).catch((error) => {
        if (this.closed) return;
        for (const record of alive) {
          if (this.records.get(processKey(record)) === record) record.notified = false;
        }
        this.onError(error);
        this.schedule();
      });
    }).catch((error) => this.onError(error)).finally(() => {
      this.checking = null;
      this.schedule();
    });
    return this.checking;
  }

  async verify(batch) {
    if (this.closed || !this.canCheck()) return null;
    try {
      return await withCollectionContext(null, () => this.execFile('sh',
        ['-c', VERIFY_PROCESSES, 'sysmonitor-check', ...batch.map((record) => String(record.pid))],
        { timeoutMilliseconds: 5000, trackProcess: false }));
    } catch {
      // A failed remote query leaves the process identities unconfirmed.
      return null;
    }
  }

  dispose() { this.closed = true; clearTimeout(this.timer); this.timer = null; this.records.clear(); }
}

module.exports = { SshProcessGuard };
