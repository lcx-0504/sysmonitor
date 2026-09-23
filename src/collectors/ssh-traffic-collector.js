'use strict';
const { performance } = require('node:perf_hooks');

function parseSshByteCounters(raw, clientIp) {
  let serverSentBytes = 0; let serverReceivedBytes = 0; let includeRecord = false;
  const latencies = [];
  for (const line of raw.split('\n')) {
    if (line && !/^\s/.test(line)) includeRecord = /:22(?:\s|$)/.test(line) && (!clientIp || line.includes(clientIp));
    if (!includeRecord) continue;
    const sent = line.match(/bytes_sent:(\d+)/); const received = line.match(/bytes_received:(\d+)/);
    const rtt = line.match(/\brtt:([\d.]+)\//);
    if (sent) serverSentBytes += Number(sent[1]);
    if (received) serverReceivedBytes += Number(received[1]);
    if (rtt) latencies.push(Number(rtt[1]));
  }
  return { serverSentBytes, serverReceivedBytes, latencyMilliseconds: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null };
}

class SshTrafficCollector {
  constructor({ commandRunner, isSsh, clientIp, monotonicClock = () => performance.now() }) { this.commandRunner = commandRunner; this.isSsh = isSsh; this.clientIp = clientIp; this.monotonicClock = monotonicClock; this.previous = null; }
  async collect() {
    if (!this.isSsh) return { isSsh: false, clientUploadBytesPerSecond: null, clientDownloadBytesPerSecond: null, latencyMilliseconds: null };
    const { stdout } = await this.commandRunner.execFile('ss', ['-H', '-t', '-i', '-n', 'state', 'established'], { timeoutMilliseconds: 2000 });
    const counters = parseSshByteCounters(stdout, this.clientIp); const sampledAt = this.monotonicClock();
    let clientUploadBytesPerSecond = null; let clientDownloadBytesPerSecond = null;
    if (this.previous) {
      const seconds = (sampledAt - this.previous.sampledAt) / 1000;
      const uploadDelta = counters.serverReceivedBytes - this.previous.serverReceivedBytes;
      const downloadDelta = counters.serverSentBytes - this.previous.serverSentBytes;
      if (seconds > 0 && uploadDelta >= 0 && downloadDelta >= 0) { clientUploadBytesPerSecond = uploadDelta / seconds; clientDownloadBytesPerSecond = downloadDelta / seconds; }
    }
    this.previous = { ...counters, sampledAt };
    return { isSsh: true, clientUploadBytesPerSecond, clientDownloadBytesPerSecond, latencyMilliseconds: counters.latencyMilliseconds };
  }
}
module.exports = { parseSshByteCounters, SshTrafficCollector };
