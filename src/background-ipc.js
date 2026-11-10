import net from 'node:net';
import { lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { versions } from './desktop.js';
import { DispatchError } from './errors.js';
import { renderConversation } from './background-state.js';
export const ownerVersions = { ...versions, 'thread-archived': 2, 'thread-stream-following-status-requested': 1,
  'thread-unarchived': 1, 'thread-follower-command-approval-decision': 1,
  'thread-follower-file-approval-decision': 1, 'thread-follower-permissions-request-approval-response': 1,
  'thread-follower-submit-user-input': 1, 'thread-follower-submit-mcp-server-elicitation-response': 1,
  'thread-follower-read-model-settings': 1, 'thread-follower-load-complete-history': 1 };
export class BackgroundIPC {
  constructor({ socketPath = join(homedir(), '.codex', 'ipc', 'ipc.sock'), threadId, snapshot, handle, onDisconnect = () => {} }) {
    Object.assign(this, { socketPath, threadId, snapshot, handle, onDisconnect });
    this.followers = new Set(); this.clientId = 'initializing-client'; this.buffer = Buffer.alloc(0);
  }
  async connect() {
    const stat = await lstat(this.socketPath);
    if (!stat.isSocket() || stat.uid !== process.getuid()) throw new DispatchError('UNSAFE_SOCKET', 'Desktop socket is not owned by this user.');
    this.socket = net.createConnection(this.socketPath);
    this.socket.on('data', b => {
      try {
        this.buffer = Buffer.concat([this.buffer, b]);
        while (this.buffer.length >= 4) {
          const size = this.buffer.readUInt32LE(0);
          if (!size || size > 32 * 1024 * 1024) throw Error('Invalid frame');
          if (this.buffer.length < size + 4) break;
          const m = JSON.parse(this.buffer.subarray(4, size + 4)); this.buffer = this.buffer.subarray(size + 4);
          void this.receive(m).catch(() => this.socket.destroy());
        }
      } catch { this.socket.destroy(); }
    });
    this.socket.on('error', () => this.socket.destroy());
    this.socket.on('close', () => { this.rejectInit?.(new DispatchError('DISCONNECTED', 'Desktop disconnected.')); if (!this.closed) this.onDisconnect(); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new DispatchError('IPC_TIMEOUT', 'Desktop initialization timed out.')), 8000);
      this.initId = randomUUID(); this.resolveInit = () => { clearTimeout(timer); resolve(); }; this.rejectInit = e => { clearTimeout(timer); reject(e); };
      this.send({ type: 'request', requestId: this.initId, method: 'initialize', version: 0, sourceClientId: this.clientId,
        params: { clientType: 'magpie-codex-background' }, timeoutMs: 8000 });
    });
    this.broadcast('thread-stream-following-status-requested', { hostId: 'local', conversationId: this.threadId });
  }
  send(m, flushed) {
    const body = Buffer.from(JSON.stringify(m));
    if (body.length > 32 * 1024 * 1024) throw new DispatchError('FRAME_TOO_LARGE', 'Desktop snapshot exceeds frame limit.');
    const head = Buffer.alloc(4); head.writeUInt32LE(body.length); if (this.socket.writableLength > 32 * 1024 * 1024) { this.socket.destroy(); throw new DispatchError('SLOW_CONSUMER', 'Desktop connection is not consuming updates.'); }
    this.socket.write(Buffer.concat([head, body]), flushed);
  }
  broadcast(method, params, targets) {
    this.send({ type: 'broadcast', method, params, version: ownerVersions[method], sourceClientId: this.clientId,
      ...(targets ? { targetClientIds: targets } : {}) });
  }
  publish(targets = [...this.followers]) {
    if (!targets.length || this.closed) return;
    const { state, revision } = this.snapshot();
    this.broadcast('thread-stream-state-changed', { hostId: 'local', conversationId: this.threadId,
      change: { type: 'snapshot', revision, conversationState: renderConversation(state) } }, targets);
  }
  accepts(q) {
    return q.params?.conversationId === this.threadId && (q.params.hostId ?? q.hostId ?? 'local') === 'local' &&
      q.version === ownerVersions[q.method] + (q.hostId != null && q.method.startsWith('thread-follower-') ? 1 : 0) && (q.method === 'thread-owner-discovery' || this.handle.supports(q.method));
  }
  async receive(m) {
    if (m.type === 'response' && m.requestId === this.initId) {
      if (m.resultType !== 'success' || typeof m.result?.clientId !== 'string') throw Error('Initialization rejected');
      this.clientId = m.result.clientId; this.resolveInit(); return;
    }
    if (m.type === 'client-discovery-request') {
      this.send({ type: 'client-discovery-response', requestId: m.requestId, response: { canHandle: this.accepts(m.request) } }); return;
    }
    if (m.type === 'request' && this.accepts(m)) {
      try {
        const result = m.method === 'thread-owner-discovery' ? { supportsUntrustedAppInput: false, executionOwner: 'magpie-codex-background' } : await this.handle(m.method, m.params);
        this.send({ type: 'response', requestId: m.requestId, method: m.method, resultType: 'success', handledByClientId: this.clientId, result });
      } catch { this.send({ type: 'response', requestId: m.requestId, resultType: 'error', error: 'owner-command-rejected' }); }
      return;
    }
    if (m.method === 'ipc-connection-reset') { this.socket.destroy(); return; }
    if (m.method === 'client-status-changed' && m.params?.status === 'disconnected') this.followers.delete(m.params.clientId);
    if (m.type !== 'broadcast' || m.params?.conversationId !== this.threadId || m.params?.hostId !== 'local' ||
      m.version !== ownerVersions[m.method]) return;
    if (m.method === 'thread-stream-following-changed') {
      if (m.params.following) { this.followers.add(m.sourceClientId); this.publish([m.sourceClientId]); }
      else this.followers.delete(m.sourceClientId);
    }
    if (m.method === 'ipc-connection-reset') this.socket.destroy();
  }
  announce() { this.broadcast('thread-unarchived', { hostId: 'local', conversationId: this.threadId }); }
  async archived(ids) {
    if (this.closed || !this.socket?.writable) throw new DispatchError('DISCONNECTED', 'Desktop archive notification is unavailable.');
    for (const id of ids) await new Promise((resolve, reject) => {
      this.send({ type: 'broadcast', method: 'thread-archived', version: 2, sourceClientId: this.clientId,
        params: { hostId: 'local', conversationId: id } }, e => e ? reject(e) : resolve());
    });
  }
  close() { this.closed = true; this.followers.clear(); this.socket?.destroy(); }
}
