'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {ResourceCollector}=require('../src/collectors/resource-collector');
const {CommandRunner}=require('../src/core/command-runner');
const {resourceCommandRunner}=require('./resource-fixture');

const files={ '/proc/stat':'cpu 10 0 10 80\ncpu0 1 0 1 8\n', '/proc/loadavg':'1 2 3 1/10 5\n',
  '/proc/meminfo':'MemTotal: 1000 kB\nMemAvailable: 400 kB\n',
  '/proc/net/dev':'Inter-| Receive | Transmit\nface | bytes\neth0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\n',
  '/proc/diskstats':'8 0 sda 0 0 10 0 0 0 20 0 0 0 0 0\n' };

test('an unavailable optional route file retains all four resource outputs and selects available interfaces', async () => {
  const runner=resourceCommandRunner(async path=>{ if(path==='/proc/net/route')throw Object.assign(new Error('missing route'),{code:'ENOENT'});return files[path];});
  const value=await new ResourceCollector({commandRunner:runner}).collect();
  assert.deepEqual(Object.keys(value),['cpu','memory','network','diskIo']);
  assert.deepEqual(value.network.interfaces,['eth0']); assert.equal(value.memory.usagePercent,60);
});

// Runs the generated resource command in a real shell against a fixture /proc tree. Each file read advances
// the fixture uptime by the current step, so the reported interval shows when the command read the uptime.
function procShell(t, procFiles) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysmonitor-resources-'));
  const runner = new CommandRunner();
  t.after(() => {
    runner.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (name, text) => {
    const file = path.join(root, 'proc', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const step = seconds => fs.writeFileSync(path.join(root, 'step'), String(seconds));
  for (const [name, text] of Object.entries(procFiles)) write(name, text);
  step(1);
  const prelude = 'cat() { command cat "$@"; status=$?; read -r now ignored < "$FIXTURE_ROOT/proc/uptime"; '
    + 'printf "%s 0\\n" $((now + $(command cat "$FIXTURE_ROOT/step"))) > "$FIXTURE_ROOT/proc/uptime"; return $status; }\n';
  const commandRunner = { execFile(command, args, options) {
    const script = prelude + args[1].replaceAll('/proc/', root + '/proc/');
    return runner.execFile(command, [args[0], script], { ...options, env: { FIXTURE_ROOT: root } });
  } };
  return { commandRunner, write, step, remove: name => fs.rmSync(path.join(root, 'proc', name)) };
}

const netDev = bytes => 'Inter-| Receive | Transmit\nface | bytes\neth0: '+bytes+' 0 0 0 0 0 0 0 '+bytes+' 0 0 0 0 0 0 0\n';

test('the generated resource command brackets its file reads with server uptime readings', async t => {
  const proc = procShell(t, { uptime: '100 0\n', 'net/dev': netDev(1000), 'net/route': 'Iface Destination Gateway Flags\neth0 00000000 0 0003\n' });
  const collector = new ResourceCollector({ keys: ['network'], commandRunner: proc.commandRunner });
  assert.equal((await collector.collect()).network.receiveBytesPerSecond, null);
  proc.step(3);
  proc.write('net/dev', netDev(1400));
  assert.equal((await collector.collect()).network.receiveBytesPerSecond, 100);
});

test('the generated resource command tolerates only a missing route file', async t => {
  const proc = procShell(t, { uptime: '100 0\n', ...Object.fromEntries(Object.entries(files).map(([file, text]) => [file.slice('/proc/'.length), text])) });
  const collector = new ResourceCollector({ commandRunner: proc.commandRunner });
  const value = await collector.collect();
  assert.deepEqual(Object.keys(value), ['cpu', 'memory', 'network', 'diskIo']);
  assert.deepEqual(value.network.interfaces, ['eth0']);
  assert.equal(value.memory.usagePercent, 60);
  assert.equal(value.cpu.coreCount, 1);
  proc.remove('stat');
  await assert.rejects(collector.collect());
});

test('network and disk rates use the server uptime midpoint of each sample', async () => {
  const samples=[['100.00','100.20',100,10],['102.00','102.20',500,30]];
  let index=0;
  const collector=new ResourceCollector({keys:['network','diskIo'],commandRunner:{async execFile(){
    const [started,finished,bytes,sectors]=samples[index++];
    return {stdout:'__SYSMON_RESOURCE_0__\nInter-| Receive | Transmit\nface | bytes\neth0: '+bytes+' 0 0 0 0 0 0 0 '+bytes+' 0 0 0 0 0 0 0\n\n'
      +'__SYSMON_RESOURCE_1__\nIface Destination Gateway Flags\neth0 00000000 0 0003\n\n'
      +'__SYSMON_RESOURCE_2__\n8 0 sda 0 0 '+sectors+' 0 0 0 0 0 0 0 0 0\n\n'
      +'__SYSMON_RESOURCE_3__\n'+started+' '+finished+'\n'};
  }}});
  await collector.collect();
  const value=await collector.collect();
  assert.equal(value.network.receiveBytesPerSecond,200);
  assert.equal(value.diskIo.readBytesPerSecond,20*512/2);
});

test('a resource sample without its uptime interval is incomplete', async () => {
  const collector=new ResourceCollector({keys:['memory'],commandRunner:{execFile:async()=>({stdout:'__SYSMON_RESOURCE_0__\nMemTotal: 1000 kB\nMemAvailable: 400 kB\n\n__SYSMON_RESOURCE_1__\n'})}});
  await assert.rejects(collector.collect(),{code:'EINCOMPLETE'});
});

test('memory falls back to free, buffer and cache pages without MemAvailable', async () => {
  const meminfo='MemTotal: 1000 kB\nMemFree: 200 kB\nBuffers: 50 kB\nCached: 150 kB\nSwapCached: 999 kB\n';
  const value=await new ResourceCollector({keys:['memory'],commandRunner:resourceCommandRunner(async()=>meminfo)}).collect();
  assert.deepEqual(value.memory,{totalBytes:1024000,availableBytes:409600,usedBytes:614400,usagePercent:60});
  const incomplete=new ResourceCollector({keys:['memory'],commandRunner:resourceCommandRunner(async()=>'MemTotal: 1000 kB\nMemFree: 200 kB\n')});
  await assert.rejects(incomplete.collect(),{code:'EINCOMPLETE'});
});

test('the shared resource command reads live Linux files', { skip:!fs.existsSync('/proc/uptime') }, async t => {
  const runner=new CommandRunner(); t.after(()=>runner.dispose());
  const collector=new ResourceCollector({commandRunner:runner});
  await collector.collect();
  await new Promise(resolve=>setTimeout(resolve,50));
  const value=await collector.collect();
  assert.ok(Number.isFinite(value.memory.usagePercent));
  assert.ok(value.network.interfaces.length===0||Number.isFinite(value.network.receiveBytesPerSecond));
});
