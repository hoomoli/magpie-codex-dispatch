import { terminalNotificationState } from './notification-history.js';
import { stateRoot } from './channel-store.js';
import { Desktop, summarize } from './desktop.js';

// Reconnect only after connection failure, never periodically query a live turn.
export class CompletionMonitor {
  constructor({ store, desktopFactory = options => new Desktop(options), socketPath, stateDirectory = stateRoot(), readTerminal = terminalNotificationState, onEvent = () => {}, onError = () => {}, retryMs = 1000 }) {
    Object.assign(this, { store, desktopFactory, socketPath, stateDirectory, readTerminal, onEvent, onError, retryMs });
    this.active = new Map(); this.stopped = false;
  }
  refresh() {
    for (const task of Object.values(this.store.data.tasks)) {
      if (task.turnId && !task.event && !this.active.has(task.key)) this.start(task);
    }
  }
  start(task) {
    const entry = { stopped: false, attempt: 0, attentionSignature: JSON.stringify((task.attention ?? []).map(e =>
      ({ requestId: e.requestId, method: e.method, kind: e.status === 'waiting_on_approval' ? 'approval' : 'input' }))) };
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
          if (!entry.stopped && result.status === 'inProgress') {
            const signature = JSON.stringify(result.attentionRequests.map(({ requestId, method, kind }) => ({ requestId, method, kind })));
            if (entry.attentionSignature !== signature) {
              entry.attentionSignature = signature;
              this.store.setAttention(task.key, result).then(changed => {
                if (changed && !entry.stopped) this.onEvent();
              }).catch(error => { entry.attentionSignature = undefined; client.close(); reconnect(error); });
            }
          }
          if (!['completed', 'failed', 'interrupted'].includes(result.status) || entry.stopped) return;
          entry.stopped = true;
          this.store.complete(task.key, result).then(changed => {
            clearTimeout(entry.timer); client.close(); this.active.delete(task.key);
            if (changed) this.onEvent();
          }).catch(error => { entry.stopped = false; client.close(); reconnect(error); });
        } });
      entry.client = client;
      try { await client.connect(task.threadId); } catch (error) {
        // A failed connect may already have scheduled a retry via onDisconnect.
        // Finish recovery first and suppress the close() callback's CLOSED error.
        failed = true; clearTimeout(entry.timer);
        client.close();
        try {
          const terminal = await this.readTerminal(this.stateDirectory, task.threadId, task.turnId);
          if (terminal && !entry.stopped && !this.stopped) {
            const changed = await this.store.complete(task.key, terminal);
            entry.stopped = true; clearTimeout(entry.timer); this.active.delete(task.key);
            if (changed && !this.stopped) this.onEvent();
            return;
          }
        } catch (recoveryError) { error = recoveryError; }
        failed = false; reconnect(error);
      }
    };
    void connect();
  }
  close() {
    this.stopped = true;
    for (const entry of this.active.values()) { clearTimeout(entry.timer); entry.client?.close(); }
    this.active.clear();
  }
}
