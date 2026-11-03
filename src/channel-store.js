import { mkdir, open, readFile, rename, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Journal } from './dispatch.js';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const stateRoot = () => process.env.MAGPIE_CODEX_STATE_DIR ?? join(homedir(), '.local', 'state', 'magpie-codex-dispatch');
export function routeDirectory(id, root = stateRoot()) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('A dedicated Claude session UUID is required.');
  return join(root, 'channels', id);
}
export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await new Journal(path).prepare();
}
export async function atomicJSON(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const f = await open(temp, 'wx', 0o600);
  try { await f.writeFile(JSON.stringify(value)); await f.sync(); } finally { await f.close(); }
  await rename(temp, path);
  const dir = await open(join(path, '..'), 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}
export async function readJSON(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Unsafe state file.');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
// A worker holds the route lock for its lifetime. All writes use one queue.
export class ChannelStore {
  constructor(directory) { this.directory = directory; this.path = join(directory, 'queue.json'); this.queue = Promise.resolve(); }
  async init() {
    await privateDirectory(this.directory);
    this.data = await readJSON(this.path) ?? { version: 1, tasks: {} };
    if (this.data.version !== 1 || !this.data.tasks || Array.isArray(this.data.tasks)) throw new Error('Unsupported channel queue.');
  }
  change(fn) {
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      const result = fn(next);
      await atomicJSON(this.path, next); this.data = next;
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  register(name, args) {
    if (typeof args.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(args.requestId)) throw new Error('Invalid requestId.');
    const key = hash(args.requestId);
    const fingerprint = hash(JSON.stringify([name, Object.keys(args).sort().map(k => [k, args[k]])]));
    return this.change(data => {
      const previous = data.tasks[key];
      if (previous && previous.fingerprint !== fingerprint) throw new Error('REQUEST_ID_CONFLICT: notification binding differs.');
      if (!previous) {
        if (Object.keys(data.tasks).length >= 4096) throw new Error('Channel history is full. Start a new launcher session.');
        if (Object.values(data.tasks).filter(t => !t.review).length >= 128) throw new Error('Too many unreviewed tasks.');
        data.tasks[key] = { key, name, requestId: args.requestId, fingerprint, createdAt: new Date().toISOString() };
      }
      return key;
    });
  }
  accept(key, receipt) {
    if (!receipt.accepted || !receipt.threadId || !receipt.turnId) return Promise.resolve();
    return this.change(data => {
      const task = data.tasks[key];
      if (task.turnId && (task.turnId !== receipt.turnId || task.threadId !== receipt.threadId)) throw new Error('Receipt identity changed.');
      Object.assign(task, { threadId: receipt.threadId, turnId: receipt.turnId });
    });
  }
  complete(key, result) {
    if (!['completed', 'failed', 'interrupted'].includes(result.status)) return Promise.resolve(false);
    return this.change(data => {
      const task = data.tasks[key];
      if (task.event || result.threadId !== task.threadId || result.turnId !== task.turnId) return false;
      task.event = { eventId: hash(`${task.threadId}:${task.turnId}`), threadId: task.threadId,
        turnId: task.turnId, status: result.status, hasError: result.hasError, finishedAt: new Date().toISOString() };
      const previous = Object.values(data.tasks).find(t => t.event?.eventId === task.event.eventId && t.review);
      if (previous) task.review = previous.review;
      return true;
    });
  }
  review(eventId, verdict, summary) {
    if (!['passed', 'changes_requested', 'unable_to_review'].includes(verdict) || typeof summary !== 'string' || !summary.trim() || summary.length > 8000) throw new Error('A review verdict and summary (1–8000 characters) are required.');
    return this.change(data => {
      const tasks = Object.values(data.tasks).filter(t => t.event?.eventId === eventId);
      if (!tasks.length) throw new Error('Event does not belong to this Claude session.');
      const old = tasks.find(t => t.review)?.review;
      if (old && (old.verdict !== verdict || old.summary !== summary)) throw new Error('Review already recorded with a different result.');
      const review = old ?? { verdict, summary, reviewedAt: new Date().toISOString() };
      for (const t of tasks) t.review = review;
      return review;
    });
  }
  pending() { return Object.values(this.data.tasks).filter(t => t.event && !t.review); }
}
