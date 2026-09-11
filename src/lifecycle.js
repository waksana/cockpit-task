import { WorkError } from './store.js';

export class Lifecycle {
  constructor({ onDrained = () => {} } = {}) {
    this.onDrained = onDrained;
    this.pending = false;
    this.active = new Map();
    this.scheduled = false;
    this.drained = false;
  }
  assertAccepting() {
    if (this.pending) throw new WorkError('SERVICE_DRAINING', 'Restart pending; mutation was not admitted or executed', 503);
  }
  async mutation(name, action) {
    this.assertAccepting();
    this.active.set(name, (this.active.get(name) ?? 0) + 1);
    try { return await action(); }
    finally {
      const count = this.active.get(name) - 1;
      if (count) this.active.set(name, count); else this.active.delete(name);
      this.scheduleDrain();
    }
  }
  requestRestart() {
    this.pending = true;
    this.scheduleDrain();
    return this.status();
  }
  status() {
    const activeMutations = [...this.active.values()].reduce((total, count) => total + count, 0);
    return {
      restartPending: this.pending, acceptingMutations: !this.pending,
      activeMutations, activeDispatches: this.active.get('work_dispatch') ?? 0,
      activeNotifications: this.active.get('work_deliver') ?? 0,
      activeRecoveries: this.active.get('work_recover') ?? 0,
      safeToRestart: this.pending && activeMutations === 0,
      reason: activeMutations ? 'in-flight-mutations' : this.pending ? 'drained' : 'admission-open',
    };
  }
  scheduleDrain() {
    if (!this.pending || this.active.size || this.scheduled || this.drained) return;
    this.scheduled = true;
    // Let the accepted HTTP operation and restart acknowledgement flush first.
    setImmediate(() => {
      this.scheduled = false;
      if (this.active.size || this.drained) return;
      this.drained = true;
      this.onDrained();
    });
  }
}
