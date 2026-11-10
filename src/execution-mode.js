import { join } from 'node:path';
import { Operations } from './operations.js';
import { DispatchError } from './errors.js';

// Reserve the route before either creation journal can start a task.
export async function reserveExecutionMode(directory, requestId, mode, signal) {
  const routes = new Operations(join(directory, 'creation-routes'));
  await routes.locked(requestId, async () => {
    const old = await routes.read(requestId);
    if (old && old.mode !== mode) throw new DispatchError('REQUEST_ID_CONFLICT', 'This request ID already selected another executionMode. Do not change modes on retries.');
    if (!old) await routes.save(requestId, { mode });
  }, { signal });
}
