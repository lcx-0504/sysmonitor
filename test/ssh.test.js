'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { listSshHosts, parseWords } = require('../src/ssh/ssh-config');
const { SshTransport } = require('../src/ssh/ssh-transport');

async function waitFor(check) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for dispatcher cleanup');
}

async function cleanupFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sysmonitor-cleanup-test-'));
  const sibling = path.join(root, 'sysmonitor.keep');
  await fs.mkdir(sibling);
  await fs.writeFile(path.join(sibling, 'keep'), 'another session');
  await fs.writeFile(path.join(root, 'keep'), 'unrelated file');
  const sessions = [];
  t.after(async () => {
    for (const { transport, child } of sessions) {
      transport.dispose();
      await waitFor(() => child.exitCode !== null || child.signalCode !== null);
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    async open() {
      const before = new Set(await fs.readdir(root));
      const transport = new SshTransport({ host: 'fixture', requireLinux: false, shouldReconnect: () => false,
        spawnProcess: () => spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: root } }),
      });
      await transport.connect();
      const child = transport.child;
      sessions.push({ transport, child });
      const created = (await fs.readdir(root)).filter((name) => !before.has(name));
      assert.equal(created.length, 1);
      return { transport, child, work: path.join(root, created[0]) };
    },
    async assertProtected() {
      assert.equal(await fs.readFile(path.join(root, 'keep'), 'utf8'), 'unrelated file');
      assert.equal(await fs.readFile(path.join(sibling, 'keep'), 'utf8'), 'another session');
    },
  };
}

test('SSH temporary files are reclaimed after success, failure, output limits and late cancellation', async (t) => {
  const fixture = await cleanupFixture(t);
  const { transport, child, work } = await fixture.open();
  for (let round = 0; round < 5; round++) {
    await Promise.all(Array.from({ length: 10 }, (_, i) => transport.execFile('printf', [String(i)])));
    await assert.rejects(transport.execFile('sh', ['-c', 'exit 7']), /exited \(7\)/);
    await assert.rejects(transport.execFile('printf', ['x'.repeat(100)], { maxBufferBytes: 16 }), { code: 'EMAXBUFFER' });
    await waitFor(async () => (await fs.readdir(work)).length === 0);
    child.stdin.write('CANCEL ' + transport.sequence + '\n');
    await transport.execFile('printf', ['barrier']);
    await waitFor(async () => (await fs.readdir(work)).length === 0);
  }
  await fixture.assertProtected();
  transport.dispose();
  await waitFor(async () => !(await fs.stat(work).catch(() => null)));
  await fixture.assertProtected();
});

test('SSH cancellation while awaiting the output lock cleans its job without removing another lock', async (t) => {
  const fixture = await cleanupFixture(t);
  const { transport, work } = await fixture.open();
  const lock = path.join(work, 'output-lock');
  await fs.writeFile(lock, 'another emitter');
  const controller = new AbortController();
  const rejected = assert.rejects(transport.execFile('printf', ['blocked'], { signal: controller.signal }), /cancel blocked emitter/);
  await waitFor(async () => (await fs.readdir(work)).some((name) => name.endsWith('.out')));
  controller.abort(new Error('cancel blocked emitter'));
  await rejected;
  await waitFor(async () => (await fs.readdir(work)).length === 1);
  assert.equal(await fs.readFile(lock, 'utf8'), 'another emitter');
  transport.dispose();
  await waitFor(async () => !(await fs.stat(work).catch(() => null)));
  await fixture.assertProtected();
});

test('SSH timeouts and immediate cancellation leave no per-request files across repeated rounds', async (t) => {
  const fixture = await cleanupFixture(t);
  const { transport, child, work } = await fixture.open();
  for (let round = 0; round < 10; round++) {
    await assert.rejects(transport.execFile('sleep', ['5'], { timeoutMilliseconds: 20 }), /timed out/);
    const controller = new AbortController();
    const rejected = assert.rejects(transport.execFile('sleep', ['5'], { signal: controller.signal }), /immediate cancel/);
    await new Promise(setImmediate);
    controller.abort(new Error('immediate cancel'));
    await rejected;
    child.stdin.write('CANCEL ' + transport.sequence + '\n');
    await transport.execFile('printf', ['barrier']);
    await waitFor(async () => (await fs.readdir(work)).length === 0);
  }
  await fixture.assertProtected();
});

for (const ending of ['dispose', 'SIGTERM', 'SIGHUP', 'EOF']) {
  test('SSH ' + ending + ' removes only its own session directory with running and blocked jobs', async (t) => {
    const fixture = await cleanupFixture(t);
    const first = await fixture.open();
    const second = await fixture.open();
    await fs.writeFile(path.join(first.work, 'output-lock'), 'held');
    const running = assert.rejects(first.transport.execFile('sleep', ['10']));
    const blocked = assert.rejects(first.transport.execFile('printf', ['blocked']));
    await waitFor(async () => (await fs.readdir(first.work)).filter((name) => name.endsWith('.out')).length === 2);
    if (ending === 'dispose') first.transport.dispose();
    else if (ending === 'EOF') first.child.stdin.end();
    else first.child.kill(ending);
    await Promise.all([running, blocked]);
    await waitFor(async () => !(await fs.stat(first.work).catch(() => null)));
    assert.equal((await second.transport.execFile('printf', ['still active'])).stdout, 'still active');
    assert.ok((await fs.stat(second.work)).isDirectory());
    await fixture.assertProtected();
  });
}

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

test('SSH transport shares one shell session and preserves command arguments and output', async () => {
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
    assert.equal(starts, 1);
    assert.deepEqual(transport.sshConnection, { clientIp: '10.0.0.1', clientPort: 50000, serverIp: '10.0.0.2', serverPort: 22 });
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
    assert.ok(transport.child);
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
    assert.equal(starts, 1);
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
    const pending = transport.execFile('sleep', ['2'], { signal: controller.signal });
    const rejected = assert.rejects(pending, /cancelled by test/);
    await new Promise(setImmediate);
    controller.abort(new Error('cancelled by test'));
    await rejected;
    assert.equal((await transport.execFile('printf', ['alive'])).stdout, 'alive');
    assert.equal(transport.pending.size, 0);
    assert.equal(transport.retryAfter, 0);
  } finally { transport.dispose(); }
});

test('SSH cancellation terminates the remote command process', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sysmonitor-cancel-'));
  const pidFile = path.join(directory, 'pid');
  const transport = new SshTransport({ host: 'fixture', requireLinux: false,
    spawnProcess: () => spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  try {
    await transport.connect();
    const controller = new AbortController();
    const command = transport.execFile('sh', ['-c', 'printf "%s" "$$" > "$1"; exec sleep 5', 'fixture', pidFile], { signal: controller.signal });
    const rejected = assert.rejects(command, /cancel process/);
    let pid;
    for (let attempt = 0; attempt < 100 && !pid; attempt++) {
      pid = Number(await fs.readFile(pidFile, 'utf8').catch(() => ''));
      if (!pid) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(pid > 0);
    controller.abort(new Error('cancel process'));
    await rejected;
    await transport.execFile('printf', ['cancel acknowledged']);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    transport.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
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
    assert.ok(transport.child);
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
