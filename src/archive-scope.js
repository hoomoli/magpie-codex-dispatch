import { validateThread } from './ownership.js';
import { DispatchError } from './errors.js';

export const archiveSourceKinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];

export async function archiveSubtree(client, threadId) {
  const ids = new Set([threadId]);
  for (const archived of [false, true]) {
    let cursor = null; const seen = new Set();
    do {
      const page = await client.request('thread/list', { ancestorThreadId: threadId, archived,
        sourceKinds: [...new Set(archiveSourceKinds)], limit: 100, cursor });
      if (!Array.isArray(page.data)) throw new DispatchError('INVALID_RPC_RESPONSE', 'Cannot inspect descendant threads.');
      for (const child of page.data) { validateThread(child.id); ids.add(child.id); }
      cursor = page.nextCursor;
      if ((cursor && seen.has(cursor)) || ids.size > 1000 || seen.size >= 1000) throw new DispatchError('SCOPE_TOO_LARGE', 'Cannot safely enumerate descendant threads.');
      seen.add(cursor);
    } while (cursor);
  }
  return [...ids].sort();
}
