import { homedir } from 'node:os';
import { join } from 'node:path';
import { withServer } from './rpc.js';
import { Operations, digest, requestKey } from './operations.js';
import { acquireFileLock } from './locks.js';
import { validateThread, writerPids, desktopState } from './ownership.js';
import { DispatchError } from './errors.js';
import { archiveSubtree } from './archive-scope.js';
import { retainedOwner, requestOwner, readOwnerOutcome } from './owner-control.js';

export function createLifecycle({ stateDirectory = join(homedir(), '.local', 'state', 'magpie-codex-dispatch'),
  server = withServer, writers = writerPids, inspect = desktopState, socketPath,
  findOwner = retainedOwner, ownerRequest = requestOwner } = {}) {
  const store = new Operations(stateDirectory);
  return async (operation, args, { abort } = {}) => {
    if (operation !== 'archive') throw new DispatchError('UNSUPPORTED_OPERATION', 'Only archive is supported; permanent deletion has been removed.');
    validateThread(args.threadId); requestKey(args.requestId);
    return store.locked(args.requestId, async () => {
      const fingerprint = digest(JSON.stringify([operation, args.threadId.toLowerCase()]));
      const old = await store.read(args.requestId);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new DispatchError('REQUEST_ID_CONFLICT', 'This requestId belongs to different arguments.');
        if (!['preparing', 'waiting_writer_release', 'owner_action_required', 'preflight_failed'].includes(old.phase)) {
          const { fingerprint: _, ...result } = old;
          if (old.route === 'background-owner') {
            const ownerResult = await readOwnerOutcome(stateDirectory, args);
            if (ownerResult) return { ...result, ...ownerResult, replayed: true };
          }
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
          if (m.method === 'thread/archived' && m.params?.threadId) affected.add(m.params.threadId);
        } }, async client => {
          state.stage = 'read_target';
          const { thread } = await client.request('thread/read', { threadId: args.threadId, includeTurns: false });
          if (thread?.id !== args.threadId || thread.ephemeral !== false) throw new DispatchError('INVALID_TARGET', 'A persisted thread is required.');
          // Archiving cascades to spawned descendants. Include all source kinds and both archive states.
          state.stage = 'list_descendants';
          const ids = await archiveSubtree(client, args.threadId);
          state.stage = 'check_writers';
          const heldThreads = []; let backgroundOwner;
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
            if (id === args.threadId && owner.owner === 'background') {
              backgroundOwner = await findOwner(stateDirectory, id, writers);
              if (backgroundOwner) continue;
            }
            heldThreads.push({ threadId: id, owner: owner.owner,
              reason: owner.runtimeStatus === 'idle' && owner.pendingRequests === 0 &&
                (owner.turnFound === false || ['completed', 'failed', 'interrupted'].includes(owner.status))
                ? 'OWNER_ARCHIVE_REQUIRED' : 'OWNERSHIP_UNCONFIRMED' });
          }
          if (heldThreads.length) {
            Object.assign(state, { phase: 'owner_action_required', submitted: false, supported: false, heldThreads,
              actionRequired: 'archive_in_owner', automaticRetry: false,
              retrySameRequestId: true, retryOnlyAfter: 'confirmed_writer_release',
              reason: 'Archiving held threads is outside this plugin scope. Archive in the owning desktop/client, or retry this request only after confirmed natural writer release. No mutation was submitted; do not poll or restart the app.' });
            await save();
            return publicResult();
          }
          if (backgroundOwner) {
            Object.assign(state, { route: 'background-owner', ownerGeneration: backgroundOwner.generation,
              phase: 'outcome_unknown', stage: 'route_owner', submitted: true });
            await save(); submitted = true;
            try {
              const response = await ownerRequest(backgroundOwner, 'archive', { ...args, expectedThreadIds: ids }, { signal: abort });
              Object.assign(state, response); await save();
              return publicResult();
            } catch (e) {
              const receipt = await readOwnerOutcome(stateDirectory, args);
              if (receipt && receipt.phase !== 'preparing') {
                Object.assign(state, receipt); await save();
                if (receipt.phase === 'preflight_failed') { submitted = false; throw new DispatchError(receipt.errorCode, 'Owner preflight refused archival. Nothing was submitted.'); }
                return publicResult();
              }
              throw e;
            }
          }
          // Persist intent before delivery. An ambiguous outcome must never trigger an automatic resend.
          Object.assign(state, { phase: 'outcome_unknown', stage: 'submit', submitted: true });
          await save(); submitted = true;
          await client.request('thread/archive', { threadId: args.threadId });
          Object.assign(state, { phase: 'archived', completed: true,
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
