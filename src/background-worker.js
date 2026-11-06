import { readFile, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { AppServer } from './rpc.js';
import { Operations, requestKey } from './operations.js';
import { atomicJSON } from './channel-store.js';
import { acquireFileLock } from './locks.js';
import { BackgroundIPC } from './background-ipc.js';
import { BackgroundRuntime } from './background-runtime.js';
import { backgroundDirectory } from './background.js';
import { permissionSettings, requestedMode, assertPermissions } from './permissions.js';
import { summarize } from './desktop.js';
import { Journal } from './dispatch.js';
import { reserveOwnerSlot, serveOwner } from './owner-control.js';
import { createOwnerLifecycle } from './owner-lifecycle.js';

const inputPath = process.argv[2];
const info = await lstat(inputPath);
if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw Error('Unsafe worker input');
const { args, project, stateDirectory, socketPath } = JSON.parse(await readFile(inputPath, 'utf8'));
const directory = backgroundDirectory(stateDirectory), store = new Operations(directory);
const unlock = await acquireFileLock(join(directory, `${requestKey(args.requestId)}.worker.mutex`));
await rm(inputPath);
let operation = await store.read(args.requestId), ipc, control, releaseSlot, reconnectTimer, closing = false, submitted = false;
let persistQueue = Promise.resolve();
function save(patch) { operation = { ...operation, ...patch }; const copy = { ...operation }; persistQueue = persistQueue.then(() => store.save(args.requestId, copy)); return persistQueue; }
async function cache(snapshot) {
  const result = snapshot.state ? summarize(snapshot) : snapshot;
  await atomicJSON(join(directory, `thread-${result.threadId}.json`), result);
}
const runtime = new BackgroundRuntime({ rpc: null,
  publish: () => { try { ipc?.publish(); } catch { ipc?.close(); reconnect(); } },
  onComplete: snapshot => {
    const terminal = summarize(snapshot);
    persistQueue = persistQueue.then(() => cache(terminal));
    // Ownership is retained until explicit archive or idle handoff, not a completion timer.
  }, onUnsupported: () => { void save({ lastError: 'UNSUPPORTED_BACKGROUND_REQUEST' }); } });
const rpc = new AppServer({ execution: true, timeoutMs: 30000, onNotification: m => {
    runtime.notify(m);
    if (m.method === 'turn/started' && runtime.state) {
      const active = summarize(runtime.snapshot());
      persistQueue = persistQueue.then(() => cache(active));
    }
  },
  onRequest: m => runtime.request(m), onFailure: () => { if (!closing) void fail('BACKGROUND_CONNECTION_LOST'); } });
runtime.rpc = rpc;
let connecting = false, attempts = 0;
function reconnect() {
  if (closing || reconnectTimer) return;
  ipc?.close();
  reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect().catch(reconnect); }, Math.min(1000 * 2 ** attempts++, 30000));
}
async function connect() {
  if (connecting || closing) return; connecting = true;
  try {
    ipc = new BackgroundIPC({ socketPath, threadId: runtime.state.id, snapshot: () => runtime.snapshot(), handle: runtime.handle, onDisconnect: reconnect });
    await ipc.connect(); attempts = 0;
  } finally { connecting = false; }
}
async function fail(code) {
  if (closing) return;
  await save({ phase: submitted ? 'outcome_unknown' : 'failed', lastError: code }).catch(() => {});
  await shutdown();
}
async function shutdown(reason = 'owner_stopped') {
  if (closing) return; closing = true; clearTimeout(reconnectTimer);
  runtime.lifecycleBlocked = true;
  await runtime.mutation.catch(() => {});
  await control?.close().catch(() => {});
  ipc?.close(); await rpc.close().catch(() => {});
  await save({ owner: 'released', ownershipState: reason }).catch(() => {});
  await persistQueue.catch(() => {}); await releaseSlot?.(); await unlock(); process.exit(0);
}
process.on('SIGTERM', () => { void shutdown('owner_stopped'); }); process.on('SIGINT', () => { void shutdown('owner_stopped'); });
try {
  await save({ phase: 'creating', workerPid: process.pid });
  releaseSlot = await reserveOwnerSlot(directory);
  await rpc.start({ cwd: project.cwd });
  const settings = permissionSettings(requestedMode(args));
  let result = await rpc.request('thread/start', { cwd: project.cwd, projectId: project.projectId,
    ephemeral: false, ...settings, threadSource: `magpie-codex-dispatch:${requestKey(args.requestId)}` });
  const threadId = result.thread.id;
  await save({ threadId, phase: 'created', threadUrl: `codex://threads/${threadId}` });
  if (result.thread.cwd !== project.cwd || (result.thread.projectId ?? null) !== project.projectId) throw Error('PROJECT_MISMATCH');
  await rpc.request('thread/name/set', { threadId, name: args.title ?? 'Magpie task' });
  // Only this new, empty, never-dispatched thread is cycled. No existing task is touched.
  await rpc.request('thread/archive', { threadId }); await save({ phase: 'archived' });
  await rpc.request('thread/unarchive', { threadId }); await save({ phase: 'restored' });
  result = await rpc.request('thread/resume', { threadId, ...settings });
  runtime.initialize(result, args.title ?? 'Magpie task');
  const permissions = assertPermissions(runtime.state, requestedMode(args));
  await connect(); // Never launch invisible work if the desktop protocol cannot initialize.
  const handle = createOwnerLifecycle({ root: stateDirectory, runtime, serverPid: rpc.child.pid,
    announce: ids => ipc.archived(ids) });
  control = await serveOwner({ root: stateDirectory, threadId, serverPid: rpc.child.pid,
    handle: (command, args) => command === 'status' ? {
      retained: !closing, workerPid: process.pid, serverPid: rpc.child.pid,
      followerCount: ipc?.followers.size ?? 0, lifecycleBlocked: !!runtime.lifecycleBlocked,
      retention: 'until-archive-or-handoff' } : handle(command, args),
    afterReply: receipt => {
      if (receipt.phase === 'archived' || receipt.phase === 'release_accepted') return shutdown(receipt.phase);
    } });
  await save({ phase: 'submitting', owner: 'background' });
  submitted = true;
  const turn = await runtime.start({ threadId, input: [{ type: 'text', text: args.prompt, text_elements: [] }], ...settings });
  const receipt = { accepted: true, completed: false, requestId: args.requestId, threadId, turnId: turn.turn.id,
    owner: 'background', retention: 'until-archive-or-handoff', ownerControlVersion: 1,
    permissions, threadUrl: `codex://threads/${threadId}` };
  await save({ ...receipt, phase: 'accepted' });
  // Compatible durable receipt for the existing completion channel's crash recovery.
  const journal = new Journal(stateDirectory);
  const claim = await journal.claim(`flow_${requestKey(args.requestId)}`, requestKey(args.requestId));
  if (!claim.result) await journal.finish(claim, receipt);
  ipc.announce();
} catch (error) { await fail(error.code ?? error.message ?? 'BACKGROUND_START_FAILED'); }
