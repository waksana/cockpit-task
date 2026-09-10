import { WorkError } from './store.js';
import { AsyncLocalStorage } from 'node:async_hooks';

export class EffectUnknown extends WorkError {
  constructor(message) { super('EFFECT_UNKNOWN', message, 502); }
}
export class Cockpit {
  constructor({ url = 'http://127.0.0.1:8771', token, timeout = 60000 } = {}) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname)) {
      throw new Error('Cockpit adapter requires an explicitly local HTTP endpoint');
    }
    this.url = url.replace(/\/$/, ''); this.token = token; this.timeout = timeout;
    this.metrics = { calls: 0, bytes: 0, byIntent: {} };
    this.tracking = new AsyncLocalStorage();
  }
  track(record, action) { return this.tracking.run(record, action); }
  async call(name, body, mutation = true) {
    this.metrics.calls++;
    this.metrics.byIntent[name] = (this.metrics.byIntent[name] ?? 0) + 1;
    const record = this.tracking.getStore();
    record?.(name, 0, true);
    let response;
    try {
      response = await fetch(`${this.url}/intent/${name}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeout), redirect: 'error',
      });
      const raw = await response.text();
      this.metrics.bytes += Buffer.byteLength(raw);
      record?.(name, Buffer.byteLength(raw), false);
      if (!response.ok) throw new Error(`Cockpit ${name}: HTTP ${response.status}`);
      const value = JSON.parse(raw);
      if (value.ok === false) throw new Error(`Cockpit ${name} did not acknowledge success`);
      return value;
    } catch (error) {
      // Even an HTTP error can follow a committed native side effect.
      if (mutation) throw new EffectUnknown(error.message);
      throw new WorkError('UPSTREAM_READ_FAILED', error.message, 502);
    }
  }
  async meta(sessionId) {
    const { meta } = await this.call('session/get', { sessionId }, false);
    if (!meta) throw new WorkError('SESSION_NOT_FOUND', 'Native session not found', 404);
    return meta;
  }
}
