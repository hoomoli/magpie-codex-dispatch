import { DispatchError } from './errors.js';

// Server-owned pinned section used by the desktop (not the tool alias "pinned").
export const pinnedSectionId = '01984de2-8f74-7c91-a3b2-5c5e937cf318';

export function validatePin(args) {
  if (args.pin !== undefined && typeof args.pin !== 'boolean') {
    throw new DispatchError('INVALID_ARGUMENT', 'pin must be a boolean.');
  }
}

export async function pinNewThread(client, threadId) {
  let cursor = null, found = false;
  do {
    const page = await client.request('threadSection/list', { cursor, limit: 100 });
    found = page.data.some(section => section.id === pinnedSectionId);
    cursor = page.nextCursor;
  } while (!found && cursor);
  if (!found) throw new DispatchError('PIN_UNAVAILABLE', 'This app-server does not expose the desktop pinned section. No task was dispatched.');
  await client.request('thread/section/move', { threadId, sectionId: pinnedSectionId });
  const { thread } = await client.request('thread/read', { threadId, includeTurns: false });
  if (thread?.section?.id !== pinnedSectionId) {
    throw new DispatchError('PIN_UNCONFIRMED', 'Pinning was not confirmed. Inspect the saved thread; do not create a replacement task.');
  }
  return { pinned: true, pinConfirmed: true };
}
