import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { Desktop, DispatchError, summarize } from './desktop.js';
import { AppServer, codexHome } from './rpc.js';

const exec = promisify(execFile);
export function validateThread(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new DispatchError('INVALID_ARGUMENT', 'threadId must be a UUID.');
}
async function command(binary, args) {
  try { return (await exec(binary, args, { timeout: 3000, maxBuffer: 1024 * 1024 })).stdout; }
  catch (error) { if (binary === '/usr/sbin/lsof' && error.code === 1 && !error.stderr?.trim()) return ''; throw new DispatchError('OWNERSHIP_CHECK_FAILED', 'Could not inspect local writer ownership.'); }
}
export async function writerPids(threadId) {
  validateThread(threadId);
  const path = join(codexHome(), 'thread-writer-locks', `${threadId}.lock`);
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const out = await command('/usr/sbin/lsof', ['-Fp', '--', path]);
  return [...new Set(out.split('\n').filter(s => /^p\d+$/.test(s)).map(s => Number(s.slice(1))))];
}
export async function sourceFor(threadId, endpoint) {
  const pids = await writerPids(threadId);
  const sources = [];
  for (const pid of pids) {
    const parent = Number((await command('/bin/ps', ['-p', String(pid), '-o', 'ppid='])).trim());
    if (!Number.isSafeInteger(parent) || parent <= 1) continue;
    const cmd = await command('/bin/ps', ['-p', String(parent), '-o', 'args=']);
    if (!/(?:^|\/)app-server-broker\.mjs\s+serve(?:\s|$)/.test(cmd)) continue;
    const sockets = await command('/usr/sbin/lsof', ['-a', '-p', String(parent), '-U', '-Fn']);
    for (const line of sockets.split('\n')) if (line.startsWith('n/') && line.endsWith('/broker.sock')) {
      sources.push({ endpoint: `unix:${line.slice(1)}`, pid, brokerPid: parent });
    }
  }
  const matches = sources.filter(s => !endpoint || s.endpoint === endpoint);
  if (matches.length !== 1) throw new DispatchError(pids.length ? 'UNSUPPORTED_WRITER' : 'NO_SOURCE_WRITER',
    pids.length ? 'The writer is not a uniquely identified Codex Companion broker. Close or release the source session explicitly.' : 'No source writer was found; retry desktop attachment.');
  return matches[0];
}
export async function desktopState(threadId, { signal, socketPath, timeoutMs = 2000 } = {}) {
  const client = new Desktop({ signal, socketPath, timeoutMs });
  try {
    const snapshot = await client.connect(threadId);
    const { output, ...state } = summarize(snapshot);
    return { ...state, owner: 'desktop', desktopClientId: client.owner, cwd: snapshot.state.cwd ?? null };
  } finally { client.close(); }
}
export async function inspectOwnership(threadId, options = {}) {
  validateThread(threadId);
  try { return await desktopState(threadId, options); }
  catch (error) {
    if (options.signal?.aborted) throw error;
    const pids = await writerPids(threadId);
    let source;
    try { source = await sourceFor(threadId); } catch { /* Unknown source remains visible. */ }
    return { threadId, owner: source ? 'companion' : pids.length ? 'external_or_unattached' : 'unattached', writerPids: pids,
      ...(source ? { sourceEndpoint: source.endpoint } : {}), desktopError: error.code ?? 'UNKNOWN', threadUrl: `codex://threads/${threadId}` };
  }
}
export async function releaseSource(threadId, endpoint, { signal, beforeRelease = async () => {} } = {}) {
  const source = await sourceFor(threadId, endpoint);
  const client = new AppServer({ signal });
  try {
    await client.connectCompanion(source.endpoint);
    const { thread } = await client.request('thread/read', { threadId, includeTurns: false });
    if (thread?.id !== threadId || thread.status?.type !== 'idle') throw new DispatchError('SOURCE_NOT_IDLE', 'Only an idle source thread can be handed off. Finish or explicitly cancel its turn at the source first.');
    // Persist before submitting. A lost reply must not cause another unsubscribe.
    await beforeRelease(source);
    const result = await client.request('thread/unsubscribe', { threadId });
    if (!['unsubscribed', 'notLoaded'].includes(result?.status)) throw new DispatchError('RELEASE_UNCONFIRMED', 'Source did not confirm thread release.');
    return { ...source, status: result.status };
  } finally { await client.close(); }
}
export async function openThread(threadId) {
  validateThread(threadId);
  await exec('/usr/bin/open', [`codex://threads/${threadId}`], { timeout: 5000, maxBuffer: 65536 });
}
