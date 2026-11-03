import { lstat, open, readFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Journal } from './dispatch.js';
import { DispatchError } from './desktop.js';
import { acquireFileLock } from './locks.js';

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
  async locked(id, fn, { signal } = {}) {
    await this.journal.prepare();
    const unlock = await acquireFileLock(`${this.path(id)}.mutex`, { signal, busyCode: 'OPERATION_BUSY' });
    try {
      // Retain old state for inspection. A dead legacy owner (including an orphaned
      // .recovery directory) cannot block the new kernel lock. Never bypass a live
      // or incomplete legacy owner. Stop old plugin hosts before upgrading.
      const legacy = `${this.path(id)}.lock`;
      const info = await lstat(legacy).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (info) {
        let owner;
        try { owner = JSON.parse(await readFile(join(legacy, 'owner.json'), 'utf8')); }
        catch { throw new DispatchError('OPERATION_BUSY', 'Legacy operation ownership is incomplete. Inspect plugin state before retrying.'); }
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 1 || alive(owner.pid)) {
          throw new DispatchError('OPERATION_BUSY', 'A legacy plugin operation may still be running. Stop the old host before retrying.');
        }
      }
      return await fn();
    } finally { await unlock(); }
  }
}
