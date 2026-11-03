import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Journal } from './dispatch.js';
import { DispatchError } from './desktop.js';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function requestKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) throw new DispatchError('INVALID_ARGUMENT', 'requestId must contain 8-128 letters, digits, underscores or hyphens. Reuse it for retries.');
  return digest(value);
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

export class Operations {
  constructor(directory) { this.directory = directory; this.journal = new Journal(directory); }
  path(id) { return join(this.directory, `flow-${requestKey(id)}.json`); }
  async read(id) {
    await this.journal.prepare();
    try { return JSON.parse(await readFile(this.path(id), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new DispatchError('CORRUPT_OPERATION', 'Operation state is unreadable. Do not retry with a new requestId.');
    }
  }
  async save(id, state) {
    const path = this.path(id); const temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ ...state, updatedAt: new Date().toISOString() })); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, path);
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async locked(id, fn) {
    await this.journal.prepare();
    const path = `${this.path(id)}.lock`;
    const acquire = async () => {
      await mkdir(path, { mode: 0o700 });
      const file = await open(join(path, 'owner.json'), 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ pid: process.pid })); await file.sync(); } finally { await file.close(); }
    };
    try { await acquire(); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const recover = `${path}.recovery`;
      try { await mkdir(recover, { mode: 0o700 }); }
      catch { throw new DispatchError('OPERATION_BUSY', 'Another caller is recovering this operation. Retry the same requestId.'); }
      try {
        let owner;
        try { owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')); }
        catch { throw new DispatchError('OPERATION_BUSY', 'Operation ownership is incomplete. Inspect plugin state before recovery; nothing was resubmitted.'); }
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 1 || alive(owner.pid)) throw new DispatchError('OPERATION_BUSY', 'This operation is already running. Retry the same requestId later.');
        // Only plugin-owned locks are reclaimed. Codex writer locks are never changed.
        const tombstone = `${path}.${randomUUID()}.stale`;
        await rename(path, tombstone); await rm(tombstone, { recursive: true });
      } finally { await rm(recover, { recursive: true }); }
      try { await acquire(); } catch { throw new DispatchError('OPERATION_BUSY', 'Another caller resumed this operation.'); }
    }
    try { return await fn(); } finally { await rm(path, { recursive: true }); }
  }
}
