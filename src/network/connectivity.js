export class Connectivity {
  constructor(config, transport, telemetry) {
    Object.assign(this, { config, transport, telemetry });
    this.result = { state: 'unknown', checkedAt: null };
    this.destinations = ['https://www.cloudflare.com/cdn-cgi/trace', 'https://www.wikipedia.org/', 'https://www.microsoft.com/'];
  }

  async check(force = false) {
    if (!this.config.connectivityEnabled) return { state: 'disabled' };
    if (!force && Date.now() - (this.checkedAt ?? 0) < 60000) return this.result;
    if (this.pending) return this.pending;
    this.pending = this.probe().finally(() => { this.pending = null; });
    return this.pending;
  }

  async probe() {
    const results = await Promise.allSettled(this.destinations.map(async input => {
      const response = await this.transport.request(input, { method: 'HEAD', allowedHosts: [new URL(input).hostname], redirects: 0, timeout: 3000 });
      const reachable = response.statusCode >= 200 && response.statusCode < 500;
      response.destroy();
      return reachable;
    }));
    const successes = results.filter(result => result.status === 'fulfilled' && result.value).length;
    this.checkedAt = Date.now();
    this.result = { state: successes === 0 ? 'suspected_disruption' : successes === results.length ? 'reachable' : 'degraded', reachable: successes, destinations: results.length, checkedAt: new Date().toISOString() };
    await this.telemetry.store.set('system', 'connectivity', this.result);
    return this.result;
  }
}
