'use strict';

const READY_TIMEOUT_MILLISECONDS = 10000;

class WebviewReadiness {
  constructor({ rebuildHtml, logger = () => {}, scheduleReadyCheck = setTimeout, cancelReadyCheck = clearTimeout }) {
    this.rebuildHtml = rebuildHtml;
    this.logger = logger;
    this.scheduleReadyCheck = scheduleReadyCheck;
    this.cancelReadyCheck = cancelReadyCheck;
  }

  post(record, message) {
    const generation = record.generation || 0;
    let delivery;
    try {
      delivery = record.target.webview.postMessage(message);
    } catch (error) {
      this.undelivered(record, generation, error);
      return;
    }
    if (delivery && typeof delivery.then === 'function') {
      delivery.then((delivered) => {
        if (delivered === false) this.undelivered(record, generation, null);
      }, (error) => this.undelivered(record, generation, error));
    }
  }

  undelivered(record, generation, error) {
    if (record.released || !record.ready || (record.generation || 0) !== generation) return;
    this.logger(`${describe(record)} did not accept a message${error && error.message ? ': ' + error.message : ''}`);
    this.setUnready(record);
    this.armReadyCheck(record);
  }

  markReady(record) {
    record.ready = true;
    record.generation = (record.generation || 0) + 1;
    this.stopReadyCheck(record);
  }

  setUnready(record) {
    record.ready = false;
    record.generation = (record.generation || 0) + 1;
  }

  visibilityChanged(record) {
    const visible = !!record.target.visible;
    if (visible === record.visible) return;
    record.visible = visible;
    if (visible) {
      record.reloaded = false;
      this.armReadyCheck(record);
    } else {
      this.setUnready(record);
      this.stopReadyCheck(record);
    }
  }

  armReadyCheck(record) {
    if (record.released || record.ready || record.reloaded || record.readyCheck || !record.target.visible) return;
    const check = { timer: null };
    check.timer = this.scheduleReadyCheck(() => {
      if (record.readyCheck !== check) return;
      record.readyCheck = null;
      this.reloadSilentView(record);
    }, READY_TIMEOUT_MILLISECONDS);
    record.readyCheck = check;
  }

  stopReadyCheck(record) {
    if (!record.readyCheck) return;
    this.cancelReadyCheck(record.readyCheck.timer);
    record.readyCheck = null;
  }

  async reloadSilentView(record) {
    if (record.released || record.ready || !record.target.visible) return;
    record.reloaded = true;
    this.logger(`${describe(record)} did not report ready within ${READY_TIMEOUT_MILLISECONDS / 1000} s; reloading its HTML`);
    try {
      const html = await this.rebuildHtml(record);
      if (!record.released && !record.ready) record.target.webview.html = html;
    } catch (error) {
      this.logger(`${describe(record)} reload failed: ${error && error.message ? error.message : error}`);
    }
  }

  release(record) {
    record.released = true;
    record.ready = false;
    this.stopReadyCheck(record);
  }
}

function describe(record) {
  return `Webview ${record.label || 'view'}`;
}

module.exports = { READY_TIMEOUT_MILLISECONDS, WebviewReadiness };
