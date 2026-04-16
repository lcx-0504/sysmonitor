const GPU_BIN = 'nvidia-smi';
const GPU_BASE_ARGS = [
  '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu',
  '--format=csv,noheader,nounits',
];
const GPU_POWER_ARGS = [
  '--query-gpu=index,power.draw,power.limit',
  '--format=csv,noheader,nounits',
];
const GPU_BASE_TIMEOUT_MS = 5000;
const GPU_POWER_TIMEOUT_MS = 1500;

function splitCsvRow(line) {
  return line.split(',').map((part) => part.trim());
}

function toInt(raw) {
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? null : value;
}

function toRoundedString(raw) {
  const value = Number.parseFloat(raw);
  return Number.isNaN(value) ? null : String(Math.round(value));
}

function cloneGpu(gpu) {
  return {
    idx: gpu.idx,
    name: gpu.name,
    util: gpu.util,
    memUsed: gpu.memUsed,
    memTotal: gpu.memTotal,
    temp: gpu.temp,
    power: gpu.power ? { draw: gpu.power.draw, limit: gpu.power.limit } : null,
  };
}

function parseBaseGpuCsv(stdout) {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [idx, name, util, memUsed, memTotal, temp] = splitCsvRow(line);
      const parsedIdx = toInt(idx);
      if (parsedIdx === null || !name) throw new Error(`invalid GPU base row: ${line}`);
      return {
        idx: parsedIdx,
        name,
        util: toInt(util) ?? 0,
        memUsed: toInt(memUsed) ?? 0,
        memTotal: toInt(memTotal) ?? 0,
        temp: toInt(temp) ?? 0,
        power: null,
      };
    });
}

function mergeGpuPowerCsv(gpus, stdout) {
  const powerMap = new Map();
  stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const [idx, draw, limit] = splitCsvRow(line);
      const parsedIdx = toInt(idx);
      if (parsedIdx === null) return;
      const parsedDraw = toRoundedString(draw);
      const parsedLimit = toRoundedString(limit);
      if (parsedDraw === null || parsedLimit === null) return;
      powerMap.set(parsedIdx, { draw: parsedDraw, limit: parsedLimit });
    });

  return gpus.map((gpu) => ({
    ...cloneGpu(gpu),
    power: powerMap.get(gpu.idx) || null,
  }));
}

function createGpuSnapshotCache() {
  return { lastGood: [] };
}

function collectGpuSnapshot({ execFileSync, dbg }, cache) {
  try {
    const baseOut = execFileSync(GPU_BIN, GPU_BASE_ARGS, { timeout: GPU_BASE_TIMEOUT_MS }).toString().trim();
    let gpus = baseOut ? parseBaseGpuCsv(baseOut) : [];
    try {
      const powerOut = execFileSync(GPU_BIN, GPU_POWER_ARGS, { timeout: GPU_POWER_TIMEOUT_MS }).toString().trim();
      if (powerOut) gpus = mergeGpuPowerCsv(gpus, powerOut);
    } catch (error) {
      if (dbg) dbg(`gpu power query skipped: ${error.message}`);
    }
    cache.lastGood = gpus.map(cloneGpu);
    if (dbg) dbg(`gpu snapshot fresh (${gpus.length} gpus)`);
    return { gpus, source: 'fresh' };
  } catch (error) {
    if (cache.lastGood.length > 0) {
      if (dbg) dbg(`gpu snapshot fallback: ${error.message}`);
      return { gpus: cache.lastGood.map(cloneGpu), source: 'cache' };
    }
    if (dbg) dbg(`gpu snapshot unavailable: ${error.message}`);
    return { gpus: [], source: 'empty' };
  }
}

module.exports = {
  GPU_BIN,
  GPU_BASE_ARGS,
  GPU_POWER_ARGS,
  GPU_BASE_TIMEOUT_MS,
  GPU_POWER_TIMEOUT_MS,
  parseBaseGpuCsv,
  mergeGpuPowerCsv,
  createGpuSnapshotCache,
  collectGpuSnapshot,
};
