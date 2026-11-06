import { withServer } from './rpc.js';
import { writerPids } from './ownership.js';
import { DispatchError } from './errors.js';

// Read persisted history without resuming a thread or acquiring its execution ownership.
export async function storedStatus(args, { signal, server = withServer, writers = writerPids } = {}) {
  return server({ signal }, async client => {
    const { thread } = await client.request('thread/read', { threadId: args.threadId, includeTurns: false });
    if (thread?.id !== args.threadId || thread.ephemeral !== false) throw new DispatchError('THREAD_UNAVAILABLE', 'No matching persisted thread was returned.');
    let turn, cursor = null, historyTruncated = false;
    const seen = new Set();
    // A requested old turn requires bounded pagination; the latest turn requires just one item.
    for (let page = 0; page < 10; page++) {
      const result = await client.request('thread/turns/list', { threadId: args.threadId,
        limit: args.turnId ? 20 : 1, sortDirection: 'desc', itemsView: 'full', cursor });
      if (!Array.isArray(result.data)) throw new DispatchError('INVALID_RPC_RESPONSE', 'Persisted turn history is malformed.');
      turn = args.turnId ? result.data.find(t => t.id === args.turnId) : result.data[0];
      cursor = result.nextCursor;
      if (turn || !args.turnId || !cursor) break;
      if (seen.has(cursor)) throw new DispatchError('INVALID_RPC_RESPONSE', 'Persisted history cursor repeated.');
      seen.add(cursor);
      if (page === 9) historyTruncated = true;
    }
    // Ownership may have changed while reading. Never present stale history as a live snapshot.
    if ((await writers(args.threadId)).length) throw new DispatchError('WRITER_CHANGED', 'A writer attached during the history read; query live state.');
    const output = (turn?.items ?? []).filter(i => i.type === 'agentMessage' && typeof i.text === 'string').map(i => i.text).join('\n');
    const recordedStatus = turn?.status ?? null;
    return { threadId: args.threadId, turnId: turn?.id ?? args.turnId ?? null,
      source: 'persisted-history', historyOnly: true, runtimeStatus: 'notLoaded', owner: 'unattached',
      status: ['completed', 'failed', 'interrupted'].includes(recordedStatus) ? recordedStatus : 'unknown',
      recordedStatus, turnFound: Boolean(turn), historyTruncated,
      pendingRequests: null, permissions: null, nextTurnPermissions: null,
      output: output.slice(-16000), outputTruncated: output.length > 16000, hasError: Boolean(turn?.error),
      threadUrl: `codex://threads/${args.threadId}` };
  });
}
