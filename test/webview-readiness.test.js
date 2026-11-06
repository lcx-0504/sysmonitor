'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { READY_TIMEOUT_MILLISECONDS, WebviewReadiness } = require('../src/view/webview-readiness');
const { createFakeVscode } = require('./fake-vscode');
const { settle, fakeTimers } = require('./view-fixture');

function readinessFixture({ rebuildHtml = async () => '<html>reloaded</html>' } = {}) {
  const clock = fakeTimers();
  const logs = [];
  const readiness = new WebviewReadiness({ rebuildHtml, logger: (message) => logs.push(message), ...clock });
  const target = createFakeVscode().fake.createView();
  const record = { target, label: 'sidebar', ready: false, visible: true };
  return { readiness, record, target, clock, logs };
}

test('the ready watchdog waits ten seconds and ignores a check that fires after ready or after hiding', async () => {
  assert.equal(READY_TIMEOUT_MILLISECONDS, 10000);
  const { readiness, record, target, clock } = readinessFixture();
  readiness.armReadyCheck(record);
  readiness.armReadyCheck(record);
  assert.deepEqual(clock.timers.map((timer) => timer.milliseconds), [10000]);
  readiness.markReady(record);
  assert.equal(clock.timers[0].cancelled, true);
  clock.timers[0].callback();
  await settle();
  assert.deepEqual(target.webview.htmlHistory, []);

  readiness.setUnready(record);
  readiness.armReadyCheck(record);
  target.visible = false;
  readiness.visibilityChanged(record);
  assert.equal(clock.timers[1].cancelled, true);
  clock.timers[1].callback();
  await settle();
  assert.deepEqual(target.webview.htmlHistory, []);
});

test('a failed reload is logged and leaves the view as it was', async () => {
  const { readiness, record, target, clock, logs } = readinessFixture({ rebuildHtml: async () => {
    throw new Error('assets unavailable');
  } });
  readiness.armReadyCheck(record);
  clock.timers[0].callback();
  await settle();
  assert.deepEqual(target.webview.htmlHistory, []);
  assert.deepEqual(logs, [
    'Webview sidebar did not report ready within 10 s; reloading its HTML',
    'Webview sidebar reload failed: assets unavailable',
  ]);
});

test('a reload that finishes after the view reports ready does not replace the document', async () => {
  let finish;
  const { readiness, record, target, clock } = readinessFixture({ rebuildHtml: () => new Promise((resolve) => {
    finish = resolve;
  }) });
  readiness.armReadyCheck(record);
  clock.timers[0].callback();
  readiness.markReady(record);
  finish('<html>late</html>');
  await settle();
  assert.deepEqual(target.webview.htmlHistory, []);
});

test('a webview that throws while posting is marked unready and rechecked, but a released one is left alone', async () => {
  const { readiness, record, target, clock, logs } = readinessFixture();
  readiness.markReady(record);
  target.webview.postMessage = () => {
    throw new Error('Webview is disposed');
  };
  readiness.post(record, { cmd: 'uiState' });
  assert.equal(record.ready, false);
  assert.equal(logs.at(-1), 'Webview sidebar did not accept a message: Webview is disposed');
  assert.equal(clock.timers.length, 1);
  readiness.release(record);
  assert.equal(clock.timers[0].cancelled, true);
  readiness.post(record, { cmd: 'uiState' });
  readiness.armReadyCheck(record);
  assert.equal(clock.timers.length, 1);
  assert.equal(logs.length, 1);
});
