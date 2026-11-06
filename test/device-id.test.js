'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { LOCAL_DEVICE_ID, sshDeviceId, isLocalDeviceId, isSshDeviceId, deviceHost } = require('../src/domain/device-id');

test('device ids map SSH hosts in both directions and recognize the local device', () => {
  assert.equal(sshDeviceId('campus'), 'ssh:campus');
  assert.equal(deviceHost(sshDeviceId('user@campus')), 'user@campus');
  assert.equal(deviceHost(LOCAL_DEVICE_ID), null);
  assert.equal(deviceHost(null), null);
  assert.equal(isSshDeviceId('ssh:campus'), true);
  assert.equal(isSshDeviceId(LOCAL_DEVICE_ID), false);
  assert.equal(isSshDeviceId(42), false);
  assert.equal(isLocalDeviceId('local'), true);
  assert.equal(isLocalDeviceId('ssh:local'), false);
});
