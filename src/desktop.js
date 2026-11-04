import { DispatchError } from './errors.js';
import net from 'node:net';
import { permissionSummary, nextPermissions } from './permissions.js';
import { lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { applyPatches, enablePatches } from 'immer';
enablePatches();

export const versions = Object.freeze({
  initialize: 0,
  'thread-owner-discovery': 1,
  'thread-follower-start-turn': 2,
  'thread-follower-update-thread-settings': 2,
  'thread-follower-steer-turn': 1,
  'thread-follower-interrupt-turn': 4,
  'thread-stream-following-changed': 1,
  'thread-stream-state-changed': 11,
});
const MAX_FRAME = 32 * 1024 * 1024;

export { DispatchError } from './errors.js';

export class Desktop {
  constructor({ socketPath = join(homedir(), '.codex', 'ipc', 'ipc.sock'), timeoutMs = 8000, signal, onState, onDisconnect } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.signal = signal;
    this.onState = onState;
    this.onDisconnect = onDisconnect;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.clientId = 'initializing-client';
    this.onAbort = () => this.fail(new DispatchError('ABORTED', 'The caller cancelled the operation.'));
  }

  async connect(threadId) {
    const info = await lstat(this.socketPath).catch(() => {
      throw new DispatchError('SOCKET_UNAVAILABLE', 'Open Codex Desktop; its IPC socket is unavailable.');
    });
    if (!info.isSocket() || info.uid !== process.getuid()) {
      throw new DispatchError('UNSAFE_SOCKET', 'Expected a Unix socket owned by the current user.');
    }
    if (this.signal?.aborted) throw new DispatchError('ABORTED', 'The caller cancelled the operation.');
    this.threadId = threadId;
    this.signal?.addEventListener('abort', this.onAbort, { once: true });
    this.socket = net.createConnection(this.socketPath);
    this.socket.on('data', chunk => this.receive(chunk));
    this.socket.on('error', () => this.fail(new DispatchError('DISCONNECTED', 'Desktop IPC connection failed.')));
    this.socket.on('close', () => this.fail(new DispatchError('DISCONNECTED', 'Desktop IPC connection closed.')));
    const initialized = await this.request('initialize', { clientType: 'magpie-codex-dispatch' });
    if (typeof initialized.result?.clientId !== 'string') throw new DispatchError('PROTOCOL_MISMATCH', 'Missing IPC client identity.');
    this.clientId = initialized.result.clientId;
    const owner = await this.request('thread-owner-discovery', { hostId: 'local', conversationId: threadId });
    if (typeof owner.handledByClientId !== 'string') throw new DispatchError('NO_OWNER', 'Open the target thread in Codex Desktop first.');
    this.owner = owner.handledByClientId;
    this.executionOwner = owner.result?.executionOwner === 'magpie-codex-background' ? 'background' : 'desktop';
    const snapshot = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.snapshotWaiter = undefined;
        reject(new DispatchError('SNAPSHOT_TIMEOUT', 'No desktop state snapshot arrived; nothing was sent.'));
      }, this.timeoutMs);
      this.snapshotWaiter = { resolve, reject, timer };
    });
    try { this.follow(true); } catch (error) { this.fail(error); }
    return await snapshot;
  }

  send(message) {
    if (this.failure) throw this.failure;
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > MAX_FRAME) throw new DispatchError('FRAME_TOO_LARGE', 'IPC request exceeds the frame limit.');
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(body.length);
    this.socket.write(Buffer.concat([prefix, body]));
  }

  request(method, params, { mutation = false } = {}) {
    if (!(method in versions)) return Promise.reject(new DispatchError('UNSUPPORTED_METHOD', 'Unsupported desktop IPC method.'));
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new DispatchError(mutation ? 'OUTCOME_UNKNOWN' : 'IPC_TIMEOUT',
          mutation ? 'Desktop may have accepted the command. Check status before sending another request.' : 'Desktop IPC timed out.'));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, mutation });
      try {
        this.send({ type: 'request', requestId, sourceClientId: this.clientId,
          ...(this.owner ? { targetClientId: this.owner } : {}),
          version: versions[method], method, params, timeoutMs: this.timeoutMs });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  receive(chunk) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32LE(0);
        if (!size || size > MAX_FRAME) throw new DispatchError('INVALID_FRAME', 'Invalid desktop IPC frame size.');
        if (this.buffer.length < size + 4) break;
        const message = JSON.parse(this.buffer.subarray(4, size + 4).toString('utf8'));
        this.buffer = this.buffer.subarray(size + 4);
        this.message(message);
      }
    } catch (error) {
      this.fail(error instanceof DispatchError ? error : new DispatchError('INVALID_FRAME', 'Malformed desktop IPC message.'));
    }
  }

  message(message) {
    if (message.type === 'client-discovery-request') {
      this.send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
      return;
    }
    if (message.type === 'response') {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.resultType === 'success') pending.resolve(message);
      else pending.reject(new DispatchError(pending.mutation ? 'OUTCOME_UNKNOWN' : 'DESKTOP_REJECTED',
        pending.mutation ? 'Desktop returned an error after submission. Inspect the thread before retrying.' : 'Desktop rejected the request. Check the open thread and protocol compatibility.'));
      return;
    }
    if (message.method === 'ipc-connection-reset') {
      this.fail(new DispatchError('DISCONNECTED', 'Desktop IPC was reset.'));
      return;
    }
    if ((!this.snapshotWaiter && !this.onState) || message.type !== 'broadcast' ||
        message.method !== 'thread-stream-state-changed' || message.sourceClientId !== this.owner ||
        message.params?.hostId !== 'local' || message.params?.conversationId !== this.threadId) return;
    if (message.version !== versions['thread-stream-state-changed']) {
      this.fail(new DispatchError('PROTOCOL_MISMATCH', 'Unsupported desktop stream version. No command was submitted.'));
      return;
    }
    const change = message.params.change;
    if (change?.type === 'patches' && this.onState) {
      if (!this.current || change.baseRevision !== this.current.revision || !Number.isInteger(change.revision) || change.revision <= change.baseRevision || !Array.isArray(change.patches)) {
        this.fail(new DispatchError('STREAM_GAP', 'Desktop stream lost continuity; reconnect for a fresh snapshot.'));
        return;
      }
      try {
        const state = applyPatches(this.current.state, change.patches);
        if (state.id !== this.threadId) throw new Error('Identity changed');
        this.current = { state, revision: change.revision };
        this.onState(this.current);
      } catch { this.fail(new DispatchError('PROTOCOL_MISMATCH', 'Invalid desktop patches.')); }
      return;
    }
    if (change?.type !== 'snapshot') return;
    if (change.conversationState?.id !== this.threadId || !Number.isInteger(change.revision)) {
      this.fail(new DispatchError('PROTOCOL_MISMATCH', 'Invalid desktop snapshot.'));
      return;
    }
    const waiter = this.snapshotWaiter;
    this.snapshotWaiter = undefined;
    this.current = { state: change.conversationState, revision: change.revision };
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(this.current);
    }
    this.onState?.(this.current);
  }

  follow(following) {
    this.send({ type: 'broadcast', method: 'thread-stream-following-changed',
      version: versions['thread-stream-following-changed'], sourceClientId: this.clientId,
      targetClientIds: [this.owner], params: { hostId: 'local', conversationId: this.threadId, following } });
  }

  fail(error) {
    const first = !this.failure;
    this.failure ??= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(pending.mutation
        ? new DispatchError('OUTCOME_UNKNOWN', 'The connection ended after submission. Check desktop status before retrying.')
        : this.failure);
    }
    this.pending.clear();
    if (this.snapshotWaiter) {
      clearTimeout(this.snapshotWaiter.timer);
      this.snapshotWaiter.reject(this.failure);
      this.snapshotWaiter = undefined;
    }
    this.socket?.destroy();
    if (first) this.onDisconnect?.(this.failure);
  }

  close() {
    if (this.owner && !this.failure && !this.socket?.destroyed) {
      try { this.follow(false); } catch { /* Closing must not hide the operation result. */ }
    }
    this.signal?.removeEventListener('abort', this.onAbort);
    this.socket?.end();
    this.fail(new DispatchError('CLOSED', 'IPC client closed.'));
  }
}

export function summarize({ state, revision }, turnId) {
  const turns = [...(state.turns ?? []), ...Object.values(state.turnHistory?.history?.entitiesByKey ?? {})]
    .filter(turn => typeof turn?.turnId === 'string');
  const turn = turnId ? turns.find(t => t.turnId === turnId) : turns.sort((a, b) => (b.turnStartedAtMs ?? 0) - (a.turnStartedAtMs ?? 0))[0];
  const output = (turn?.items ?? []).filter(item => item.type === 'agentMessage' && typeof item.text === 'string')
    .map(item => item.text).join('\n');
  const known = new Set(['inProgress', 'completed', 'interrupted', 'failed']);
  return { threadId: state.id, revision, runtimeStatus: state.threadRuntimeStatus?.type ?? 'unknown',
    turnId: turn?.turnId ?? null, status: turn ? (known.has(turn.status) ? turn.status : 'unknown') : 'unknown',
    turnFound: Boolean(turn), pendingRequests: Array.isArray(state.requests) ? state.requests.length : null,
    output: output.slice(-16000), outputTruncated: output.length > 16000,
    hasError: Boolean(turn?.error), permissions: permissionSummary(state.currentPermissions), nextTurnPermissions: nextPermissions(state), threadUrl: `codex://threads/${state.id}` };
}
