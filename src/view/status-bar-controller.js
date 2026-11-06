'use strict';

function percentText(value) {
  return Number.isFinite(value) ? value + '%' : '—';
}

function diskIoText(mode, diskIo) {
  if (mode === 'read') return `R${diskIo.readText}`;
  if (mode === 'write') return `W${diskIo.writeText}`;
  if (mode === 'combined') return diskIo.totalText;
  return `R${diskIo.readText} W${diskIo.writeText}`;
}

function diskPart(config, viewModel) {
  const diskRoot = viewModel.disks && viewModel.disks.find((disk) => disk.mount === '/');
  const showIo = !!config.diskIO && config.diskIO !== 'off';
  if (!(config.disk || showIo) || !(diskRoot || viewModel.diskIo)) return null;
  const diskText = config.disk && diskRoot ? `${diskRoot.pct}%` : '';
  const ioText = showIo && viewModel.diskIo ? diskIoText(config.diskIO, viewModel.diskIo) : '';
  if (diskText && ioText) return `$(database) ${diskText} (${ioText})`;
  if (diskText || ioText) return `$(database) ${diskText || ioText}`;
  return null;
}

function networkText(mode, network) {
  if (mode === 'up') return `↑${network.transmitText}`;
  if (mode === 'down') return `↓${network.receiveText}`;
  if (mode === 'combined') return `↕${network.totalText}`;
  if (mode === 'both') return `↑${network.transmitText} ↓${network.receiveText}`;
  return '';
}

function networkPart(config, viewModel) {
  const sshTraffic = viewModel.sshTraffic;
  const ssh = config.ssh && sshTraffic && sshTraffic.isSsh ? `SSH ↑${sshTraffic.uploadText} ↓${sshTraffic.downloadText}` : '';
  if (config.net && config.net !== 'off' && viewModel.network) {
    const text = networkText(config.net, viewModel.network);
    return ssh ? `${text} (${ssh})` : text;
  }
  return ssh || null;
}

function gpuIndices(gpu, gpus, currentUserNativeIndices) {
  if (gpu.mode === 'all') return gpus.map((device) => device.idx);
  if (gpu.mode === 'first') return gpus.slice(0, gpu.firstN || 2).map((device) => device.idx);
  if (gpu.mode === 'specify') return gpu.cards || [];
  if (gpu.mode === 'my') return currentUserNativeIndices;
  return [];
}

function gpuDetail(gpu, device) {
  const util = percentText(device.util);
  const memory = Number.isFinite(device.memPct) ? device.memPct + '%V' : '—';
  if (gpu.metric === 'util') return `#${device.idx} ${util}`;
  if (gpu.metric === 'vram') return `#${device.idx} ${memory}`;
  return `#${device.idx} ${util}/${memory}`;
}

function gpuParts(gpu, gpus, currentUserNativeIndices) {
  const parts = [];
  if (gpu.summary) {
    const idle = gpus.filter((device) => device.isIdle === true);
    const idleCount = gpus.some((device) => device.availability === 'unknown') ? '--' : idle.length;
    let text = `$(circuit-board) ${idleCount}/${gpus.length}`;
    if (gpu.showIdleIds && idle.length) text += ` (${idle.map((device) => device.idx).join(',')})`;
    parts.push(text);
  }
  const details = [...gpuIndices(gpu, gpus, currentUserNativeIndices)]
    .sort((left, right) => left - right)
    .map((index) => gpus.find((device) => device.idx === index))
    .filter((device) => device && !(gpu.skipIdle && device.isIdle))
    .map((device) => gpuDetail(gpu, device));
  if (details.length) parts.push(`${gpu.summary ? '' : '$(circuit-board) '}${details.join(' ')}`);
  return parts;
}

function formatStatusBarText(config, viewModel, currentUserNativeIndices = []) {
  if (config.barEnabled === false) return '';
  const parts = [];
  if (config.cpu && viewModel.cpu && viewModel.cpu.available !== false) parts.push(`$(dashboard) ${percentText(viewModel.cpu.usagePercent)}`);
  if (config.ram && viewModel.memory && viewModel.memory.available !== false) parts.push(`$(server) ${percentText(viewModel.memory.usagePercent)}`);
  const disk = diskPart(config, viewModel);
  if (disk !== null) parts.push(disk);
  const network = networkPart(config, viewModel);
  if (network !== null) parts.push(network);
  if (config.gpu && viewModel.gpus && viewModel.gpus.length) parts.push(...gpuParts(config.gpu, viewModel.gpus, currentUserNativeIndices));
  return parts.length ? parts.join('  ') : '$(pulse) Monitor';
}

class StatusBarController {
  constructor({ vscode, configStore }) {
    this.vscode = vscode;
    this.configStore = configStore;
    this.item = null;
    this.disposed = false;
    this.viewModel = {};
    this.currentUserNativeIndices = [];
    this.recreate();
  }

  recreate() {
    if (this.disposed) return;
    const config = this.configStore.getCurrent().statusBar;
    const alignment = config.alignment === 'right' ? this.vscode.StatusBarAlignment.Right : this.vscode.StatusBarAlignment.Left;
    const priority = typeof config.priority === 'number' ? config.priority : 10;
    if (this.item && this.item.alignment === alignment && this.item.priority === priority) return;
    if (this.item) this.item.dispose();
    this.item = this.vscode.window.createStatusBarItem(alignment, priority);
    this.item.command = 'sysmonitor.openPanel';
    this.item.tooltip = 'System Monitor';
    this.update();
  }

  setViewModel(viewModel, currentUserNativeIndices) {
    this.viewModel = viewModel;
    this.currentUserNativeIndices = currentUserNativeIndices;
    this.update();
  }

  update() {
    if (!this.item) return;
    const text = formatStatusBarText(this.configStore.getCurrent().statusBar, this.viewModel, this.currentUserNativeIndices);
    if (text) {
      this.item.text = text;
      this.item.show();
    } else {
      this.item.hide();
    }
  }

  dispose() {
    this.disposed = true;
    if (this.item) this.item.dispose();
    this.item = null;
  }
}

module.exports = { formatStatusBarText, StatusBarController };
