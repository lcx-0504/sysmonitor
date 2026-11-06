'use strict';

function collectionDemand(config, { statusBarAvailable = true } = {}) {
  const hidden = config.display.hiddenGroups;
  const bar = config.statusBar;
  const useBar = statusBarAvailable && bar.barEnabled;
  const gpuBar = useBar && (bar.gpu.summary || bar.gpu.mode !== 'off');
  return {
    cpu: !hidden.cpu || !!(useBar && bar.cpu),
    memory: !hidden.memory || !!(useBar && bar.ram),
    network: !hidden.network || !!(useBar && bar.net !== 'off'),
    diskIo: !hidden.disk || !!(useBar && bar.diskIO !== 'off'),
    diskTopology: !hidden.disk || !!(useBar && bar.disk),
    sshTraffic: !hidden.network || !!(useBar && bar.ssh),
    accelerators: !hidden.gpuCards || !hidden.gpuSummary || !!gpuBar,
    processes: true,
  };
}

module.exports = { collectionDemand };
