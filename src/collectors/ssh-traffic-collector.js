'use strict';
const { performance } = require('node:perf_hooks');

function endpointOf(token) {
  const match = token.match(/^(.*):(\d+)$/);
  if (!match) return null;
  return { ip: match[1].replace(/^\[|\]$/g, ''), port: Number(match[2]) };
}

function matchesConnection(line, connection) {
  const endpoints = line.trim().split(/\s+/).map(endpointOf).filter(Boolean);
  return endpoints.some((endpoint) => endpoint.ip === connection.serverIp && endpoint.port === connection.serverPort)
    && endpoints.some((endpoint) => endpoint.ip === connection.clientIp && endpoint.port === connection.clientPort);
}

function parseSshByteCounters(raw, clientIpOrConnection) {
  let serverSentBytes = 0; let serverReceivedBytes = 0; let includeRecord = false;
  const latencies = [];
  for (const line of raw.split('\n')) {
    if (line && !/^\s/.test(line)) includeRecord = clientIpOrConnection && typeof clientIpOrConnection === 'object'
      ? matchesConnection(line, clientIpOrConnection)
      : /:22(?:\s|$)/.test(line) && (!clientIpOrConnection || line.includes(clientIpOrConnection));
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
  constructor({ commandRunner, isSsh, clientIp, connectionInfo = null, timeoutMilliseconds = 2000, monotonicClock = () => performance.now() }) { this.commandRunner = commandRunner; this.isSsh = isSsh; this.clientIp = clientIp; this.connectionInfo = connectionInfo; this.timeoutMilliseconds = timeoutMilliseconds; this.monotonicClock = monotonicClock; this.previous = null; }
  async collect() {
    if (!this.isSsh) return { isSsh: false, clientUploadBytesPerSecond: null, clientDownloadBytesPerSecond: null, latencyMilliseconds: null };
    const connection = this.connectionInfo ? this.connectionInfo() : null;
    if (this.connectionInfo && !connection) return { isSsh: false, clientUploadBytesPerSecond: null, clientDownloadBytesPerSecond: null, latencyMilliseconds: null };
    const { stdout } = await this.commandRunner.execFile('ss', ['-H', '-t', '-i', '-n', 'state', 'established'], { timeoutMilliseconds: this.timeoutMilliseconds });
    const counters = parseSshByteCounters(stdout, connection || this.clientIp); const sampledAt = this.monotonicClock();
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
