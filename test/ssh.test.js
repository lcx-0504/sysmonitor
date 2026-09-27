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

async function waitFor(check) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for SSH lifecycle');
}

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
  const result = channel.execFile(1, 'true', [], 100).then((value) => { finished = true; return value; });
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
