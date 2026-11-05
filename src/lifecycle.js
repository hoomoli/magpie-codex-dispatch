import { homedir } from 'node:os';
import { join } from 'node:path';
import { withServer } from './rpc.js';
import { Operations, digest, requestKey } from './operations.js';
import { acquireFileLock } from './locks.js';
import { validateThread, writerPids } from './ownership.js';
import { DispatchError } from './errors.js';

const sourceKinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];

export function createLifecycle({ stateDirectory = join(homedir(), '.local', 'state', 'magpie-codex-dispatch'),
  server = withServer, writers = writerPids } = {}) {
  const store = new Operations(stateDirectory);
  return async (operation, args, { abort } = {}) => {
    if (!['archive', 'delete'].includes(operation)) throw new DispatchError('INVALID_ARGUMENT', 'Unknown lifecycle operation.');
    validateThread(args.threadId); requestKey(args.requestId);
    return store.locked(args.requestId, async () => {
      const fingerprint = digest(JSON.stringify([operation, args.threadId.toLowerCase()]));
      const old = await store.read(args.requestId);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new DispatchError('REQUEST_ID_CONFLICT', 'This requestId belongs to different arguments.');
        const { fingerprint: _, ...result } = old;
        return { ...result, replayed: true };
      }
      const affected = new Set(), unlocks = [];
      let submitted = false;
      const state = { operation, requestId: args.requestId, threadId: args.threadId, fingerprint,
        phase: 'outcome_unknown', completed: false };
      try {
        return await server({ signal: abort, lifecycle: true, onNotification: m => {
          if (m.method === `thread/${operation === 'archive' ? 'archived' : 'deleted'}` && m.params?.threadId) affected.add(m.params.threadId);
        } }, async client => {
          const { thread } = await client.request('thread/read', { threadId: args.threadId, includeTurns: false });
          if (thread?.id !== args.threadId || thread.ephemeral !== false) throw new DispatchError('INVALID_TARGET', 'A persisted thread is required.');
          // Both operations cascade to spawned descendants. Include all source kinds and both archive states.
          const ids = new Set([args.threadId]);
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
          for (const id of [...ids].sort()) {
            unlocks.push(await acquireFileLock(join(stateDirectory, `thread-${digest(id.toLowerCase())}.mutex`), { signal: abort }));
            if ((await writers(id)).length) throw new DispatchError('THREAD_IN_USE', 'The target or a descendant still has a writer. Wait for it to unload; no task was interrupted.');
          }
          // Persist intent before delivery. An ambiguous outcome must never trigger an automatic resend.
          await store.save(args.requestId, state); submitted = true;
          await client.request(`thread/${operation}`, { threadId: args.threadId });
          Object.assign(state, { phase: operation === 'archive' ? 'archived' : 'deleted', completed: true,
            serverAcknowledged: true, affectedThreadIds: [...affected],
            includesSpawnedDescendants: true });
          await store.save(args.requestId, state);
          const { fingerprint: _, ...result } = state;
          return result;
        });
      } catch (error) {
        if (submitted) {
          // Keep intent intact even if the connection or receipt write failed.
          throw new DispatchError('OUTCOME_UNKNOWN', 'Lifecycle request was submitted but its outcome is unconfirmed. Inspect operation status; do not retry with a new ID.');
        }
        throw error;
      } finally {
        for (const unlock of unlocks.reverse()) await unlock();
      }
    }, { signal: abort });
  };
}
