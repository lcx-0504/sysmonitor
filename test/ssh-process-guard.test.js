'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { SshProcessGuard } = require('../src/ssh/ssh-process-guard');
const { executionOptions, withCollectionContext } = require('../src/core/collection-context');

function fixture(t, { response, fail = false } = {}) {
  let enabled = false;
  const notices = [];
  let calls = 0;
  const guard = new SshProcessGuard({ canCheck: () => enabled,
    execFile: async (_command, args, options) => {
      calls++;
      assert.equal(options.trackProcess, false);
      assert.equal(executionOptions(options).timeoutMilliseconds, 5000);
      assert.doesNotMatch(args[1], /\b(?:kill|rm|rmdir|mkdir|mktemp|touch)\b/);
      if (fail) throw new Error('offline');
      return { stdout: response || 'BOOT aaaa-bbbb\n' + args.slice(3).map((pid) => `LIVE ${pid} ${Number(pid) * 10} S`).join('\n') };
    },
    onLimit: (pids, acknowledge) => notices.push({ pids, acknowledge }),
  });
  t.after(() => guard.dispose());
  return { guard, notices, calls: () => calls,
    add: (pid) => guard.track({ pid, startTime: String(pid * 10), bootId: 'aaaa-bbbb' }),
    async check() { enabled = true; await guard.check(); enabled = false; },
  };
}

test('four residual candidates are silent; five confirmed live processes alert once', async (t) => {
  const f = fixture(t);
  for (let pid = 1; pid <= 4; pid++) f.add(pid);
  await f.check();
  assert.equal(f.calls(), 0);
  f.add(5);
  await f.check();
  assert.deepEqual(f.notices[0].pids, [1, 2, 3, 4, 5]);
  await f.check();
  f.add(1);
  await f.check();
  assert.equal(f.notices.length, 1);
  f.notices[0].acknowledge();
  assert.equal(f.guard.records.size, 0);
  for (let pid = 6; pid <= 10; pid++) f.add(pid);
  await f.check();
  assert.deepEqual(f.notices[1].pids, [6, 7, 8, 9, 10]);
});

test('exited, reused and zombie PIDs do not count as live remnants', async (t) => {
  const f = fixture(t, { response: 'BOOT aaaa-bbbb\nGONE 1\nLIVE 2 999 R\nLIVE 3 30 Z\nLIVE 4 40 S\nUNKNOWN 5\n' });
  for (let pid = 1; pid <= 5; pid++) f.add(pid);
  await f.check();
  assert.equal(f.notices.length, 0);
  assert.deepEqual([...f.guard.records.values()].map((r) => r.pid), [4, 5]);
});

test('a server reboot invalidates earlier process identities', async (t) => {
  const f = fixture(t, { response: 'BOOT cccc-dddd\n' });
  for (let pid = 1; pid <= 5; pid++) f.add(pid);
  await f.check();
  assert.equal(f.guard.records.size, 0);
  assert.equal(f.notices.length, 0);
});

test('failed verification preserves candidates without claiming they are alive', async (t) => {
  const f = fixture(t, { fail: true });
  for (let pid = 1; pid <= 5; pid++) f.add(pid);
  await f.check();
  assert.equal(f.guard.records.size, 5);
  assert.equal(f.notices.length, 0);
});

test('verification uses its own deadline even after the original collector was cancelled', async (t) => {
  const f = fixture(t);
  for (let pid = 1; pid <= 5; pid++) f.add(pid);
  const controller = new AbortController();
  controller.abort(new Error('old deadline'));
  await withCollectionContext({ signal: controller.signal, deadline: Date.now() - 1000 }, () => f.check());
  assert.equal(f.notices.length, 1);
});

test('disposing the guard prevents a late verification from notifying', async () => {
  let finish;
  const guard = new SshProcessGuard({ canCheck: () => true,
    execFile: () => new Promise((resolve) => { finish = resolve; }),
    onLimit: () => assert.fail('late notification'),
  });
  for (let pid = 1; pid <= 5; pid++) guard.track({ pid, startTime: String(pid), bootId: 'aaaa' });
  const pending = guard.check();
  await new Promise(setImmediate);
  guard.dispose();
  finish({ stdout: 'BOOT aaaa\n' + [1, 2, 3, 4, 5].map((pid) => `LIVE ${pid} ${pid} S`).join('\n') });
  await pending;
  assert.equal(guard.timer, null);
});

test('local notification failures are reported and do not mark an unseen batch as notified', async (t) => {
  const errors = [];
  const failure = new Error('notification failed');
  const guard = new SshProcessGuard({
    execFile: async () => ({ stdout: 'BOOT aaaa\n' + [1, 2, 3, 4, 5].map((pid) => `LIVE ${pid} ${pid} S`).join('\n') }),
    onLimit: () => { throw failure; }, onError: (error) => errors.push(error),
  });
  t.after(() => guard.dispose());
  for (let pid = 1; pid <= 5; pid++) guard.track({ pid, startTime: String(pid), bootId: 'aaaa' });
  await guard.check();
  assert.deepEqual(errors, [failure]);
  assert.equal(guard.candidates().length, 5);
});

test('asynchronous notification failure restores the unacknowledged batch', async (t) => {
  const errors = [];
  const failure = new Error('notification window unavailable');
  const guard = new SshProcessGuard({
    execFile: async () => ({ stdout: 'BOOT aaaa\n' + [1, 2, 3, 4, 5].map((pid) => `LIVE ${pid} ${pid} S`).join('\n') }),
    onLimit: async () => { throw failure; }, onError: (error) => errors.push(error),
  });
  t.after(() => guard.dispose());
  for (let pid = 1; pid <= 5; pid++) guard.track({ pid, startTime: String(pid), bootId: 'aaaa' });
  await guard.check();
  await new Promise(setImmediate);
  assert.deepEqual(errors, [failure]);
  assert.equal(guard.candidates().length, 5);
});
