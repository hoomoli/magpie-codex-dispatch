import { homedir } from 'node:os';
import { join } from 'node:path';
import { withServer } from './rpc.js';
import { Operations, digest, requestKey } from './operations.js';
import { acquireFileLock } from './locks.js';
import { validateThread, writerPids, desktopState } from './ownership.js';
import { DispatchError } from './errors.js';

const sourceKinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];

export function createLifecycle({ stateDirectory = join(homedir(), '.local', 'state', 'magpie-codex-dispatch'),
  server = withServer, writers = writerPids, inspect = desktopState, socketPath } = {}) {
  const store = new Operations(stateDirectory);
  return async (operation, args, { abort } = {}) => {
    if (!['archive', 'delete'].includes(operation)) throw new DispatchError('INVALID_ARGUMENT', 'Unknown lifecycle operation.');
    validateThread(args.threadId); requestKey(args.requestId);
    return store.locked(args.requestId, async () => {
      const fingerprint = digest(JSON.stringify([operation, args.threadId.toLowerCase()]));
      const old = await store.read(args.requestId);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new DispatchError('REQUEST_ID_CONFLICT', 'This requestId belongs to different arguments.');
        if (!['preparing', 'waiting_writer_release', 'preflight_failed'].includes(old.phase)) {
          const { fingerprint: _, ...result } = old;
          return { ...result, replayed: true };
        }
      }
      const affected = new Set(), unlocks = [];
      let submitted = false;
      const state = { operation, requestId: args.requestId, threadId: args.threadId, fingerprint,
        phase: 'preparing', stage: 'connect', completed: false };
      const save = () => store.save(args.requestId, state);
      const publicResult = () => { const { fingerprint: _, ...result } = state; return result; };
      try {
        await save();
        return await server({ signal: abort, lifecycle: true, onNotification: m => {
          if (m.method === `thread/${operation === 'archive' ? 'archived' : 'deleted'}` && m.params?.threadId) affected.add(m.params.threadId);
        } }, async client => {
          state.stage = 'read_target';
          const { thread } = await client.request('thread/read', { threadId: args.threadId, includeTurns: false });
          if (thread?.id !== args.threadId || thread.ephemeral !== false) throw new DispatchError('INVALID_TARGET', 'A persisted thread is required.');
          // Both operations cascade to spawned descendants. Include all source kinds and both archive states.
          const ids = new Set([args.threadId]);
          state.stage = 'list_descendants';
          for (const archived of [false, true]) {
            let cursor = null;
            const seen = new Set();
            do {
              const page = await client.request('thread/list', { ancestorThreadId: args.threadId, archived, sourceKinds, limit: 100, cursor });
              if (!Array.isArray(page.data)) throw new DispatchError('INVALID_RPC_RESPONSE', 'Cannot inspect descendant threads.');
              for (const child of page.data) { validateThread(child.id); ids.add(child.id); }
              cursor = page.nextCursor;
              if (cursor && seen.has(cursor) || ids.size > 1000) throw new DispatchError('SCOPE_TOO_LARGE', 'Cannot safely enumerate descendant threads.');
              seen.add(cursor);
            } while (cursor);
          }
          state.stage = 'check_writers';
          const heldThreads = [];
          for (const id of [...ids].sort()) {
            unlocks.push(await acquireFileLock(join(stateDirectory, `thread-${digest(id.toLowerCase())}.mutex`), { signal: abort }));
            if (!(await writers(id)).length) continue;
            let owner;
            try { owner = await inspect(id, { signal: abort, socketPath }); }
            catch (error) {
              if (abort?.aborted) throw error;
              heldThreads.push({ threadId: id, owner: 'unconfirmed', reason: 'OWNERSHIP_UNCONFIRMED' });
              continue;
            }
            if (owner.runtimeStatus === 'active' || owner.status === 'inProgress' || owner.pendingRequests > 0) {
              state.blockingThreadId = id;
              throw new DispatchError('THREAD_ACTIVE', 'The target or a descendant is running or awaiting input. No lifecycle request was submitted.');
            }
            heldThreads.push({ threadId: id, owner: owner.owner,
              reason: owner.runtimeStatus === 'idle' && owner.pendingRequests === 0 &&
                (owner.turnFound === false || ['completed', 'failed', 'interrupted'].includes(owner.status))
                ? 'IDLE_OWNER_MUST_UNLOAD' : 'OWNERSHIP_UNCONFIRMED' });
          }
          if (heldThreads.length) {
            Object.assign(state, { phase: 'waiting_writer_release', submitted: false, heldThreads,
              retrySameRequestId: true, retryAfterMs: 5000,
              reason: 'The owner must unload these threads. Desktop follower IPC has no archive/delete command; no request was submitted and nothing will execute automatically.' });
            await save();
            return publicResult();
          }
          // Persist intent before delivery. An ambiguous outcome must never trigger an automatic resend.
          Object.assign(state, { phase: 'outcome_unknown', stage: 'submit', submitted: true });
          await save(); submitted = true;
          await client.request(`thread/${operation}`, { threadId: args.threadId });
          Object.assign(state, { phase: operation === 'archive' ? 'archived' : 'deleted', completed: true,
            serverAcknowledged: true, affectedThreadIds: [...affected],
            includesSpawnedDescendants: true });
          await save();
          return publicResult();
        });
      } catch (error) {
        if (submitted) {
          Object.assign(state, { phase: 'outcome_unknown', completed: false, errorCode: error.code ?? 'UNKNOWN',
            ...(error.rpcMethod ? { rpcMethod: error.rpcMethod, rpcCode: error.rpcCode } : {}) });
          await save().catch(() => {});
          // Keep intent intact even if the connection or receipt write failed.
          throw new DispatchError('OUTCOME_UNKNOWN', 'Lifecycle request was submitted but its outcome is unconfirmed. Inspect operation status; do not retry with a new ID.');
        }
        Object.assign(state, { phase: 'preflight_failed', submitted: false, errorCode: error.code ?? 'UNKNOWN',
          retrySameRequestId: true,
          ...(error.rpcMethod ? { rpcMethod: error.rpcMethod, rpcCode: error.rpcCode } : {}) });
        await save();
        throw error;
      } finally {
        for (const unlock of unlocks.reverse()) await unlock();
      }
    }, { signal: abort });
  };
}
