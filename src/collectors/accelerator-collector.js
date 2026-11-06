'use strict';
class AcceleratorCollector {
  constructor({ providers }) {
    this.providers = providers;
    this.previous = new Map();
  }

  reset() { this.previous.clear(); }
  async collect({ onPartial = () => {} } = {}) {
    const progress = new Map();
    const publish = () => {
      const values = this.providers.map(provider => progress.get(provider.id)?.value || this.previous.get(provider.id));
      const pending = [...progress.values()].map(partial => partial.failureCode).filter(Boolean);
      const failureCode = pending.includes('GPU_OCCUPANCY_UNAVAILABLE') ? 'GPU_OCCUPANCY_UNAVAILABLE' : pending[0];
      if (values.every(Boolean)) onPartial({ value: combine(values), failureCode });
    };
    const providerResults = [];
    const errors = [];
    const settledResults = await Promise.allSettled(this.providers.map(async provider => {
      const value = await provider.collect({ onPartial: partial => {
        progress.set(provider.id, partial);
        publish();
      } });
      progress.set(provider.id, { value });
      publish();
      return value;
    }));
    settledResults.forEach((settledResult, index) => {
      const provider = this.providers[index].id;
      if (settledResult.status === 'fulfilled') {
        this.previous.set(provider, settledResult.value);
        providerResults.push({ provider, ...settledResult.value });
      } else {
        const previous = this.previous.get(provider);
        if (previous && previous.devices.length) providerResults.push({ provider, ...previous });
        if (previous && previous.devices.length || !settledResult.reason || settledResult.reason.code !== 'ENOENT') errors.push(settledResult.reason);
      }
    });
    if (providerResults.length === 0 && errors.length) throw errors[0];
    const value = combine(providerResults);
    if (errors.length) { onPartial({ value }); throw errors[0]; }
    return value;
  }
}

function combine(providerResults) {
    const devices = [];
    const usagesByPid = new Map();
    const currentUserDeviceKeys = [];
    const collectionErrors = [];
    for (const result of providerResults) {
      devices.push(...result.devices);
      currentUserDeviceKeys.push(...result.currentUserDeviceKeys);
      collectionErrors.push(...result.collectionErrors || []);
      for (const [pid, usages] of result.usagesByPid) usagesByPid.set(pid, [...(usagesByPid.get(pid) || []), ...usages]);
    }
    const sampledAt = providerResults.map(result => result.sampledAt).filter(Number.isFinite);
    return { devices, usagesByPid, currentUserDeviceKeys,
      occupancyKnown: providerResults.every(result => result.occupancyKnown !== false),
      ...(collectionErrors.length ? { collectionErrors } : {}),
      ...(sampledAt.length ? { sampledAt: Math.max(...sampledAt) } : {}) };
}
module.exports = { AcceleratorCollector };
