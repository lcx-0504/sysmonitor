'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {ResourceCollector,RESOURCE_COMMAND,RESOURCE_FILES}=require('../src/collectors/resource-collector');

test('an unavailable optional route file retains all four resource outputs and selects available interfaces', async () => {
  const files={ '/proc/stat':'cpu 10 0 10 80\ncpu0 1 0 1 8\n', '/proc/loadavg':'1 2 3 1/10 5\n',
    '/proc/meminfo':'MemTotal: 1000 kB\nMemAvailable: 400 kB\n',
    '/proc/net/dev':'Inter-| Receive | Transmit\nface | bytes\neth0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\n',
    '/proc/diskstats':'8 0 sda 0 0 10 0 0 0 20 0 0 0 0 0\n' };
  const reader={ readFile:async path=>{ if(path==='/proc/net/route')throw Object.assign(new Error('missing route'),{code:'ENOENT'});return files[path];} };
  const collector=new ResourceCollector({fileReader:reader});
  const value=await collector.collect();
  assert.deepEqual(Object.keys(value),['cpu','memory','network','diskIo']);
  assert.deepEqual(value.network.interfaces,['eth0']); assert.equal(value.memory.usagePercent,60);
  const stdout=RESOURCE_FILES.map((path,index)=>'__SYSMON_RESOURCE_'+index+'__\n'+(files[path]||'')+'\n').join('')+'__SYSMON_RESOURCE_6__\n';
  const remote=new ResourceCollector({commandRunner:{execFile:async()=>({stdout})}});
  assert.deepEqual((await remote.collect()).network.interfaces,['eth0']);
  assert.match(RESOURCE_COMMAND,/cat '\/proc\/net\/route' 2>\/dev\/null \|\| :/);
});
