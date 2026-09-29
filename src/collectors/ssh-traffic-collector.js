'use strict';

const SSH_SAMPLE_COMMAND = [
  'read -r started ignored < /proc/uptime || exit 1',
  'printf "__SYSMON_SSH_SAMPLE_START__ %s\\n" "$started"',
  'ss -H -t -i -n state established',
  'result=$?',
  'read -r finished ignored < /proc/uptime || exit 1',
  'printf "__SYSMON_SSH_SAMPLE_END__ %s\\n" "$finished"',
  'exit "$result"',
].join('\n');

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

function readSshSocketCounters(raw, clientIpOrConnection) {
  const connections = clientIpOrConnection && typeof clientIpOrConnection === 'object'
    ? (Array.isArray(clientIpOrConnection) ? clientIpOrConnection : [clientIpOrConnection]) : null;
  const records = new Map();
  let record = null;
  for (const line of raw.split('\n')) {
    if (line && !/^\s/.test(line)) {
      record = null;
      const endpoints = line.trim().split(/\s+/).map(endpointOf).filter(Boolean);
      const selected = connections ? connections.some((connection) => matchesConnection(line, connection))
        : endpoints.some((endpoint) => endpoint.port === 22)
          && (!clientIpOrConnection || endpoints.some((endpoint) => endpoint.ip === clientIpOrConnection));
      if (selected && endpoints.length === 2) {
        const key = JSON.stringify(endpoints.map((endpoint) => [endpoint.ip, endpoint.port]).sort());
        record = { header: line, sent: null, received: null, latency: null };
        records.set(key, record);
      }
    }
    if (!record) continue;
    const sent = line.match(/bytes_sent:(\d+)/); const received = line.match(/bytes_received:(\d+)/);
    const rtt = line.match(/\brtt:([\d.]+)\//);
    if (sent) record.sent = Number(sent[1]);
    if (received) record.received = Number(received[1]);
    if (rtt) record.latency = Number(rtt[1]);
  }
  const samples = [...records.values()];
  const latencies = samples.map((sample) => sample.latency).filter(Number.isFinite);
  return {
    serverSentBytes: samples.reduce((sum, sample) => sum + (sample.sent || 0), 0),
    serverReceivedBytes: samples.reduce((sum, sample) => sum + (sample.received || 0), 0),
    latencyMilliseconds: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null,
    complete: samples.length > 0 && samples.every((sample) => sample.sent !== null || sample.received !== null)
      && (!connections || connections.every((connection) => samples.some((sample) => matchesConnection(sample.header, connection)))),
    connectionKey: JSON.stringify([...records.keys()].sort()),
  };
}

function parseSshByteCounters(raw, clientIpOrConnection) {
  const { serverSentBytes, serverReceivedBytes, latencyMilliseconds } = readSshSocketCounters(raw, clientIpOrConnection);
  return { serverSentBytes, serverReceivedBytes, latencyMilliseconds };
}

class SshTrafficCollector {
  constructor({ commandRunner, isSsh, clientIp, connectionInfo = null, timeoutMilliseconds = 10000 }) { this.commandRunner = commandRunner; this.isSsh = isSsh; this.clientIp = clientIp; this.connectionInfo = connectionInfo; this.timeoutMilliseconds = timeoutMilliseconds; this.previous = null; }
  async collect() {
    if (!this.isSsh) return { isSsh: false, clientUploadBytesPerSecond: null, clientDownloadBytesPerSecond: null, latencyMilliseconds: null };
    const connection = this.connectionInfo ? this.connectionInfo() : null;
    if (this.connectionInfo && (!connection || Array.isArray(connection) && !connection.length)) {
      this.previous = null;
      return { isSsh: false, clientUploadBytesPerSecond: null, clientDownloadBytesPerSecond: null, latencyMilliseconds: null };
    }
    let stdout;
    try {
      ({ stdout } = await this.commandRunner.execFile('sh', ['-c', SSH_SAMPLE_COMMAND], { timeoutMilliseconds: this.timeoutMilliseconds }));
    } catch (error) { this.previous = null; throw error; }
    const counters = readSshSocketCounters(stdout, connection || this.clientIp);
    const start = stdout.match(/^__SYSMON_SSH_SAMPLE_START__ ([\d.]+)$/m);
    const end = stdout.match(/^__SYSMON_SSH_SAMPLE_END__ ([\d.]+)$/m);
    const startedAt = start ? Number(start[1]) * 1000 : NaN;
    const finishedAt = end ? Number(end[1]) * 1000 : NaN;
    if (!counters.complete || !Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
      this.previous = null;
      return { isSsh: true, clientUploadBytesPerSecond: null, clientDownloadBytesPerSecond: null, latencyMilliseconds: counters.latencyMilliseconds };
    }
    const sampledAt = (startedAt + finishedAt) / 2;
    const connectionKey = counters.connectionKey;
    let clientUploadBytesPerSecond = null; let clientDownloadBytesPerSecond = null;
    if (this.previous && this.previous.connectionKey === connectionKey) {
      const seconds = (sampledAt - this.previous.sampledAt) / 1000;
      const uploadDelta = counters.serverReceivedBytes - this.previous.serverReceivedBytes;
      const downloadDelta = counters.serverSentBytes - this.previous.serverSentBytes;
      if (seconds > 0 && uploadDelta >= 0 && downloadDelta >= 0) { clientUploadBytesPerSecond = uploadDelta / seconds; clientDownloadBytesPerSecond = downloadDelta / seconds; }
    }
    this.previous = { ...counters, sampledAt, connectionKey };
    return { isSsh: true, clientUploadBytesPerSecond, clientDownloadBytesPerSecond, latencyMilliseconds: counters.latencyMilliseconds };
  }
}
module.exports = { parseSshByteCounters, SshTrafficCollector };
