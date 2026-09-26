import { fork } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { assertAutomationPlatform } from './automation-store.js';

// Only a kernel ESRCH proves group absence. Enumerating /proc can miss a child
// forked while its parent exits; even zombie-only groups remain conservative barriers.
export function groupAlive(group) {
  assertAutomationPlatform();
  try { process.kill(-group, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class AutomationRunner {
  constructor(service) {
    this.service = service;
    this.store = service.store.automation;
    this.stopped = false;
    this.ready = false;
    this.current = null;
    this.pumping = null;
  }
  recover() {
    if (this.ready) return;
    const ids = this.store.recover();
    this.ready = true;
    this.service.invalidate();
    this.notify(ids);
    this.kick();
  }
  notify(ids) {
    // Delivery is independent of queue progress and participates in service shutdown.
    for (const id of ids) {
      this.service.active++;
      this.service.deliver(id).then(result => {
        if (result.notification.error) this.service.report(new Error(result.notification.error.message));
      }).catch(error => this.service.report(error)).finally(() => {
        this.service.active--;
        this.service.invalidate();
        this.service.finishClose();
      });
    }
  }
  kick() {
    if (!this.ready || this.stopped || this.pumping || !this.store.next()) return;
    this.service.active++;
    this.pumping = this.pump().catch(error => {
      // Never advance after an unconfirmed storage/process observation.
      this.stopped = true;
      this.service.report(error);
    }).finally(() => {
      this.pumping = null;
      this.service.active--;
      if (!this.stopped && this.store.next()) this.kick();
      this.service.finishClose();
    });
  }
  async pump() {
    while (!this.stopped) {
      const next = this.store.next();
      if (!next) return;
      const claimed = this.store.claim(next.task_id);
      if (!claimed) return;
      this.notify(claimed.subscription_ids);
      this.service.invalidate();
      await this.run(claimed.run);
    }
  }
  async run(run) {
    let worker;
    let result;
    let spawnError;
    let loggingError;
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    const append = text => {
      if (!text || loggingError) return;
      try {
        this.store.append(run.task_id, text);
        this.service.invalidate();
      }
      catch (error) {
        loggingError = error;
        this.service.report(error);
        this.terminate();
      }
    };
    try {
      worker = fork(new URL('./automation-worker.js', import.meta.url), [], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [],
      });
      this.current = { taskId: run.task_id, worker, timer: null };
      worker.on('message', message => {
        try {
          if (message.event === 'running') {
            this.store.running(run.task_id);
            this.service.invalidate();
          }
          if (message.event === 'result') result = message;
        } catch (error) {
          loggingError = error;
          this.service.report(error);
          this.terminate();
        }
      });
      [worker.stdout, worker.stderr].forEach((stream, index) => {
        stream.on('data', chunk => append(decoders[index].write(chunk)));
        stream.once('end', () => append(decoders[index].end()));
      });
      const closed = new Promise(resolve => {
        worker.once('error', error => { spawnError = error; });
        worker.once('exit', () => {
          // A completed script must not leave group descendants running.
          if (worker.pid) this.signal(worker.pid, 'SIGKILL');
        });
        worker.once('close', resolve);
      });
      if (worker.pid) {
        // The worker cannot spawn the script until this durable PID precedes go.
        this.store.launched(run.task_id, worker.pid);
        worker.send({ script: JSON.parse(run.script), parameters: JSON.parse(run.parameters) }, error => {
          if (error) { spawnError = error; this.terminate(); }
        });
      }
      await closed;
    } catch (error) {
      spawnError = error;
      this.terminate();
    } finally {
      clearTimeout(this.current?.timer);
      this.current = null;
    }
    let barrier = false;
    let observationError;
    if (worker?.pid) {
      try {
        barrier = groupAlive(worker.pid);
        for (let tries = 0; barrier && tries < 40; tries++) {
          await sleep(25);
          barrier = groupAlive(worker.pid);
        }
      } catch (error) {
        observationError = error;
        barrier = true;
        this.service.report(error);
      }
    }
    const error = observationError ? 'Process-group observation failed; termination is unconfirmed.'
      : loggingError ? 'Log persistence failed; output and effects are unconfirmed.'
      : spawnError ? `Worker launch failed: ${spawnError.code ?? spawnError.message}`
        : this.stopped ? 'Service closed during execution; effects may have occurred.'
          : result?.error ?? (result ? null : 'Worker exited without a confirmed script result; effects may have occurred.');
    const state = this.stopped || loggingError || (!result && !spawnError) || barrier ? 'interrupted'
      : result?.exit_code === 0 && !error && !result.signal ? 'succeeded' : 'failed';
    this.notify(this.store.finish(run.task_id, {
      state, exit_code: result?.exit_code ?? null, signal: result?.signal ?? null, error, barrier,
    }));
    this.service.invalidate();
  }
  signal(pid, signal) {
    try { process.kill(-pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') this.service.report(error); }
  }
  terminate() {
    const current = this.current;
    if (!current?.worker.pid) return;
    this.signal(current.worker.pid, 'SIGTERM');
    if (!current.timer) current.timer = setTimeout(() => this.signal(current.worker.pid, 'SIGKILL'), 500);
  }
  cancel(taskId) {
    if (this.current?.taskId === taskId) this.terminate();
  }
  close() { this.stopped = true; this.terminate(); }
}
