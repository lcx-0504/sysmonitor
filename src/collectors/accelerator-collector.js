'use strict';
class AcceleratorCollector {
  constructor({ providers }) { this.providers = providers; }
  async collect() {
    const providerResults = []; const errors = [];
    const settledResults = await Promise.allSettled(this.providers.map((provider) => provider.collect()));
    settledResults.forEach((settledResult, index) => {
      if (settledResult.status === 'fulfilled') providerResults.push({ provider: this.providers[index].id, ...settledResult.value });
      else if (!settledResult.reason || settledResult.reason.code !== 'ENOENT') errors.push(settledResult.reason);
    });
    if (providerResults.length === 0 && errors.length) throw errors[0];
    const devices = []; const usagesByPid = new Map(); const currentUserDeviceKeys = [];
    for (const result of providerResults) {
      devices.push(...result.devices); currentUserDeviceKeys.push(...result.currentUserDeviceKeys);
      for (const [pid, usages] of result.usagesByPid) usagesByPid.set(pid, [...(usagesByPid.get(pid) || []), ...usages]);
    }
    return { devices, usagesByPid, currentUserDeviceKeys };
  }
}
module.exports = { AcceleratorCollector };
