'use strict';

const SSH_SAMPLE_COMMAND = [
  'read -r started ignored < /proc/uptime || exit 1',
  'printf "__SYSMON_SSH_SAMPLE_START__ %s\\n" "$started"',
  'ss -t -i -n state established',
  'result=$?',
  'read -r finished ignored < /proc/uptime || exit 1',
  'printf "__SYSMON_SSH_SAMPLE_END__ %s\\n" "$finished"',
  'exit "$result"',
].join('\n');

function normalizeIp(ip) { return String(ip).replace(/^\[|\]$/g, '').replace(/^::ffff:(?=\d+\.)/i, '').toLowerCase(); }

function endpointOf(token) {
  const match = token.match(/^(.*):(\d+)$/);
  if (!match) return null;
  return { ip: normalizeIp(match[1]), port: Number(match[2]) };
}

function readSocketRecords(raw) {
  const records = new Map();
  let record = null;
  for (const line of raw.split('\n')) {
    if (line && !/^\s/.test(line)) {
      const endpoints = line.trim().split(/\s+/).map(endpointOf).filter(Boolean);
      record = endpoints.length === 2 ? { local: endpoints[0], peer: endpoints[1], sent: null, received: null, latency: null } : null;
      if (record) records.set(JSON.stringify(endpoints.map((endpoint) => [endpoint.ip, endpoint.port])), record);
    }
    if (!record) continue;
    const sent = line.match(/bytes_sent:(\d+)/); const received = line.match(/bytes_received:(\d+)/);
    const rtt = line.match(/\brtt:([\d.]+)(?:\/|\s|$)/);
    if (sent) record.sent = Number(sent[1]);
    if (received) record.received = Number(received[1]);
    if (rtt) record.latency = Number(rtt[1]);
  }
  return records;
}

const exactMatch = (record, connection) => record.local.ip === normalizeIp(connection.serverIp) && record.local.port === connection.serverPort
  && record.peer.ip === normalizeIp(connection.clientIp) && record.peer.port === connection.clientPort;
const portMatch = (record, connection) => record.local.port === connection.serverPort && record.peer.ip === normalizeIp(connection.clientIp);

function readSshSocketCounters(raw, clientIpOrConnection) {
  const connections = clientIpOrConnection && typeof clientIpOrConnection === 'object'
    ? (Array.isArray(clientIpOrConnection) ? clientIpOrConnection : [clientIpOrConnection]) : null;
  const records = [...readSocketRecords(raw)];
  let matches = connections
    ? connections.map((connection) => records.filter(([, record]) => exactMatch(record, connection)))
    : [records.filter(([, record]) => record.local.port === 22 && (!clientIpOrConnection || record.peer.ip === normalizeIp(clientIpOrConnection)))];
  let fallback = false;
  if (connections && matches.every((matched) => !matched.length)) {
    const relaxed = connections.map((connection) => records.filter(([, record]) => portMatch(record, connection)));
    fallback = relaxed.some((matched) => matched.length > 0);
    if (fallback) matches = relaxed;
  }
  const selected = new Map(matches.flat());
  const samples = [...selected.values()];
  const latencies = samples.map((sample) => sample.latency).filter(Number.isFinite);
  return {
    serverSentBytes: samples.reduce((sum, sample) => sum + (sample.sent || 0), 0),
    serverReceivedBytes: samples.reduce((sum, sample) => sum + (sample.received || 0), 0),
    latencyMilliseconds: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null,
    complete: samples.length > 0 && matches.every((matched) => matched.length > 0) && samples.every((sample) => sample.sent !== null || sample.received !== null),
    connectionKey: JSON.stringify([...selected.keys()].sort()),
    fallback,
  };
}

class SshTrafficCollector {
  constructor({ commandRunner, isSsh, clientIp, connectionInfo = null, onLog = () => {} }) {
    Object.assign(this, { commandRunner, isSsh, clientIp, connectionInfo, onLog });
    this.previous = null;
    this.fallback = false;
  }
  reset() { this.previous = null; this.sampleIdentity = undefined; }
  async collect() {
    if (!this.isSsh) return { isSsh: false, clientUploadBytesPerSecond: null, clientDownloadBytesPerSecond: null, latencyMilliseconds: null };
    const connection = this.connectionInfo ? this.connectionInfo() : null;
    const expectedIdentity = connection ? JSON.stringify((Array.isArray(connection) ? connection : [connection]).map((item) => [normalizeIp(item.serverIp), item.serverPort, normalizeIp(item.clientIp), item.clientPort]).sort()) : null;
    if (this.connectionInfo && (!connection || Array.isArray(connection) && !connection.length)) {
      this.previous = null;
      return { isSsh: true, sampleIdentity: 'unconnected', clientUploadBytesPerSecond: null, clientDownloadBytesPerSecond: null, latencyMilliseconds: null };
    }
    const { stdout } = await this.commandRunner.execFile('sh', ['-c', SSH_SAMPLE_COMMAND]);
    const counters = readSshSocketCounters(stdout, connection || this.clientIp);
    if (connection && counters.fallback !== this.fallback) {
      this.fallback = counters.fallback;
      this.onLog(counters.fallback ? 'SSH traffic: exact connection match failed; matching the SSH server port and client address'
        : 'SSH traffic: exact connection match restored');
    }
    const sampleIdentity = expectedIdentity || (counters.connectionKey !== '[]' ? counters.connectionKey : this.sampleIdentity);
    this.sampleIdentity = sampleIdentity;
    const start = stdout.match(/^__SYSMON_SSH_SAMPLE_START__ ([\d.]+)$/m);
    const end = stdout.match(/^__SYSMON_SSH_SAMPLE_END__ ([\d.]+)$/m);
    const startedAt = start ? Number(start[1]) * 1000 : NaN;
    const finishedAt = end ? Number(end[1]) * 1000 : NaN;
    if (!counters.complete || !Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
      return { isSsh: true, sampleIdentity, clientUploadBytesPerSecond: null, clientDownloadBytesPerSecond: null, latencyMilliseconds: counters.latencyMilliseconds };
    }
    const sampledAt = (startedAt + finishedAt) / 2;
    const connectionKey = counters.connectionKey;
    let clientUploadBytesPerSecond = null; let clientDownloadBytesPerSecond = null;
    let resetFields = [];
    if (this.previous && this.previous.connectionKey === connectionKey) {
      const seconds = (sampledAt - this.previous.sampledAt) / 1000;
      const uploadDelta = counters.serverReceivedBytes - this.previous.serverReceivedBytes;
      const downloadDelta = counters.serverSentBytes - this.previous.serverSentBytes;
      if (seconds > 0 && uploadDelta >= 0 && downloadDelta >= 0) { clientUploadBytesPerSecond = uploadDelta / seconds; clientDownloadBytesPerSecond = downloadDelta / seconds; }
      else if (seconds < 0 || uploadDelta < 0 || downloadDelta < 0) resetFields = seconds < 0 ? ['clientUploadBytesPerSecond', 'clientDownloadBytesPerSecond', 'latencyMilliseconds'] : ['clientUploadBytesPerSecond', 'clientDownloadBytesPerSecond'];
    }
    this.previous = { ...counters, sampledAt, connectionKey };
    return { isSsh: true, sampleIdentity, resetFields, clientUploadBytesPerSecond, clientDownloadBytesPerSecond, latencyMilliseconds: counters.latencyMilliseconds };
  }
}
module.exports = { SshTrafficCollector };
