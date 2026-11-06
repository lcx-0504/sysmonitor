'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CommandRunner } = require('../src/core/command-runner');
const { CollectorRunner } = require('../src/core/collector-runner');
const { SnapshotStore } = require('../src/core/snapshot-store');
const { ProcessCollector, PROCESS_SNAPSHOT_COMMAND } = require('../src/collectors/process-collector');
const { buildMonitorViewModel } = require('../src/services/monitor-view-model');

const row = (pid, cpu = 1, memory = 2048, command = 'train --name test') =>
  `${pid} user ${cpu} ${memory} Sun Jul 13 12:34:56 2026 ${command}`;

function fixture(t, rows, { gpu = '', gpuStatus = 0, gpuEnabled = true, psStatus = 0 } = {}) {
  const runner = new CommandRunner();
  t.after(() => runner.dispose());
  let psCalls = 0;
  const collector = new ProcessCollector({ gpuEnabled: () => gpuEnabled,
    systemInfo: { totalMemoryBytes: async () => 1024 ** 3, coreCount: async () => 4 },
    commandRunner: { async execFile(command, args, options) {
      assert.equal(command, 'sh');
      assert.equal(args[1], PROCESS_SNAPSHOT_COMMAND);
      const prefix = 'ps() { printf "PS_CALL\\n" >&2; cat; return "$PS_STATUS"; }\n'
        + 'fixture_gpu() { printf "GPU_CALL\\n" >&2; printf "%s\\n" "$GPU_ROWS"; return "$GPU_STATUS"; }\n'
        + 'alias nvidia-smi=fixture_gpu\n';
      const result = await runner.execFile(command, ['-c', prefix + args[1], ...args.slice(2)], {
        ...options, input: rows.join('\n'), env: { GPU_ROWS: gpu, GPU_STATUS: String(gpuStatus), PS_STATUS: String(psStatus) },
      });
      psCalls += (result.stderr.match(/PS_CALL/g) || []).length;
      return result;
    } },
  });
  return { collector, psCalls: () => psCalls };
}

test('remote selection unions independent CPU, RAM and GPU top hundreds with a 300-row bound', async t => {
  const rows = Array.from({ length: 600 }, (_, i) => {
    const pid = i + 1;
    return row(pid, pid <= 100 ? 200 - pid : 1, pid > 200 && pid <= 300 ? 10000 - pid : 2048);
  });
  const gpu = Array.from({ length: 100 }, (_, i) => `${i + 401}, ${1000 - i}`).join('\n');
  const source = fixture(t, rows, { gpu });
  const sample = await source.collector.collect();
  assert.equal(source.psCalls(), 1);
  assert.equal(sample.totalCount, 600);
  assert.equal(sample.rows.length, 300);
  const selected = sample.rows.map(process => process.pid).sort((a, b) => a - b);
  assert.deepEqual(selected, [...Array.from({ length: 100 }, (_, i) => i + 1),
    ...Array.from({ length: 100 }, (_, i) => i + 201), ...Array.from({ length: 100 }, (_, i) => i + 401)]);
  assert.equal(sample.rows[0].cpuWhole, sample.rows[0].cpuUsagePercent / 4);
  const store = new SnapshotStore(); store.commit('processes', sample);
  const model = buildMonitorViewModel(store.read(), 'en');
  assert.equal(model.processTotalCount, 600);
  assert.equal(model.processes.length, 300);
});

test('overlapping rankings deduplicate PIDs and use ascending PID to break ties', async t => {
  const source = fixture(t, Array.from({ length: 250 }, (_, i) => row(250 - i)), { gpu: '' });
  const sample = await source.collector.collect();
  assert.equal(sample.totalCount, 250);
  assert.deepEqual(sample.rows.map(process => process.pid), Array.from({ length: 100 }, (_, i) => i + 1));
});

test('GPU selection sums memory across cards and ignores PIDs that have exited', async t => {
  const rows = Array.from({ length: 220 }, (_, i) => row(i + 1));
  const gpu = [...Array.from({ length: 100 }, (_, i) => `${i + 101}, 100`), '220, 60', '220, 60', '999999, 100000', '219, [N/A]'].join('\n');
  const sample = await fixture(t, rows, { gpu }).collector.collect();
  assert.equal(sample.rows.length, 200);
  assert.equal(sample.rows.some(process => process.pid === 220), true);
  assert.equal(sample.rows.some(process => process.pid === 200), false);
  assert.equal(sample.rows.some(process => process.pid === 999999), false);
});

test('disabled GPU collection does not execute nvidia-smi and preserves the existing process filter', async t => {
  const source = fixture(t, [row(1, 0, 900), row(2, 1, 900), row(3, 0, 2048, 'test "quotes" $HOME ; echo text')], { gpuEnabled: false, gpuStatus: 9 });
  const sample = await source.collector.collect();
  assert.equal(sample.totalCount, 2);
  assert.deepEqual(sample.rows.map(process => process.pid).sort(), [2, 3]);
  assert.equal(sample.rows.find(process => process.pid === 3).commandLine, 'test "quotes" $HOME ; echo text');
});

test('GPU ranking failure retains CPU and RAM candidates and reports a partial error', async t => {
  const { collector } = fixture(t, [row(7)], { gpuStatus: 9 });
  const store = new SnapshotStore();
  const runner = new CollectorRunner({ key: 'processes', collector, snapshotStore: store, cadenceMilliseconds: 2000, timeoutMilliseconds: 5000 });
  await runner.run();
  assert.equal(store.read().processes.value.rows[0].pid, 7);
  assert.equal(store.read().processes.value.totalCount, 1);
  assert.equal(store.read().processes.lastError.code, 'GPU_OCCUPANCY_UNAVAILABLE');
});

test('an empty process table clears candidates while failed or malformed queries fail', async t => {
  assert.deepEqual(await fixture(t, []).collector.collect(), { rows: [], totalCount: 0 });
  await assert.rejects(fixture(t, [row(1)], { psStatus: 2 }).collector.collect());
  await assert.rejects(fixture(t, ['unrecognized ps output']).collector.collect());
  const collector = new ProcessCollector({ commandRunner: { execFile: async () => ({ stdout: 'missing snapshot header' }) } });
  await assert.rejects(collector.collect(), { code: 'EINCOMPLETE' });
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
