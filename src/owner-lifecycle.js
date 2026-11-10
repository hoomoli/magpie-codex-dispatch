import { Operations, digest } from './operations.js';
import { ownerOperationDirectory } from './owner-control.js';
import { archiveSubtree } from './archive-scope.js';
import { writerPids } from './ownership.js';
import { DispatchError } from './errors.js';

export function createOwnerLifecycle({ root, runtime, serverPid, writers = writerPids,
  announce = async () => {}, operations }) {
  const store = operations ?? new Operations(ownerOperationDirectory(root));
  let closing = false;
  return (command, args) => runtime.exclusive(() => store.locked(args.requestId, async () => {
    if (!['archive', 'release'].includes(command)) throw new DispatchError('UNSUPPORTED_OPERATION', 'Permanent deletion and arbitrary owner mutations are not supported.');
    const fingerprint = digest(JSON.stringify([command, args.threadId.toLowerCase(), ...(args.expectedTurnId ? [args.expectedTurnId] : [])]));
    const old = await store.read(args.requestId);
    if (old && old.fingerprint !== fingerprint) throw new DispatchError('REQUEST_ID_CONFLICT', 'This owner request ID belongs to different arguments.');
    if (old && !['preparing', 'preflight_failed'].includes(old.phase)) {
      const { fingerprint: _, ...result } = old; return { ...result, replayed: true };
    }
    const state = { operation: command === 'archive' ? 'archive' : 'release', requestId: args.requestId,
      ...(args.expectedTurnId ? { expectedTurnId: args.expectedTurnId } : {}),
      threadId: args.threadId, fingerprint, route: 'background-owner', phase: 'preparing', completed: false, submitted: false };
    const save = () => store.save(args.requestId, state);
    const result = () => { const { fingerprint: _, ...publicState } = state; return publicState; };
    let intent = false;
    try {
      if (closing || runtime.lifecycleBlocked) throw new DispatchError('OWNER_CLOSING', 'Owner has a lifecycle operation pending or confirmed; inspect its original receipt.');
      if (runtime.state?.id !== args.threadId) throw new DispatchError('INVALID_TARGET', 'Owner does not hold this thread.');
      try { runtime.idle(); }
      catch { throw new DispatchError('THREAD_ACTIVE', 'The owner is running or awaiting input. Nothing was archived or released.'); }
      const pids = await writers(args.threadId);
      if (pids.length !== 1 || pids[0] !== serverPid) throw new DispatchError('OWNER_CHANGED', 'The original backend no longer exclusively holds the writer. No takeover was attempted.');
      const current = await runtime.rpc.request('thread/read', { threadId: args.threadId, includeTurns: true });
      if (current.thread?.id !== args.threadId || current.thread.ephemeral !== false) throw new DispatchError('INVALID_TARGET', 'A persisted owned thread is required.');
      if (current.thread.status?.type !== 'idle' || current.thread.turns?.at(-1)?.status === 'inProgress') throw new DispatchError('THREAD_ACTIVE', 'Backend does not confirm an idle thread.');
      if (args.expectedTurnId) {
        const turn = current.thread.turns?.at(-1);
        if (turn?.id !== args.expectedTurnId || turn.status !== 'completed' || turn.error) throw new DispatchError('TURN_CHANGED', 'The latest turn is no longer the successfully reviewed turn. Nothing was archived.');
      }
      let ids = [args.threadId];
      if (command === 'archive') {
        ids = await archiveSubtree(runtime.rpc, args.threadId);
        if (args.expectedThreadIds && JSON.stringify(ids) !== JSON.stringify([...new Set(args.expectedThreadIds)].sort()))
          throw new DispatchError('SCOPE_CHANGED', 'The descendant set changed after caller preflight. Retry the same request ID to inspect and lock the current scope.');
        for (const id of ids) {
          if (id !== args.threadId && (await writers(id)).length) throw new DispatchError('DESCENDANT_HELD', 'A descendant has a writer. Archive or release it separately first.');
        }
      }
      // One queue serializes this with desktop follower start/settings/steer commands.
      runtime.idle();
      runtime.lifecycleBlocked = true;
      intent = true;
      Object.assign(state, { phase: command === 'archive' ? 'outcome_unknown' : 'release_accepted',
        submitted: command === 'archive', completed: command === 'release', ownerReleaseRequested: command === 'release',
        affectedThreadIds: ids });
      await save();
      if (command === 'release') { closing = true; return result(); }
      try { await runtime.rpc.request('thread/archive', { threadId: args.threadId }); }
      catch (e) {
        // A structured server rejection is different from a lost reply. Never retry either automatically.
        const definite = Number.isInteger(e.rpcCode) && (e.rpcCode === -32602 ||
          ['THREAD_IN_USE', 'THREAD_UNAVAILABLE', 'UNSUPPORTED_METHOD'].includes(e.code));
        Object.assign(state, { phase: definite ? 'rejected' : 'outcome_unknown',
          errorCode: e.code ?? 'UNKNOWN', ...(Number.isInteger(e.rpcCode) ? { rpcCode: e.rpcCode } : {}),
          ...(definite ? { serverRejected: true } : {}) });
        if (state.serverRejected) runtime.lifecycleBlocked = false;
        await save(); return result();
      }
      Object.assign(state, { phase: 'archived', completed: true, serverAcknowledged: true,
        includesSpawnedDescendants: true, desktopNotified: false });
      await save(); // Preserve ACK independently of the caller connection and desktop notification.
      closing = true;
      try { await announce(ids); state.desktopNotified = true; }
      catch { state.notificationError = 'DESKTOP_NOTIFICATION_UNCONFIRMED'; }
      try { await save(); }
      catch { state.desktopNotified = false; state.notificationError = 'NOTIFICATION_RECEIPT_UNCONFIRMED'; }
      return result();
    } catch (e) {
      if (intent) {
        // An ACK may have reached memory but not durable storage. Keep the last durable intent.
        throw new DispatchError('OUTCOME_UNKNOWN', 'Owner lifecycle outcome is unconfirmed. Inspect the same request ID; do not resend with a new ID.');
      }
      Object.assign(state, { phase: 'preflight_failed', errorCode: e.code ?? 'UNKNOWN' });
      await save(); throw e;
    }
  }));
}
