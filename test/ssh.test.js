'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { listSshHosts, parseWords } = require('../src/ssh/ssh-config');
const { SshTransport } = require('../src/ssh/ssh-transport');
const { SshChannel } = require('../src/ssh/ssh-channel');
const { resourceCommandRunner } = require('./resource-fixture');

async function waitFor(check) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for SSH lifecycle');
}

test('SSH stdin roundtrips large data and remains usable after early stdin exit', async () => {
  const transport = new SshTransport({ host: 'fixture', requireLinux: false,
    spawnProcess: () => spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  try {
    const input = '中文\0\n'.repeat(80000);
    assert.equal((await transport.execFile('cat', [], { input, timeoutMilliseconds: 5000 })).stdout, input);
    assert.equal((await transport.execFile('true', [], { input })).stdout, '');
    assert.equal((await transport.execFile('printf', ['next'])).stdout, 'next');
  } finally { transport.dispose(); }
});

test('SSH dispatch passes the remaining budget after queueing', async () => {
  const frames = [];
  const transport = new SshTransport({ host: 'fixture', requireLinux: false, maxConnections: 1,
    spawnProcess: () => {
      const child = spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] });
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (text, ...args) => { if (text.startsWith('RUN ')) frames.push(text); return write(text, ...args); };
      return child;
    },
  });
  try {
    await transport.connect();
    await Promise.all([transport.execFile('sleep', ['0.1']), transport.execFile('true', [], { timeoutMilliseconds: 1000 })]);
    const remaining = Number(frames[1].trim().split(' ')[3]);
    assert.ok(remaining > 0 && remaining < 0.96, String(remaining));
  } finally { transport.dispose(); }
});

test('remote timeout reports a timeout and leaves the same channel available', async () => {
  const transport = new SshTransport({ host: 'fixture', requireLinux: false,
    spawnProcess: () => spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  try {
    await transport.connect();
    const channel = [...transport.channels][0];
    if (!channel.timeoutAvailable) return;
    await assert.rejects(channel.execFile({ id: 50, command: 'sleep', args: ['1'], limit: 1000, trackProcess: false, timeoutMilliseconds: 50 }), { code: 'ETIMEDOUT' });
    assert.equal(channel.closed, false);
    assert.equal((await channel.execFile({ id: 51, command: 'printf', args: ['alive'], limit: 1000 })).stdout, 'alive');
  } finally { transport.dispose(); }
});

test('a timeout before the process START header remains a timeout and preserves the channel', async () => {
  const channel = new SshChannel({ onClose() { assert.fail('A valid timeout response must not close the channel'); } });
  channel.ready = true; channel.timeoutAvailable = true; channel.child = { stdin: { write() {} } };
  const result = assert.rejects(channel.execFile({ id: 1, command: 'sleep', args: ['1'], limit: 1000, trackProcess: false, timeoutMilliseconds: 1 }), { code: 'ETIMEDOUT' });
  for (const char of '\n' + channel.prefix + 'END 1 124\n') channel.receive('stdout', char);
  channel.receive('stderr', '\n' + channel.prefix + 'END 1 124\n');
  await result; assert.equal(channel.closed, false); assert.equal(channel.request, null);
});

test('an incompatible timeout falls back to local deadlines and warns once per server session', async () => {
  const warnings = [];
  const transport = new SshTransport({ host: 'fixture', requireLinux: false, onWarning: key => warnings.push(key),
    spawnProcess: () => spawn('sh', ['-c', 'timeout() { return 143; }; . /dev/stdin'], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  try {
    await transport.connect();
    assert.equal([...transport.channels][0].timeoutAvailable, false);
    await Promise.all(Array.from({ length: 4 }, () => transport.execFile('sleep', ['0.05'])));
    assert.deepEqual(warnings, ['remoteTimeoutUnavailable']);
    assert.equal((await transport.execFile('printf', ['ok'])).stdout, 'ok');
  } finally { transport.dispose(); }
});

test('remote timeout terminates a signal-ignoring test command after its tool-managed grace period', async () => {
  const transport = new SshTransport({ host: 'fixture', requireLinux: false,
    spawnProcess: () => spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  try {
    await transport.connect(); const channel = [...transport.channels][0];
    if (!channel.timeoutAvailable) return;
    await assert.rejects(channel.execFile({ id: 60, command: 'sh', args: ['-c', 'trap "" TERM; exec sleep 3'], limit: 1000, trackProcess: false, timeoutMilliseconds: 100 }), { code: 'ETIMEDOUT' });
    assert.equal(channel.closed, false);
    assert.equal((await channel.execFile({ id: 61, command: 'true', limit: 1000 })).stdout, '');
  } finally { transport.dispose(); }
});

test('a large disk scan leaves SSH pool capacity available for CPU collection', async () => {
  const { DiskTopologyCollector } = require('../src/collectors/disk-topology-collector');
  const { ResourceCollector } = require('../src/collectors/resource-collector');
  const { CollectorRunner } = require('../src/core/collector-runner');
  const { SnapshotStore } = require('../src/core/snapshot-store');
  const transport = new SshTransport({ host: 'fixture', requireLinux: false,
    spawnProcess: () => spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  let diskCommands = 0;
  try {
    await Promise.all(Array.from({ length: 4 }, () => transport.execFile('true')));
    const disk = new DiskTopologyCollector({
      fileReader: { readFile: async () => Array.from({ length: 35 }, (_, index) =>
        `${index + 1} 0 8:0 / /disk${index} rw - ext4 source rw`).join('\n') },
      getDiskConfig: () => ({ mountFilter: 'all' }),
      commandRunner: { async execFile(command, args, options) {
        diskCommands++;
        assert.equal(command, 'findmnt');
        const mounts = require('../src/domain/disk').parseMountInfo(options.input, { mountFilter: 'all' });
        assert.equal(mounts.length, 35);
        const output = JSON.stringify({ filesystems: mounts.map(mount => ({ target: mount.mountPath, fstype: mount.fileSystemType, size: 100, used: 40, avail: 60, 'use%': '40%' })) });
        return transport.execFile('sh', ['-c', 'sleep 0.1; printf "%s" "$1"', 'sh', output], { timeoutMilliseconds: 2000 });
      } },
    });
    const disks = disk.collect();
    await new Promise(setImmediate);
    const store = new SnapshotStore();
    let cpuReads = 0;
    const reader = { readFile: (file) => transport.execFile('printf', ['%s', file === '/proc/stat'
      ? `cpu ${++cpuReads * 10} 2 3 4 5 6 7 8\ncpu0 1 2 3 4 5 6 7 8\n` : '1.0 2.0 3.0 1/100 123']).then(({ stdout }) => stdout) };
    const cpu = new CollectorRunner({ key: 'resources', grouped:true, resultKeys:['cpu'], collector: new ResourceCollector({ commandRunner:resourceCommandRunner(reader.readFile),keys:['cpu'] }),
      snapshotStore: store, timeoutMilliseconds: 250 });
    await cpu.run();
    const values = await disks;
    assert.equal(store.read().cpu.status, 'fresh');
    assert.equal(values.length, 35);
    assert.equal(diskCommands, 1);
  } finally { transport.dispose(); }
});

test('SSH pool performs concurrent requests without any temporary directory or file changes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sysmonitor-pool-test-'));
  await fs.writeFile(path.join(root, 'keep'), 'unchanged');
  const children = [];
  const transport = new SshTransport({ host: 'fixture', requireLinux: false,
    spawnProcess: () => {
      const child = spawn('sh', ['-s'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, TMPDIR: path.join(root, 'nonexistent') } });
      children.push(child);
      return child;
    },
  });
  t.after(async () => {
    transport.dispose();
    await waitFor(() => children.every((child) => child.exitCode !== null || child.signalCode !== null));
    await fs.rm(root, { recursive: true, force: true });
  });
  for (let round = 0; round < 3; round++) {
    await Promise.all(Array.from({ length: 12 }, (_, i) => transport.execFile('printf', [String(i)])));
    await assert.rejects(transport.execFile('sleep', ['0.3'], { timeoutMilliseconds: 20 }), /timed out/);
    await assert.rejects(transport.execFile('sh', ['-c', 'exit 7']), /exited \(7\)/);
    await assert.rejects(transport.execFile('printf', ['x'.repeat(100)], { maxBufferBytes: 16 }), { code: 'EMAXBUFFER' });
  }
  transport.dispose();
  await waitFor(() => children.every((child) => child.exitCode !== null || child.signalCode !== null));
  assert.deepEqual(await fs.readdir(root), ['keep']);
  assert.equal(await fs.readFile(path.join(root, 'keep'), 'utf8'), 'unchanged');
  const worker = await fs.readFile(path.join(__dirname, '../src/ssh/dispatcher.sh'), 'utf8');
  assert.doesNotMatch(worker, /\b(?:rm|rmdir|mktemp|mkdir|touch|ln|kill|pkill|killall|setsid)\b|\$!/);
});

test('SSH pool grows on demand to its limit and reuses established channels', async () => {
  let starts = 0;
  const transport = new SshTransport({ host: 'fixture', requireLinux: false,
    spawnProcess: () => { starts++; return spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }); },
  });
  try {
    await transport.connect();
    assert.equal(starts, 1);
    for (let round = 0; round < 2; round++) {
      await Promise.all(Array.from({ length: 8 }, () => transport.execFile('sleep', ['0.1'])));
      assert.equal(starts, 4);
      assert.equal(transport.channels.size, 4);
    }
  } finally { transport.dispose(); }
});

test('SSH transport options accept only the declared pool range and state listeners can unsubscribe', () => {
  const states = [];
  assert.throws(() => new SshTransport({ host: 'fixture', maxConnections: 0 }), /Invalid SSH pool size/);
  const transport = new SshTransport({ host: 'fixture', onState: (state) => states.push('initial:' + state) });
  try {
    assert.equal(transport.maxConnections, 4);
    assert.equal(transport.connectionTimeoutMilliseconds, 15000);
    assert.throws(() => transport.updateOptions({ maxConnections: 9 }), /Invalid SSH pool size/);
    transport.updateOptions({ connectionTimeoutMilliseconds: 20000, maxConnections: 8 });
    assert.equal(transport.connectionTimeoutMilliseconds, 20000);
    assert.equal(transport.connectionLimit, 8);
    const subscription = transport.onDidChangeState((state) => states.push('session:' + state));
    transport.emitState('connecting');
    subscription.dispose();
    transport.emitState('connected');
    assert.deepEqual(states, ['initial:connecting', 'session:connecting', 'initial:connected']);
  } finally { transport.dispose(); }
});

test('changing the SSH pool limit retires idle channels and lets active commands finish', async () => {
  const transport = new SshTransport({ host: 'fixture', requireLinux: false,
    spawnProcess: () => spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  try {
    const commands = Array.from({ length: 4 }, () => transport.execFile('sh', ['-c', 'sleep 0.2; printf done']));
    await waitFor(() => [...transport.channels].filter(channel => channel.request).length === 4);
    transport.updateOptions({ maxConnections: 1 });
    assert.deepEqual(await Promise.all(commands), Array(4).fill({ stdout: 'done', stderr: '' }));
    await waitFor(() => transport.channels.size === 1);
    assert.equal(transport.ready, true);
    await Promise.all(Array.from({ length: 3 }, () => transport.execFile('true')));
    assert.equal(transport.channels.size, 1);
    transport.updateOptions({ maxConnections: 3 });
    await Promise.all(Array.from({ length: 3 }, () => transport.execFile('sleep', ['0.1'])));
    assert.equal(transport.channels.size, 3);
  } finally { transport.dispose(); }
});

test('SSH pool capacity includes children still shutting down after a timeout', async () => {
  let alive = 0, peak = 0;
  const children = [];
  const transport = new SshTransport({ host: 'fixture', requireLinux: false, maxConnections: 1,
    spawnProcess: () => {
      const child = spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] });
      children.push(child); alive++; peak = Math.max(peak, alive);
      child.once('exit', () => alive--);
      return child;
    },
  });
  try {
    for (let i = 0; i < 5; i++) {
      await transport.connect();
      await assert.rejects(transport.execFile('sleep', ['0.08'], { timeoutMilliseconds: 20 }), /timed out/);
    }
    assert.equal(peak, 1);
  } finally {
    transport.dispose();
    await waitFor(() => children.every((child) => child.exitCode !== null || child.signalCode !== null));
  }
});

test('synchronous SSH spawn failure releases its slot and respects reconnect cooldown', async () => {
  let attempts = 0;
  const transport = new SshTransport({ host: 'fixture', spawnProcess() { attempts++; throw new Error('spawn failed'); } });
  try {
    await assert.rejects(transport.execFile('true'), /spawn failed/);
    await new Promise(setImmediate);
    assert.equal(attempts, 1);
    assert.equal(transport.channels.size, 0);
  } finally { transport.dispose(); }
});

test('queued cancellation and deadlines never execute the abandoned request', async () => {
  const sent = [];
  const transport = new SshTransport({ host: 'fixture', requireLinux: false, maxConnections: 1,
    spawnProcess: () => {
      const child = spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] });
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (text, ...args) => { sent.push(text); return write(text, ...args); };
      return child;
    },
  });
  try {
    await transport.connect();
    const slow = transport.execFile('sleep', ['0.2']);
    const controller = new AbortController();
    const cancelled = assert.rejects(transport.execFile('printf', ['cancelled-queued'], { signal: controller.signal }), /queued abort/);
    controller.abort(new Error('queued abort'));
    await cancelled;
    await assert.rejects(transport.execFile('printf', ['expired-queued'], { timeoutMilliseconds: 10 }), { code: 'ETIMEDOUT' });
    await slow;
    assert.equal((await transport.execFile('printf', ['healthy'])).stdout, 'healthy');
    const commands = sent.filter((line) => line.startsWith('RUN ')).map((line) => Buffer.from(line.trim().split(' ')[2], 'base64').toString());
    assert.equal(commands.some((command) => /cancelled-queued|expired-queued/.test(command)), false);
  } finally { transport.dispose(); }
});

test('read-only residual verification gets the next free slot before queued sampling', async () => {
  const transport = new SshTransport({ host: 'fixture', requireLinux: false, maxConnections: 1,
    spawnProcess: () => spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  try {
    await transport.connect();
    const order = [];
    const busy = transport.execFile('sleep', ['0.1']);
    const normal = transport.execFile('printf', ['sample']).then(() => order.push('sample'));
    const verification = transport.execFile('printf', ['verify'], { trackProcess: false }).then(() => order.push('verify'));
    await Promise.all([busy, normal, verification]);
    assert.deepEqual(order, ['verify', 'sample']);
  } finally { transport.dispose(); }
});

test('timeout replaces one busy channel while another channel completes normally', async () => {
  const states = [];
  const transport = new SshTransport({ host: 'fixture', requireLinux: false, maxConnections: 2,
    onState: (state) => states.push(state),
    spawnProcess: () => spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  try {
    await transport.connect();
    const timedOut = assert.rejects(transport.execFile('sleep', ['0.3'], { timeoutMilliseconds: 80 }), /timed out/);
    const healthy = transport.execFile('sh', ['-c', 'sleep 0.15; printf healthy']);
    await timedOut;
    assert.equal((await healthy).stdout, 'healthy');
    assert.equal((await transport.execFile('printf', ['next'])).stdout, 'next');
    assert.equal(states.includes('disconnected'), false);
  } finally { transport.dispose(); }
});

test('SSH output preserves empty strings, trailing newlines, UTF-8 and NUL bytes on both streams', async () => {
  const transport = new SshTransport({ host: 'fixture', requireLinux: false,
    spawnProcess: () => spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  try {
    assert.deepEqual(await transport.execFile('true'), { stdout: '', stderr: '' });
    assert.deepEqual(await transport.execFile('sh', ['-c', 'printf "中文\\000\\n\\n"; printf "error\\n\\n" >&2']),
      { stdout: '中文\0\n\n', stderr: 'error\n\n' });
  } finally { transport.dispose(); }
});

test('SSH dispose rejects queued and running requests and closes every channel', async () => {
  const children = [];
  const transport = new SshTransport({ host: 'fixture', requireLinux: false, maxConnections: 2,
    spawnProcess: () => { const child = spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child); return child; },
  });
  const results = Array.from({ length: 6 }, () => assert.rejects(transport.execFile('sleep', ['0.3']), /disposed/));
  await waitFor(() => transport.channels.size === 2 && [...transport.channels].every((channel) => channel.request));
  transport.dispose();
  await Promise.all(results);
  await waitFor(() => children.every((child) => child.exitCode !== null || child.signalCode !== null));
  assert.equal(transport.pending.size, 0);
  assert.equal(transport.channels.size, 0);
  await assert.rejects(transport.connect(), /disposed/);
});

test('SSH channel assembles split response markers and waits for both streams', async () => {
  const writes = [];
  const channel = new SshChannel({ onClose() {} });
  channel.ready = true;
  channel.child = { stdin: { write: (text) => writes.push(text) } };
  let finished = false;
  const result = channel.execFile({ id: 1, command: 'true', limit: 100 }).then((value) => { finished = true; return value; });
  const frame = '\n' + channel.prefix + 'END 1 0\n';
  for (const char of channel.prefix + 'START 1 123 456 aaaa-bbbb\ndata\n' + frame) channel.receive('stdout', char);
  assert.deepEqual(channel.request.remoteProcess, { pid: 123, startTime: '456', bootId: 'aaaa-bbbb' });
  await new Promise(setImmediate);
  assert.equal(finished, false);
  for (const char of 'error\n' + frame) channel.receive('stderr', char);
  assert.deepEqual(await result, { stdout: 'data\n', stderr: 'error\n' });
  assert.equal(writes.length, 1);
});

test('failure to add a pool channel preserves the established connection and queued work', async () => {
  let starts = 0;
  const states = [];
  const transport = new SshTransport({ host: 'fixture', requireLinux: false,
    onState: (state) => states.push(state),
    spawnProcess: () => spawn('sh', ++starts === 1 ? ['-s'] : ['-c', 'exit 255'], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  try {
    await transport.connect();
    await Promise.all([transport.execFile('sleep', ['0.1']), transport.execFile('printf', ['queued'])]);
    assert.equal(starts, 2);
    assert.equal(transport.channels.size, 1);
    assert.equal(states.includes('disconnected'), false);
    assert.equal((await transport.execFile('printf', ['alive'])).stdout, 'alive');
  } finally { transport.dispose(); }
});

test('disposing during SSH startup releases the pending connection without scheduling a retry', async () => {
  let child;
  const transport = new SshTransport({ host: 'fixture', requireLinux: false,
    spawnProcess: () => { child = spawn('sh', ['-c', 'sleep 0.1; exec sh -s'], { stdio: ['pipe', 'pipe', 'pipe'] }); return child; },
  });
  const rejected = assert.rejects(transport.connect(), /disposed/);
  transport.dispose();
  await rejected;
  await waitFor(() => child.exitCode !== null || child.signalCode !== null);
  assert.equal(transport.retryTimer, null);
  assert.equal(transport.channels.size, 0);
});

test('EOF and signals close idle SSH channels without a retry while paused', async () => {
  for (const ending of ['EOF', 'SIGTERM', 'SIGHUP']) {
    const transport = new SshTransport({ host: 'fixture', requireLinux: false, shouldReconnect: () => false,
      spawnProcess: () => spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }),
    });
    try {
      await transport.connect();
      const channel = [...transport.channels][0];
      if (ending === 'EOF') channel.child.stdin.end();
      else channel.child.kill(ending);
      await waitFor(() => channel.closed);
      assert.equal(transport.ready, false);
    } finally { transport.dispose(); }
  }
});

test('SSH host list reads explicit aliases and Include globs without duplicate or wildcard devices', async () => {
  const home = path.join(os.homedir(), 'sysmonitor-test-fixture');
  const config = path.join(home, '.ssh', 'config');
  const include = path.join(home, '.ssh', 'config.d', 'one.conf');
  const files = new Map([
    [config, 'Host campus lab007 *-gpu\n  HostName example.invalid\nInclude config.d/*.conf\nHost campus\n'],
    [include, 'Host lab008 ?ther !deny\n'],
  ]);
  const fileSystem = {
    async realpath(file) { if (!files.has(file)) throw new Error('not found'); return file; },
    async readFile(file) { return files.get(file); },
    async readdir(dir) { return dir === path.dirname(include) ? ['one.conf'] : []; },
  };
  assert.deepEqual(await listSshHosts(config, { home, fileSystem }), ['campus', 'lab007', 'lab008']);
});

test('SSH config ignores trailing comments and accepts whitespace around equals', async () => {
  assert.deepEqual(parseWords('"config #1" next # ignored words'), ['config #1', 'next']);
  const file = path.resolve('ssh-config-fixture');
  const hosts = await listSshHosts(file, { fileSystem: {
    realpath: async (value) => value,
    readFile: async () => 'Host = campus lab # ignored words\nHost=work\nHost "quoted#alias" # comment\n',
  } });
  assert.deepEqual(hosts, ['campus', 'lab', 'work', 'quoted#alias']);
});

test('SSH pool preserves command arguments and connection identities', async () => {
  let starts = 0;
  const transport = new SshTransport({
    host: 'fixture',
    requireLinux: false,
    spawnProcess: () => { starts++; return spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SSH_CONNECTION: '10.0.0.1 50000 10.0.0.2 22' } }); },
  });
  try {
    const values = await Promise.all([
      transport.execFile('printf', ["a'b\\n"], { timeoutMilliseconds: 3000 }),
      transport.execFile('printf', ['second'], { timeoutMilliseconds: 3000 }),
    ]);
    assert.equal(values[0].stdout, "a'b\n");
    assert.equal(values[1].stdout, 'second');
    assert.ok(starts >= 1 && starts <= 2);
    assert.deepEqual(transport.sshConnections[0], { clientIp: '10.0.0.1', clientPort: 50000, serverIp: '10.0.0.2', serverPort: 22 });
    assert.equal(transport.sshConnections.length, 1);
    await assert.rejects(transport.execFile('sh', ['-c', 'exit 7'], { timeoutMilliseconds: 3000 }), /Remote command exited \(7\)/);
  } finally { transport.dispose(); }
});

test('SSH retry delay is stable and one command timeout leaves the session usable', async () => {
  const transport = new SshTransport({
    host: 'fixture', requireLinux: false,
    spawnProcess: () => spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  try {
    const retryAfter = Date.now() + 10000;
    transport.retryAfter = retryAfter;
    transport.lastError = new Error('SSH command timed out: cat');
    await assert.rejects(transport.execFile('cat', ['/proc/stat']), /SSH command timed out: cat/);
    assert.equal(transport.retryAfter, retryAfter);
    transport.retryAfter = Date.now() - 1;
    assert.equal((await transport.execFile('printf', ['recovered'], { timeoutMilliseconds: 3000 })).stdout, 'recovered');
    assert.equal(transport.retryAfter, 0);
    await assert.rejects(transport.execFile('sleep', ['1'], { timeoutMilliseconds: 10 }), /timed out/);
    assert.equal((await transport.execFile('printf', ['still connected'])).stdout, 'still connected');
  } finally { transport.dispose(); }
});

test('a fast SSH request completes while a slow request is still running', async () => {
  let starts = 0;
  const transport = new SshTransport({ host: 'fixture', requireLinux: false,
    spawnProcess: () => { starts++; return spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }); },
  });
  try {
    await transport.connect();
    let slowFinished = false;
    const slow = transport.execFile('sh', ['-c', 'sleep 0.3; printf slow']).then((value) => { slowFinished = true; return value; });
    const fast = await transport.execFile('printf', ['fast']);
    assert.equal(fast.stdout, 'fast');
    assert.equal(slowFinished, false);
    assert.equal((await slow).stdout, 'slow');
    assert.equal(starts, 2);
  } finally { transport.dispose(); }
});

test('parallel SSH responses preserve stdout, stderr, and request identity', async () => {
  const transport = new SshTransport({ host: 'fixture', requireLinux: false,
    spawnProcess: () => spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  try {
    const results = await Promise.all(Array.from({ length: 16 }, (_, index) => transport.execFile('sh', ['-c', 'printf "%s\\n" "$1"; printf "%s" "$2" >&2', 'fixture', 'value-' + index, 'error-' + index])));
    results.forEach((result, index) => assert.deepEqual(result, { stdout: 'value-' + index + '\n', stderr: 'error-' + index }));
  } finally { transport.dispose(); }
});

test('cancelling one SSH request leaves concurrent work and the connection intact', async () => {
  const transport = new SshTransport({ host: 'fixture', requireLinux: false,
    spawnProcess: () => spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  try {
    await transport.connect();
    const controller = new AbortController();
    const pending = transport.execFile('sleep', ['0.3'], { signal: controller.signal });
    const rejected = assert.rejects(pending, /cancelled by test/);
    await new Promise(setImmediate);
    controller.abort(new Error('cancelled by test'));
    await rejected;
    assert.equal((await transport.execFile('printf', ['alive'])).stdout, 'alive');
    assert.equal(transport.pending.size, 0);
    assert.equal(transport.retryAfter, 0);
  } finally { transport.dispose(); }
});

test('SSH cancellation stops waiting and lets a finite command finish naturally', async () => {
  const transport = new SshTransport({ host: 'fixture', requireLinux: false, maxConnections: 1,
    spawnProcess: () => spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  try {
    await transport.connect();
    const channel = [...transport.channels][0];
    let kills = 0;
    const kill = channel.child.kill.bind(channel.child);
    channel.child.kill = (...args) => { kills++; return kill(...args); };
    const controller = new AbortController();
    const rejected = assert.rejects(transport.execFile('sh', ['-c', 'printf started; sleep 0.3'], { signal: controller.signal }), /cancel waiting/);
    await waitFor(() => channel.request && channel.request.stdout.text === 'started');
    controller.abort(new Error('cancel waiting'));
    await rejected;
    assert.equal(channel.child.exitCode, null);
    assert.equal((await transport.execFile('printf', ['new channel'])).stdout, 'new channel');
    await waitFor(() => channel.child.exitCode !== null);
    assert.equal(channel.child.exitCode, 0);
    assert.equal(kills, 0);
  } finally { transport.dispose(); }
});

test('manual SSH retry bypasses the cooldown and reconnects immediately', async () => {
  const transport = new SshTransport({
    host: 'fixture', requireLinux: false,
    spawnProcess: () => spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  try {
    transport.retryAfter = Date.now() + 10000;
    transport.lastError = new Error('previous timeout');
    await assert.rejects(transport.connect(), /previous timeout/);
    await transport.retryNow();
    assert.equal(transport.ready, true);
    assert.equal(transport.retryAfter, 0);
    assert.equal(transport.lastError, null);
  } finally { transport.dispose(); }
});

test('SSH output limits are isolated from ordinary exit codes and later requests', async () => {
  const transport = new SshTransport({ host: 'fixture', requireLinux: false,
    spawnProcess: () => spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  try {
    await assert.rejects(transport.execFile('printf', ['x'.repeat(100)], { maxBufferBytes: 16 }), { code: 'EMAXBUFFER' });
    await assert.rejects(transport.execFile('sh', ['-c', 'exit 125']), /Remote command exited \(125\)/);
    assert.equal((await transport.execFile('printf', ['healthy'])).stdout, 'healthy');
  } finally { transport.dispose(); }
});

test('active SSH transport retries at cooldown expiry without a view timer', async () => {
  let attempts = 0;
  let connected = 0;
  let reconnectResolved;
  const reconnected = new Promise((resolve) => { reconnectResolved = resolve; });
  const transport = new SshTransport({
    host: 'fixture', requireLinux: false, retryDelayMilliseconds: 20,
    spawnProcess: () => { attempts++; return spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }); },
    onState: (state) => { if (state === 'connected' && ++connected === 2) reconnectResolved(); },
  });
  try {
    await transport.connect();
    transport.disconnect(new Error('temporary timeout'));
    let timeout;
    try {
      await Promise.race([reconnected, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('automatic retry did not start')), 1000); })]);
    } finally { clearTimeout(timeout); }
    assert.equal(attempts, 2);
  } finally { transport.dispose(); }
});

test('paused SSH transport does not automatically reconnect at cooldown expiry', async () => {
  let attempts = 0;
  const transport = new SshTransport({
    host: 'fixture', requireLinux: false, retryDelayMilliseconds: 20,
    shouldReconnect: () => false,
    spawnProcess: () => { attempts++; return spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }); },
  });
  try {
    await transport.connect();
    transport.disconnect(new Error('temporary timeout'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(attempts, 1);
  } finally { transport.dispose(); }
});

function fakeSshChild() {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    pid: 4242, exitCode: null, signalCode: null, kill() {} });
}

test('an SSH channel settles output that arrives after exit and reports diagnostics from after its handshake', async () => {
  const flush = () => new Promise(setImmediate);
  const errors = [];
  const child = fakeSshChild();
  const channel = new SshChannel({ host: 'fixture', spawnProcess: () => child, onClose: (_channel, error) => errors.push(error.message) });
  const connected = channel.connect();
  child.stderr.write('Warning: Permanently added fixture to the list of known hosts.\n');
  child.stdout.write(channel.prefix + 'READY 1 10.0.0.1 50000 10.0.0.2 22\n');
  await connected;
  const result = channel.execFile({ id: 1, command: 'printf', args: ['done'], limit: 1000 });
  child.stdout.write(channel.prefix + 'START 1 - - -\ndone');
  await flush();
  child.exitCode = 255;
  child.emit('exit', 255, null);
  child.stdout.write('\n' + channel.prefix + 'END 1 0\n');
  child.stderr.write('\n' + channel.prefix + 'END 1 0\n');
  assert.deepEqual(await result, { stdout: 'done', stderr: '' });
  assert.equal(channel.closed, false);
  child.stderr.write('Connection to fixture closed by remote host.\n');
  await flush();
  child.emit('close', 255, null);
  assert.deepEqual(errors, ['Connection to fixture closed by remote host.']);
  const quiet = fakeSshChild();
  const second = new SshChannel({ host: 'fixture', spawnProcess: () => quiet, onClose: (_channel, error) => errors.push(error.message) });
  const ready = second.connect();
  quiet.stderr.write('Warning: Permanently added fixture to the list of known hosts.\n');
  quiet.stdout.write(second.prefix + 'READY 1\n');
  await ready;
  quiet.exitCode = 255;
  quiet.emit('close', 255, null);
  assert.equal(errors.at(-1), 'SSH exited (255)');
});

test('an invalid remote timeout budget fails only its request and the dispatcher keeps serving', async () => {
  const dispatcher = await fs.readFile(path.join(__dirname, '../src/ssh/dispatcher.sh'), 'utf8');
  assert.equal(dispatcher.match(/run_command\(\)/g).length, 1);
  const transport = new SshTransport({ host: 'fixture', requireLinux: false,
    spawnProcess: () => spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  try {
    await transport.connect();
    const channel = [...transport.channels][0];
    await assert.rejects(channel.execFile({ id: 80, command: 'true', limit: 1000, trackProcess: false, timeoutMilliseconds: NaN }), { code: 'EREMOTE', message: /Invalid timeout budget/ });
    assert.equal(channel.closed, false);
    assert.equal((await channel.execFile({ id: 81, command: 'printf', args: ['alive'], limit: 1000 })).stdout, 'alive');
  } finally { transport.dispose(); }
});

test('an idle SSH transport keeps one channel and restores the pool when sampling resumes', async () => {
  let starts = 0;
  const transport = new SshTransport({ host: 'fixture', requireLinux: false,
    spawnProcess: () => { starts++; return spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }); },
  });
  try {
    await Promise.all(Array.from({ length: 4 }, () => transport.execFile('sleep', ['0.1'])));
    assert.equal(transport.channels.size, 4);
    transport.setIdle(true);
    await waitFor(() => transport.channels.size === 1);
    await Promise.all(Array.from({ length: 3 }, () => transport.execFile('sleep', ['0.05'])));
    assert.equal(transport.channels.size, 1);
    assert.equal(transport.ready, true);
    transport.setIdle(false);
    await Promise.all(Array.from({ length: 4 }, () => transport.execFile('sleep', ['0.1'])));
    assert.equal(transport.channels.size, 4);
    assert.equal(starts, 7);
  } finally { transport.dispose(); }
});

test('remote system facts share concurrent reads and cache only valid values', async () => {
  const { RemoteSystemInfo } = require('../src/ssh/remote-system-info');
  let reads = 0, memory = 'MemTotal: 0 kB\n', user = 'unknown\n';
  const info = new RemoteSystemInfo({
    fileReader: { async readFile(file) { reads++; await new Promise(setImmediate); return file === '/proc/meminfo' ? memory : 'cpu 1 2\ncpu0 1 2\ncpu1 1 2\n'; } },
    commandRunner: { async execFile() { return { stdout: user }; } },
  });
  await assert.rejects(info.totalMemoryBytes(), { code: 'EINCOMPLETE' });
  memory = 'MemTotal: 1000 kB\n';
  assert.deepEqual(await Promise.all([info.totalMemoryBytes(), info.totalMemoryBytes()]), [1024000, 1024000]);
  assert.equal(reads, 2);
  assert.equal(await info.totalMemoryBytes(), 1024000);
  assert.equal(reads, 2);
  assert.equal(await info.coreCount(), 2);
  await assert.rejects(info.userId(), { code: 'EINCOMPLETE' });
  user = '1000\n';
  assert.equal(await info.userId(), 1000);
});
