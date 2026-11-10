import { terminalBackgroundState } from './background.js';
import { storedStatus } from './stored-status.js';
import { writerPids } from './ownership.js';

// Used only after live monitoring fails; never load execution to recover a receipt.
export async function terminalNotificationState(root, threadId, turnId, {
  background = terminalBackgroundState, stored = storedStatus, writers = writerPids,
} = {}) {
  const cached = await background(root, threadId, turnId);
  if (cached) return cached;
  if ((await writers(threadId)).length) return null;
  const result = await stored({ threadId, turnId }, { writers });
  return result.threadId === threadId && result.turnId === turnId && result.turnFound &&
    ['completed', 'failed', 'interrupted'].includes(result.status) ? result : null;
}
