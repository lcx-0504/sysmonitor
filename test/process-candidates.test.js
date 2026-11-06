'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CommandRunner } = require('../src/core/command-runner');
const { CollectorRunner } = require('../src/core/collector-runner');
const { SnapshotStore } = require('../src/core/snapshot-store');
const { ProcessCollector } = require('../src/collectors/process-collector');
const { parseProcessSessions } = require('../src/domain/linux-parsers');
const { buildMonitorViewModel } = require('../src/services/monitor-view-model');
const { localizeError } = require('../src/i18n');

const SNAPSHOT_SCRIPT = fs.readFileSync(path.join(__dirname, '../src/collectors/process-snapshot.sh'), 'utf8');
const SHELLS = ['sh', ...['/bin/dash', '/bin/bash'].filter(shell => fs.existsSync(shell))];

const row = (pid, { ppid = 1, uid = 1000, user = 'alice', rss = 2048, command = 'train --name test' } = {}) =>
  `${pid} ${ppid} ${uid} ${user} ${rss} Sun Jul 13 12:34:56 2026 ${command}`;

function statLine(pid, { comm = 'task', ticks = 0, start = 1 } = {}) {
  const userTicks = Math.ceil(ticks / 2);
  return `${pid} (${comm}) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 ${userTicks} ${ticks - userTicks} 0 0 20 0 1 0 ${start} 1000 100\n`;
}

function writeProc(directory, stats, uptime) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'uptime'), uptime.toFixed(2) + ' 0.00\n');
  for (const [pid, stat] of Object.entries(stats)) {
    fs.mkdirSync(path.join(directory, pid));
    fs.writeFileSync(path.join(directory, pid, 'stat'), statLine(Number(pid), stat));
  }
}

const SHELL_FIXTURE = [
  'ps() { printf "PS_CALL\\n" >&2; cat "$FIXTURE_ROOT/ps"; return "$PS_STATUS"; }',
  'fixture_gpu() { printf "GPU_CALL\\n" >&2; printf "%s\\n" "$GPU_ROWS"; return "$GPU_STATUS"; }',
  'alias nvidia-smi=fixture_gpu',
  'getconf() { printf "%s\\n" "$CLOCK_TICKS"; }',
  'id() { printf "id\\n" >> "$FIXTURE_ROOT/session-calls"; printf "%s\\n" "$USER_ID"; }',
  'tmux() { printf "tmux\\n" >> "$FIXTURE_ROOT/session-calls"; [ -n "$TMUX_ROWS" ] || return 1; printf "%s\\n" "$TMUX_ROWS"; }',
  'screen() { printf "screen\\n" >> "$FIXTURE_ROOT/session-calls"; printf "%s\\n" "$SCREEN_ROWS"; return 1; }',
  'sleep() {',
  '  printf "%s\\n" "$1" >> "$FIXTURE_ROOT/sleeps"',
  '  case "$1:$SLEEP_FRACTIONS" in *.*:0) return 1 ;; esac',
  '  if [ -d "$FIXTURE_ROOT/next" ]; then rm -r "$SYSMON_PROC_ROOT" && mv "$FIXTURE_ROOT/next" "$SYSMON_PROC_ROOT"; fi',
  '}',
  'if [ -n "$ADVANCE_UPTIME" ]; then ps() { printf "%s 0.00\\n" "$ADVANCE_UPTIME" > "$SYSMON_PROC_ROOT/uptime"; cat "$FIXTURE_ROOT/ps"; }; fi',
  '',
].join('\n');

function fixture(t, rows, { first = {}, second = first, uptime = [100, 101], gpu = '', gpuStatus = 0, gpuEnabled = true, psStatus = 0, interval = 2,
  tmux = '', screen = '', userId = '1000', clockTicks = 100, sleepFractions = true, advanceUptime = '', shell = 'sh', prelude = '', tmuxServer = tmux !== '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysmonitor-processes-'));
  const runner = new CommandRunner();
  t.after(() => { runner.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  writeProc(path.join(root, 'proc'), first, uptime[0]);
  writeProc(path.join(root, 'next'), second, uptime[1]);
  fs.writeFileSync(path.join(root, 'ps'), rows.map(line => line + '\n').join(''));
  if (tmuxServer) {
    fs.mkdirSync(path.join(root, 'tmux-' + userId));
    fs.writeFileSync(path.join(root, 'tmux-' + userId, 'default'), '');
  }
  const calls = { stderr: '' };
  const collector = new ProcessCollector({ gpuEnabled: () => gpuEnabled, refreshInterval: () => interval,
    systemInfo: { totalMemoryBytes: async () => 1024 ** 3, coreCount: async () => 4 },
    commandRunner: { async execFile(command, args, options) {
      assert.equal(command, 'sh');
      assert.equal(args[1], SNAPSHOT_SCRIPT);
      const result = await runner.execFile(shell, ['-c', SHELL_FIXTURE + prelude + args[1], ...args.slice(2)], { ...options, env: {
        SYSMON_PROC_ROOT: path.join(root, 'proc'), FIXTURE_ROOT: root, GPU_ROWS: gpu, GPU_STATUS: String(gpuStatus), PS_STATUS: String(psStatus),
        CLOCK_TICKS: String(clockTicks), USER_ID: userId, TMUX_ROWS: tmux, SCREEN_ROWS: screen, SLEEP_FRACTIONS: sleepFractions ? '1' : '0', TMUX_TMPDIR: root,
        ADVANCE_UPTIME: advanceUptime,
      } }).catch(error => { calls.stderr += error.stderr || ''; throw error; });
      calls.stderr += result.stderr;
      return result;
    } },
  });
  const lines = name => fs.existsSync(path.join(root, name)) ? fs.readFileSync(path.join(root, name), 'utf8').trim().split('\n') : [];
  return { collector, calls, sleeps: () => lines('sleeps'), sessionCalls: () => lines('session-calls') };
}

const steady = (pids, ticks = () => 0) => Object.fromEntries(pids.map(pid => [pid, { ticks: ticks(pid), start: 10 }]));
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

for (const shell of SHELLS) {
  test(`process CPU uses the change in CPU time across the sampling window (${shell})`, async t => {
    const rows = [row(7, { command: 'steady' }), row(8, { command: 'reused' }), row(9, { command: 'new' }), row(10, { command: 'exited' }),
      row(11, { command: 'parenthesized' }), row(12, { uid: 0, user: 'root', rss: 0, command: '[kworker/0:1]' }),
      row(13, { uid: 0, user: 'root', rss: 0, command: '[kswapd0]' })];
    const first = { 7: { ticks: 100, start: 10 }, 8: { ticks: 900, start: 50 }, 10: { ticks: 5, start: 10 }, 11: { comm: '(a) b) c', ticks: 100, start: 10 },
      12: { ticks: 0, start: 10 }, 13: { ticks: 5, start: 10 } };
    const second = { 7: { ticks: 150, start: 10 }, 8: { ticks: 20, start: 10050 }, 9: { ticks: 10, start: 10080 }, 11: { comm: '(a) b) c', ticks: 125, start: 10 },
      12: { ticks: 0, start: 10 }, 13: { ticks: 8, start: 10 } };
    const source = fixture(t, rows, { first, second, shell });
    const sample = await source.collector.collect();
    const cpu = Object.fromEntries(sample.rows.map(process => [process.pid, process.cpuUsagePercent]));
    assert.deepEqual(cpu, { 7: 50, 8: 40, 9: 50, 11: 25, 13: 3 });
    assert.equal(sample.totalCount, 5);
    assert.equal(sample.rows.find(process => process.pid === 7).cpuWhole, 12.5);
    assert.deepEqual(source.sleeps(), ['1.00']);
  });
}

test('the sampling window is half the refresh interval and at most one second', async t => {
  const rows = [row(7)];
  const stats = steady([7]);
  for (const [interval, expected] of [[1, ['0.50']], [2, ['1.00']], [10, ['1.00']]]) {
    const source = fixture(t, rows, { first: stats, interval });
    await source.collector.collect();
    assert.deepEqual(source.sleeps(), expected, String(interval));
  }
  const fallback = fixture(t, rows, { first: stats, interval: 1, sleepFractions: false });
  await fallback.collector.collect();
  assert.deepEqual(fallback.sleeps(), ['0.50', '1']);
  const slow = fixture(t, rows, { first: { 7: { ticks: 0, start: 10 } }, second: { 7: { ticks: 100, start: 10 } }, advanceUptime: '102.00' });
  const sample = await slow.collector.collect();
  assert.deepEqual(slow.sleeps(), []);
  assert.equal(sample.rows[0].cpuUsagePercent, 0);
});

test('process CPU converts ticks with the reported clock rate and falls back to 100 ticks per second', async t => {
  const rows = [row(7, { command: 'steady' }), row(9, { command: 'new' })];
  const first = { 7: { ticks: 0, start: 10 } };
  const second = { 7: { ticks: 50, start: 10 }, 9: { ticks: 25, start: 25000 } };
  const cpuOf = sample => Object.fromEntries(sample.rows.map(process => [process.pid, process.cpuUsagePercent]));
  const reported = await fixture(t, rows, { first, second, clockTicks: 250 }).collector.collect();
  assert.deepEqual(cpuOf(reported), { 7: 20, 9: 10 });
  for (const clockTicks of ['', 'unknown', '0']) {
    const fallback = await fixture(t, rows, { first, second, clockTicks }).collector.collect();
    assert.equal(cpuOf(fallback)[7], 50, JSON.stringify(clockTicks));
  }
});

test('remote selection unions independent CPU, RAM and GPU top hundreds with a 300-row bound', async t => {
  const rows = range(1, 600).map(pid => row(pid, { rss: pid > 200 && pid <= 300 ? 10000 - pid : 2048 }));
  const gpu = Array.from({ length: 100 }, (_, i) => `${i + 401}, ${1000 - i}`).join('\n');
  const first = steady(range(1, 600));
  const second = steady(range(1, 600), pid => pid <= 100 ? 200 - pid : 0);
  const source = fixture(t, rows, { gpu, first, second });
  const sample = await source.collector.collect();
  assert.equal((source.calls.stderr.match(/PS_CALL/g) || []).length, 1);
  assert.equal(sample.totalCount, 600);
  assert.equal(sample.rows.length, 300);
  const selected = sample.rows.map(process => process.pid).sort((a, b) => a - b);
  assert.deepEqual(selected, [...range(1, 100), ...range(201, 300), ...range(401, 500)]);
  assert.equal(sample.rows[0].pid, 1);
  assert.equal(sample.rows[0].cpuUsagePercent, 199);
  const store = new SnapshotStore(); store.commit('processes', sample);
  const model = buildMonitorViewModel(store.read());
  assert.equal(model.processTotalCount, 600);
  assert.equal(model.processes.length, 300);
});

test('only processes with current CPU use or GPU memory enter those rankings', async t => {
  const rows = range(1, 150).map(pid => row(pid, { rss: 1000000 + pid }));
  const second = steady(range(1, 150), pid => pid === 7 ? 3 : 0);
  const source = fixture(t, rows, { first: steady(range(1, 150)), second, gpu: '9, 0\n8, 12' });
  const sample = await source.collector.collect();
  assert.equal(sample.totalCount, 150);
  assert.deepEqual(sample.rows.map(process => process.pid), [7, ...range(51, 150).reverse(), 8]);
  const disabled = fixture(t, rows, { first: steady(range(1, 150)), second, gpu: '8, 12', gpuEnabled: false });
  const withoutGpu = await disabled.collector.collect();
  assert.deepEqual(withoutGpu.rows.map(process => process.pid), [7, ...range(51, 150).reverse()]);
  assert.equal(disabled.calls.stderr.includes('GPU_CALL'), false);
});

test('overlapping rankings deduplicate PIDs and use ascending PID to break ties', async t => {
  const pids = range(1, 250);
  const source = fixture(t, pids.slice().reverse().map(pid => row(pid)), { first: steady(pids), second: steady(pids, () => 1) });
  const sample = await source.collector.collect();
  assert.equal(sample.totalCount, 250);
  assert.deepEqual(sample.rows.map(process => process.pid), range(1, 100));
});

test('GPU selection sums memory across cards and ignores PIDs that have exited', async t => {
  const pids = range(1, 220);
  const gpu = [...Array.from({ length: 100 }, (_, i) => `${i + 101}, 100`), '220, 60', '220, 60', '999999, 100000', '219, [N/A]'].join('\n');
  const sample = await fixture(t, pids.map(pid => row(pid)), { gpu, first: steady(pids) }).collector.collect();
  assert.equal(sample.rows.length, 200);
  assert.equal(sample.rows.some(process => process.pid === 220), true);
  assert.equal(sample.rows.some(process => process.pid === 200), false);
  assert.equal(sample.rows.some(process => process.pid === 999999), false);
});

test('disabled GPU collection does not execute nvidia-smi and preserves the existing process filter', async t => {
  const source = fixture(t, [row(1, { rss: 900 }), row(2, { rss: 900 }), row(3, { command: 'test "quotes" $HOME ; echo text' })],
    { gpuEnabled: false, gpuStatus: 9, first: steady([1, 2, 3]), second: steady([1, 2, 3], pid => pid === 2 ? 1 : 0) });
  const sample = await source.collector.collect();
  assert.equal(sample.totalCount, 2);
  assert.deepEqual(sample.rows.map(process => process.pid).sort(), [2, 3]);
  assert.equal(sample.rows.find(process => process.pid === 3).commandLine, 'test "quotes" $HOME ; echo text');
  assert.equal(source.calls.stderr.includes('GPU_CALL'), false);
});

test('GPU ranking failure retains CPU and RAM candidates and reports a partial error', async t => {
  const { collector } = fixture(t, [row(7)], { gpuStatus: 9, first: steady([7]) });
  const store = new SnapshotStore();
  const runner = new CollectorRunner({ key: 'processes', collector, snapshotStore: store, timeoutMilliseconds: 5000 });
  await runner.run();
  assert.equal(store.read().processes.value.rows[0].pid, 7);
  assert.equal(store.read().processes.value.totalCount, 1);
  assert.equal(store.read().processes.lastError.code, 'GPU_OCCUPANCY_UNAVAILABLE');
});

test('an empty process table clears candidates while failed or malformed queries fail', async t => {
  assert.deepEqual(await fixture(t, []).collector.collect(), { rows: [], totalCount: 0 });
  await assert.rejects(fixture(t, [row(1)], { psStatus: 2, first: steady([1]) }).collector.collect(), { code: 'PS_UNSUPPORTED' });
  await assert.rejects(fixture(t, ['unrecognized ps output']).collector.collect(), { code: 'PS_UNSUPPORTED' });
  await assert.rejects(fixture(t, [row(1)], { psStatus: 127, first: steady([1]) }).collector.collect(), error => error.code !== 'PS_UNSUPPORTED');
  const collector = new ProcessCollector({ commandRunner: { execFile: async () => ({ stdout: 'missing snapshot header' }) } });
  await assert.rejects(collector.collect(), { code: 'EINCOMPLETE' });
  const truncated = new ProcessCollector({ commandRunner: { execFile: async () => ({ stdout: '__SYSMON_PROCESSES__ 0 0\n' }) } });
  await assert.rejects(truncated.collect(), { code: 'EINCOMPLETE' });
  for (const language of ['en', 'zh-CN', 'zh-TW']) assert.match(localizeError({ code: 'PS_UNSUPPORTED', message: 'raw' }, language), /BusyBox/);
});

test('tmux and screen sessions are attributed to the nearest session of the current user', async t => {
  const tree = [[100, 1, 1000, 'bash'], [101, 100, 1000, 'python train.py'], [102, 101, 1000, 'python worker.py'], [103, 101, 0, 'sudo python job.py'],
    [200, 1, 1000, 'SCREEN -S exp'], [201, 200, 1000, 'python exp.py'], [300, 100, 1000, 'SCREEN -S nested'], [301, 300, 1000, 'vim'],
    [400, 1, 1000, 'python detached.py'], [500, 501, 1000, 'loop-a'], [501, 500, 1000, 'loop-b'], [600, 100, 1001, 'python other-user.py']];
  const rows = tree.map(([pid, ppid, uid, command]) => row(pid, { ppid, uid, user: uid === 1000 ? 'alice' : uid ? 'bob' : 'root', command }));
  const screen = 'There are screens on:\n\t200.exp\t(11/06/2026 10:00:00 AM)\t(Detached)\n\t300.nested\t(Attached)\n\t999.gone\t(Dead ???)\n2 Sockets in /run/screen/S-alice.';
  const source = fixture(t, rows, { first: steady(tree.map(([pid]) => pid)), tmux: '100\tmy train\nmalformed\n\t\n', screen });
  const sample = await source.collector.collect();
  const sessions = Object.fromEntries(sample.rows.map(process => [process.pid, process.session && process.session.type + ':' + process.session.name + ':' + process.session.id]));
  assert.deepEqual(sessions, {
    100: 'tmux:my train:my train', 101: 'tmux:my train:my train', 102: 'tmux:my train:my train', 103: null,
    200: 'screen:exp:200.exp', 201: 'screen:exp:200.exp', 300: 'screen:nested:300.nested', 301: 'screen:nested:300.nested',
    400: null, 500: null, 501: null, 600: null,
  });
  const store = new SnapshotStore(); store.commit('processes', sample);
  const model = buildMonitorViewModel(store.read());
  assert.deepEqual(model.processes.find(process => process.pid === 201).session, { type: 'screen', name: 'exp', id: '200.exp' });
  assert.equal(model.processes.find(process => process.pid === 400).session, null);
});

test('failing session commands or an unknown user id leave the process list intact', async t => {
  const rows = [row(100, { command: 'bash' }), row(101, { ppid: 100 })];
  const sample = await fixture(t, rows, { first: steady([100, 101]), screen: 'No Sockets found in /run/screen/S-alice.' }).collector.collect();
  assert.deepEqual(sample.rows.map(process => [process.pid, process.session]), [[100, null], [101, null]]);
  const unknownUser = await fixture(t, rows, { first: steady([100, 101]), tmux: '100\tmain', userId: '' }).collector.collect();
  assert.deepEqual(unknownUser.rows.map(process => process.session), [null, null]);
});

test('absent tmux or screen commands are skipped without being run', async t => {
  const rows = [row(100, { command: 'bash' }), row(101, { ppid: 100 }), row(200, { command: 'SCREEN -S exp' }), row(201, { ppid: 200 })];
  const options = { first: steady([100, 101, 200, 201]), tmux: '100\tmain', screen: '\t200.exp\t(Detached)' };
  const absent = (...names) => `command() { case "$2" in ${names.join('|')}) return 1 ;; esac; return 0; }\n`;
  const sessionsOf = sample => sample.rows.map(process => [process.pid, process.session && process.session.type]);
  const neither = fixture(t, rows, { ...options, prelude: absent('tmux', 'screen') });
  const withoutTools = await neither.collector.collect();
  assert.deepEqual(sessionsOf(withoutTools), [[100, null], [101, null], [200, null], [201, null]]);
  assert.deepEqual(neither.sessionCalls(), []);
  const screenOnly = fixture(t, rows, { ...options, prelude: absent('tmux') });
  const withScreen = await screenOnly.collector.collect();
  assert.deepEqual(sessionsOf(withScreen), [[100, null], [101, null], [200, 'screen'], [201, 'screen']]);
  assert.deepEqual(screenOnly.sessionCalls(), ['id', 'screen']);
});

test('tmux and screen are queried only when the current user already runs a server', async t => {
  const rows = [row(100, { command: 'bash' }), row(101, { ppid: 100 }), row(200, { uid: 1001, user: 'bob', command: 'SCREEN -S other' })];
  const source = fixture(t, rows, { first: steady([100, 101, 200]), tmux: '100\tmain', screen: '\t200.other\t(Detached)', tmuxServer: false });
  const sample = await source.collector.collect();
  assert.deepEqual(sample.rows.map(process => process.session), [null, null, null]);
  assert.deepEqual(source.sessionCalls(), ['id']);
});

test('process totals reuse published memory and core counts before querying the host', async t => {
  const stdout = '__SYSMON_PROCESSES__ 1 0\n7 root 50.0 1048576 Sun Jul 13 12:34:56 2026 /bin/test\n__SYSMON_SESSIONS__\n';
  let queries = 0;
  const systemInfo = { async totalMemoryBytes() { queries++; return 4 * 1024 ** 3; }, async coreCount() { queries++; return 8; } };
  let known = { totalMemoryBytes: 2 * 1024 ** 3, coreCount: 2 };
  const collector = new ProcessCollector({ commandRunner: { execFile: async () => ({ stdout }) }, systemInfo, knownTotals: () => known });
  let [first] = (await collector.collect()).rows;
  assert.deepEqual([first.memoryUsagePercent, first.cpuWhole, queries], [50, 25, 0]);
  known = {};
  [first] = (await collector.collect()).rows;
  assert.deepEqual([first.memoryUsagePercent, first.cpuWhole, queries], [25, 6.25, 2]);
  const { MonitorService } = require('../src/services/monitor-service');
  const { normalizeConfig } = require('../src/config/normalize-config');
  const service = new MonitorService({ runtimeConfig: normalizeConfig({}), isSsh: false });
  t.after(() => service.dispose());
  service.snapshotStore.commit('memory', { totalBytes: 1000, availableBytes: 400, usedBytes: 600, usagePercent: 60 });
  service.snapshotStore.commit('cpu', { usagePercent: 1, coreCount: 16, loadAverage: { oneMinute: 0, fiveMinutes: 0, fifteenMinutes: 0 } });
  assert.deepEqual(service.runners.find(runner => runner.key === 'processes').collector.knownTotals(), { totalMemoryBytes: 1000, coreCount: 16 });
});

test('session lines keep tab-separated names and strip only the screen process prefix', () => {
  const sessions = parseProcessSessions('7\ttmux\tname with spaces\n8\tscreen\t12345.pts-0.host\n9\tscreen\tinvalid\n10\tunknown\tx\nbad\ttmux\tx\n11\ttmux\t\n');
  assert.deepEqual([...sessions], [
    [7, { type: 'tmux', name: 'name with spaces', id: 'name with spaces' }],
    [8, { type: 'screen', name: 'pts-0.host', id: '12345.pts-0.host' }],
  ]);
});

test('views independently sort and search the same candidates without changing shared data', async () => {
  const { selectProcessRows } = await import('../src/view/assets/processes.mjs');
  const candidates = Array.from({ length: 300 }, (_, i) => ({
    pid: i + 1, name: 'train', user: 'alice', cmd: 'train --worker ' + i,
    cpu: 300 - i, mem: i, vram: i >= 100 && i < 200 ? i : 0,
    gpus: i >= 100 && i < 200 ? [{ idx: 3 }] : [],
  }));
  const before = structuredClone(candidates);
  assert.deepEqual(selectProcessRows(candidates, 'cpu').rows.map(process => process.pid), Array.from({ length: 100 }, (_, i) => i + 1));
  assert.deepEqual(selectProcessRows(candidates, 'mem').rows.map(process => process.pid), Array.from({ length: 100 }, (_, i) => 300 - i));
  assert.deepEqual(selectProcessRows(candidates, 'gpu').rows.map(process => process.pid), Array.from({ length: 100 }, (_, i) => 200 - i));
  assert.equal(selectProcessRows(candidates, 'gpu', 'gpu3').matchedCount, 100);
  assert.equal(selectProcessRows(candidates, 'cpu', 'outside-candidates').matchedCount, 0);
  assert.equal(selectProcessRows(candidates, 'mem', 'alice').matchedCount, 300);
  assert.equal(selectProcessRows(candidates, 'mem', 'alice').rows.length, 100);
  assert.deepEqual(candidates, before);
});

for (const shell of SHELLS) {
  test(`long uptimes and CPU counters beyond 32 bits keep full precision (${shell})`, async t => {
    const rows = [row(7, { command: 'long-running' }), row(8, { command: 'started-in-window' })];
    const first = { 7: { ticks: 5000000000, start: 400000000 } };
    const second = { 7: { ticks: 5000000150, start: 400000000 }, 8: { ticks: 40, start: 487939690 } };
    const source = fixture(t, rows, { first, second, uptime: [4879396.7, 4879397.7], shell });
    const sample = await source.collector.collect();
    const cpu = Object.fromEntries(sample.rows.map(process => [process.pid, process.cpuUsagePercent]));
    assert.deepEqual(cpu, { 7: 150, 8: 50 });
  });
}
