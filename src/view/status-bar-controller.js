'use strict';

function formatStatusBarText(config, viewModel, currentUserNativeIndices = []) {
  if (config.barEnabled === false) return '';
  const parts = [];
  if (config.cpu && viewModel.cpu) parts.push(`$(dashboard) ${viewModel.cpu.usagePercent}%`);
  if (config.ram && viewModel.memory) parts.push(`$(server) ${viewModel.memory.usagePercent}%`);
  const diskRoot = viewModel.disks && viewModel.disks.find((disk) => disk.mount === '/');
  if ((config.disk || (config.diskIO && config.diskIO !== 'off')) && (diskRoot || viewModel.diskIo)) {
    const diskText = config.disk && diskRoot ? `${diskRoot.pct}%` : '';
    let ioText = '';
    if (config.diskIO && config.diskIO !== 'off' && viewModel.diskIo) {
      if (config.diskIO === 'read') ioText = `R${viewModel.diskIo.readText}`;
      else if (config.diskIO === 'write') ioText = `W${viewModel.diskIo.writeText}`;
      else if (config.diskIO === 'combined') ioText = viewModel.diskIo.totalText;
      else ioText = `R${viewModel.diskIo.readText} W${viewModel.diskIo.writeText}`;
    }
    if (diskText && ioText) parts.push(`$(database) ${diskText} (${ioText})`);
    else if (diskText) parts.push(`$(database) ${diskText}`);
    else if (ioText) parts.push(`$(database) ${ioText}`);
  }
  if (config.net && config.net !== 'off' && viewModel.network) {
    let networkText = '';
    if (config.net === 'up') networkText = `↑${viewModel.network.transmitText}`;
    else if (config.net === 'down') networkText = `↓${viewModel.network.receiveText}`;
    else if (config.net === 'combined') networkText = `↕${viewModel.network.totalText}`;
    else if (config.net === 'both') networkText = `↑${viewModel.network.transmitText} ↓${viewModel.network.receiveText}`;
    if (config.ssh && viewModel.sshTraffic && viewModel.sshTraffic.isSsh) networkText += ` (SSH ↑${viewModel.sshTraffic.uploadText} ↓${viewModel.sshTraffic.downloadText})`;
    parts.push(networkText);
  } else if (config.ssh && viewModel.sshTraffic && viewModel.sshTraffic.isSsh) parts.push(`SSH ↑${viewModel.sshTraffic.uploadText} ↓${viewModel.sshTraffic.downloadText}`);
  if (config.gpu && viewModel.gpus && viewModel.gpus.length) {
    const gpu = config.gpu; let hasIcon = false;
    if (gpu.summary) {
      const idle = viewModel.gpus.filter((device) => device.isIdle === true);
      let text = `$(circuit-board) ${idle.length}/${viewModel.gpus.length}`;
      if (gpu.showIdleIds && idle.length) text += ` (${idle.map((device) => device.idx).join(',')})`;
      parts.push(text); hasIcon = true;
    }
    let indices = [];
    if (gpu.mode === 'all') indices = viewModel.gpus.map((device) => device.idx);
    else if (gpu.mode === 'first') indices = viewModel.gpus.slice(0, gpu.firstN || 2).map((device) => device.idx);
    else if (gpu.mode === 'specify') indices = gpu.cards || [];
    else if (gpu.mode === 'my') indices = currentUserNativeIndices;
    const details = indices.sort((left, right) => left - right).map((index) => viewModel.gpus.find((device) => device.idx === index)).filter(Boolean).filter((device) => !(gpu.skipIdle && device.isIdle)).map((device) => {
      const memoryPercent = device.memPct;
      if (gpu.metric === 'util') return `#${device.idx} ${device.util || 0}%`;
      if (gpu.metric === 'vram') return `#${device.idx} ${memoryPercent}%V`;
      return `#${device.idx} ${device.util || 0}%/${memoryPercent}%V`;
    });
    if (details.length) parts.push(`${hasIcon ? '' : '$(circuit-board) '}${details.join(' ')}`);
  }
  return parts.length ? parts.join('  ') : '$(pulse) Monitor';
}

class StatusBarController {
  constructor({ vscode, configStore, subscriptions }) { this.vscode = vscode; this.configStore = configStore; this.subscriptions = subscriptions; this.item = null; this.viewModel = {}; this.currentUserNativeIndices = []; this.recreate(); }
  recreate() {
    const config = this.configStore.getCurrent().statusBar;
    const alignment = config.alignment === 'right' ? this.vscode.StatusBarAlignment.Right : this.vscode.StatusBarAlignment.Left;
    const priority = typeof config.priority === 'number' ? config.priority : 10;
    if (this.item && this.item.alignment === alignment && this.item.priority === priority) return;
    if (this.item) this.item.dispose();
    this.item = this.vscode.window.createStatusBarItem(alignment, priority); this.item.command = 'sysmonitor.openPanel'; this.item.tooltip = 'System Monitor';
    this.subscriptions.push(this.item); this.update();
  }
  setViewModel(viewModel, currentUserNativeIndices) { this.viewModel = viewModel; this.currentUserNativeIndices = currentUserNativeIndices; this.update(); }
  update() { if (!this.item) return; const text = formatStatusBarText(this.configStore.getCurrent().statusBar, this.viewModel, this.currentUserNativeIndices); if (text) { this.item.text = text; this.item.show(); } else this.item.hide(); }
}
module.exports = { formatStatusBarText, StatusBarController };
