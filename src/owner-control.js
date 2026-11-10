import net from 'node:net';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdtemp, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicJSON, privateDirectory, readJSON } from './channel-store.js';
import { Operations, digest, requestKey } from './operations.js';
import { acquireFileLock } from './locks.js';
import { validateThread, writerPids } from './ownership.js';
import { DispatchError } from './errors.js';

export const ownerLimit = 8;
export const ownerRecordPath = (root, id) => join(root, 'background', `owner-${id}.json`);
export const ownerOperationDirectory = root => join(root, 'owner-operations');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const error = (code, message) => new DispatchError(code, message);

export async function reserveOwnerSlot(directory, limit = ownerLimit) {
  await privateDirectory(directory);
  for (let i = 0; i < limit; i++) {
    try { return await acquireFileLock(join(directory, `owner-slot-${i}.mutex`)); }
    catch (e) { if (e.code !== 'BUSY') throw e; }
  }
  throw error('OWNER_LIMIT_REACHED', `At most ${limit} background owners may be retained. Archive or hand off an idle plugin-owned chat first.`);
}

export async function retainedOwner(root, id, writers = writerPids) {
  validateThread(id);
  const record = await readJSON(ownerRecordPath(root, id));
  if (!record) return null;
  if (record.version !== 1 || record.threadId !== id || !Number.isSafeInteger(record.pid) || record.pid <= 1 ||
    !Number.isSafeInteger(record.serverPid) || record.serverPid <= 1 || typeof record.token !== 'string' || record.token.length !== 64 ||
    typeof record.generation !== 'string' || typeof record.endpoint !== 'string') throw error('INVALID_OWNER_RECORD', 'Background owner identity is invalid.');
  if (!alive(record.pid)) return null;
  const pids = await writers(id);
  if (pids.length !== 1 || pids[0] !== record.serverPid) return null;
  const parent = await lstat(join(record.endpoint, '..'));
  const socket = await lstat(record.endpoint);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || (parent.mode & 0o077) ||
    !socket.isSocket() || socket.uid !== process.getuid() || (socket.mode & 0o077)) throw error('UNSAFE_OWNER_SOCKET', 'Background control endpoint must be private and owned by this user.');
  return record;
}

export async function readOwnerOutcome(root, args, command = 'archive') {
  const state = await new Operations(ownerOperationDirectory(root)).read(args.requestId);
  if (!state) return null;
  const expected = digest(JSON.stringify([command, args.threadId.toLowerCase(), ...(args.expectedTurnId ? [args.expectedTurnId] : [])]));
  if (state.fingerprint !== expected || state.threadId !== args.threadId) throw error('REQUEST_ID_CONFLICT', 'Owner operation identity does not match this request.');
  const { fingerprint, ...result } = state;
  return result;
}

export function requestOwner(record, command, args, { signal, timeoutMs = 35000 } = {}) {
  requestKey(args.requestId); validateThread(args.threadId);
  if (signal?.aborted) return Promise.reject(error('ABORTED', 'Cancelled before contacting the background owner.'));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(record.endpoint);
    let buffer = '', done = false;
    const finish = (e, value) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy();
      e ? reject(e) : resolve(value);
    };
    const abort = () => finish(error('OWNER_UNREACHABLE', 'Owner reply was not received. Inspect the same request ID before retrying.'));
    const timer = setTimeout(abort, timeoutMs); signal?.addEventListener('abort', abort, { once: true });
    socket.on('connect', () => socket.write(JSON.stringify({ version: 1, token: record.token,
      generation: record.generation, command, ...args }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 65536) return finish(error('INVALID_OWNER_RESPONSE', 'Owner reply exceeds the protocol limit.'));
      if (!buffer.includes('\n')) return;
      try {
        const reply = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
        if (reply.generation !== record.generation || reply.threadId !== args.threadId) throw error('INVALID_OWNER_RESPONSE', 'Owner reply identity does not match.');
        if (reply.error) finish(error(reply.error, reply.message)); else finish(null, reply.result);
      } catch (e) { finish(e); }
    });
    socket.on('error', abort); socket.on('close', () => { if (!done) abort(); });
  });
}

export async function serveOwner({ root, threadId, serverPid, handle, afterReply = () => {}, capabilities = {} }) {
  validateThread(threadId);
  await privateDirectory(join(root, 'background'));
  // Short private path also works when the configured state root exceeds Unix socket path limits.
  const directory = await mkdtemp(join(tmpdir(), 'mcd-owner-')); await chmod(directory, 0o700);
  const record = { version: 1, threadId, pid: process.pid, serverPid, generation: randomUUID(),
    token: randomBytes(32).toString('hex'), endpoint: join(directory, 'control.sock'), capabilities };
  const clients = new Set(); let closing = false;
  const server = net.createServer(socket => {
    clients.add(socket); socket.on('error', () => {}); socket.on('close', () => clients.delete(socket));
    if (closing || clients.size > 16) { socket.destroy(); return; }
    socket.setTimeout(40000, () => socket.destroy());
    let buffer = '', received = false;
    socket.on('data', chunk => {
      if (received) return;
      buffer += chunk;
      if (buffer.length > 65536) { socket.destroy(); return; }
      if (!buffer.includes('\n')) return;
      received = true;
      void (async () => {
        let query;
        try {
          query = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
          if (query.version !== 1 || query.generation !== record.generation || query.threadId !== threadId ||
            typeof query.token !== 'string' || query.token.length !== record.token.length ||
            !timingSafeEqual(Buffer.from(query.token), Buffer.from(record.token))) throw error('OWNER_AUTH_FAILED', 'Owner control identity does not match.');
          requestKey(query.requestId);
          if (!['archive', 'release', 'status'].includes(query.command)) throw error('UNSUPPORTED_OPERATION', 'Only archive, explicit idle release and owner status are supported.');
          if (query.expectedThreadIds !== undefined) {
            if (!Array.isArray(query.expectedThreadIds) || query.expectedThreadIds.length > 1000) throw error('INVALID_ARGUMENT', 'Invalid archive scope.');
            for (const id of query.expectedThreadIds) validateThread(id);
          }
          if (query.expectedTurnId !== undefined && (typeof query.expectedTurnId !== 'string' || !query.expectedTurnId || !capabilities.expectedTurnArchive)) throw error('INVALID_ARGUMENT', 'Guarded archival is unsupported or the expected turn is invalid.');
          const result = await handle(query.command, { requestId: query.requestId, threadId,
            ...(query.expectedThreadIds ? { expectedThreadIds: query.expectedThreadIds } : {}),
            ...(query.expectedTurnId ? { expectedTurnId: query.expectedTurnId } : {}) });
          const reply = JSON.stringify({ generation: record.generation, threadId, result }) + '\n';
          // A disconnected caller must not prevent confirmed archival/release cleanup.
          if (!socket.destroyed) socket.end(reply, () => { void afterReply(result); });
          else void afterReply(result);
        } catch (e) {
          if (!socket.destroyed) socket.end(JSON.stringify({ generation: record.generation, threadId,
            error: e instanceof DispatchError ? e.code : 'OWNER_CONTROL_FAILED',
            message: e instanceof DispatchError ? e.message : 'Background control failed; inspect operation status.' }) + '\n');
        }
      })();
    });
  });
  const close = async () => {
    if (closing) return; closing = true;
    for (const socket of clients) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    const current = await readJSON(ownerRecordPath(root, threadId));
    if (current?.generation === record.generation) await rm(ownerRecordPath(root, threadId), { force: true });
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(record.endpoint, resolve); });
    await chmod(record.endpoint, 0o600);
    await atomicJSON(ownerRecordPath(root, threadId), record);
    return { record, close };
  } catch (e) { await close(); throw e; }
}
