import { Desktop, summarize } from './desktop.js';

// Reconnect only after connection failure, never periodically query a live turn.
export class CompletionMonitor {
  constructor({ store, desktopFactory = options => new Desktop(options), socketPath, onEvent = () => {}, onError = () => {}, retryMs = 1000 }) {
    Object.assign(this, { store, desktopFactory, socketPath, onEvent, onError, retryMs });
    this.active = new Map(); this.stopped = false;
  }
  refresh() {
    for (const task of Object.values(this.store.data.tasks)) {
      if (task.turnId && !task.event && !this.active.has(task.key)) this.start(task);
    }
  }
  start(task) {
    const entry = { stopped: false, attempt: 0 };
    this.active.set(task.key, entry);
    const connect = async () => {
      if (this.stopped || entry.stopped) return;
      let failed = false;
      const reconnect = error => {
        if (failed || this.stopped || entry.stopped) return;
        failed = true; this.onError(task.key, error.code ?? 'MONITOR_ERROR');
        entry.timer = setTimeout(connect, Math.min(this.retryMs * 2 ** entry.attempt++, 30000));
      };
      const client = this.desktopFactory({ socketPath: this.socketPath,
        onDisconnect: reconnect,
        onState: snapshot => {
          const result = summarize(snapshot, task.turnId);
          if (!['completed', 'failed', 'interrupted'].includes(result.status) || entry.stopped) return;
          entry.stopped = true;
          this.store.complete(task.key, result).then(changed => {
            clearTimeout(entry.timer); client.close(); this.active.delete(task.key);
            if (changed) this.onEvent();
          }).catch(error => { entry.stopped = false; client.close(); reconnect(error); });
        } });
      entry.client = client;
      try { await client.connect(task.threadId); } catch (error) { client.close(); reconnect(error); }
    };
    void connect();
  }
  close() {
    this.stopped = true;
    for (const entry of this.active.values()) { clearTimeout(entry.timer); entry.client?.close(); }
    this.active.clear();
  }
}
