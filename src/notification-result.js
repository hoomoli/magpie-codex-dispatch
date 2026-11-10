import { Desktop, summarize } from './desktop.js';
import { terminalNotificationState } from './notification-history.js';
import { stateRoot } from './channel-store.js';

export async function readNotificationTurn(threadId, turnId, {
  desktopFactory = options => new Desktop(options), readTerminal = terminalNotificationState,
  stateDirectory = stateRoot(), socketPath = process.env.MAGPIE_CODEX_SOCKET,
} = {}) {
  const client = desktopFactory({ socketPath, timeoutMs: 8000 });
  try {
    const result = summarize(await client.connect(threadId), turnId);
    if (result.turnFound) return result;
  } catch {
    // Reading history never acquires a writer or starts another turn.
  } finally { client.close(); }
  const result = await readTerminal(stateDirectory, threadId, turnId);
  if (!result) throw new Error('RESULT_UNAVAILABLE: Final result is unavailable; preserve this event and retry reading later. Do not redispatch.');
  return result;
}

export async function notificationResult(store, eventId, read = readNotificationTurn) {
  if (typeof eventId !== 'string' || !eventId) throw new Error('A completion eventId is required.');
  const task = Object.values(store.data.tasks).find(t => t.event?.eventId === eventId);
  if (!task) throw new Error('Event does not belong to this Claude session.');
  const result = await read(task.event.threadId, task.event.turnId);
  await store.resultRead(eventId, result);
  return { eventId, ...result };
}
