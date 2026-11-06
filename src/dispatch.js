import { terminalBackgroundState } from './background.js';
import { requestedMode, permissionSettings, assertPermissions, nextPermissions } from './permissions.js';
import { mkdir, lstat, open, readFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Desktop, DispatchError, summarize } from './desktop.js';
import { acquireFileLock } from './locks.js';
import { writerPids } from './ownership.js';
import { storedStatus } from './stored-status.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = value => createHash('sha256').update(value).digest('hex');

function validate(operation, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || (typeof args.threadId !== 'string' || !uuid.test(args.threadId))) {
    throw new DispatchError('INVALID_ARGUMENT', 'threadId must be a UUID copied from the target desktop thread.');
  }
  if (!['status', 'dispatch', 'followup', 'stop', 'permissions'].includes(operation)) throw new DispatchError('INVALID_ARGUMENT', 'Unknown operation.');
  if (args.turnId !== undefined && (typeof args.turnId !== 'string' || !args.turnId.length || args.turnId.length > 128)) {
    throw new DispatchError('INVALID_ARGUMENT', 'turnId must be a nonempty string of at most 128 characters.');
  }
  requestedMode(args);
  if (operation === 'permissions' && requestedMode(args) === 'inherit') throw new DispatchError('INVALID_ARGUMENT', 'Select an explicit permissionMode for this idle thread.');
  if (['followup', 'stop'].includes(operation) && (args.permissionMode !== undefined || args.sandbox !== undefined)) throw new DispatchError('INVALID_ARGUMENT', 'Change permissions only while the thread is idle.');
  if (operation === 'status') return;
  if (typeof args.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(args.requestId)) {
    throw new DispatchError('INVALID_ARGUMENT', 'Provide a unique requestId of 8-128 letters, digits, underscores or hyphens. Reuse it for retries.');
  }
  if (!['stop', 'permissions'].includes(operation) && (typeof args.prompt !== 'string' || !args.prompt.trim() || Buffer.byteLength(args.prompt) > 65536)) {
    throw new DispatchError('INVALID_ARGUMENT', 'prompt must contain 1-65536 UTF-8 bytes.');
  }
  if (['stop', 'followup'].includes(operation) && !args.turnId) throw new DispatchError('INVALID_ARGUMENT', 'turnId is required to target an active turn.');
}

// Durable receipts contain identifiers and hashes, never prompts or conversation text.
export class Journal {
  constructor(directory) { this.directory = directory; }
  async prepare() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) {
      throw new DispatchError('UNSAFE_STATE_DIRECTORY', 'The receipt directory must be private (0700) and owned by the current user.');
    }
  }
  async claim(key, fingerprint) {
    await this.prepare();
    const path = join(this.directory, `${hash(key)}.json`);
    try {
      const file = await open(path, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ fingerprint, outcome: 'unknown' })); await file.sync(); }
      finally { await file.close(); }
      return { path, fingerprint };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let receipt;
      try { receipt = JSON.parse(await readFile(path, 'utf8')); }
      catch { throw new DispatchError('OUTCOME_UNKNOWN', 'An incomplete receipt exists. Inspect the target thread before retrying.'); }
      if (receipt.fingerprint !== fingerprint) throw new DispatchError('REQUEST_ID_CONFLICT', 'This requestId was already used for a different command.');
      if (!receipt.result) throw new DispatchError('OUTCOME_UNKNOWN', 'This request is in flight or its result is unknown. It will not be sent again.');
      return { result: { ...receipt.result, replayed: true } };
    }
  }
  async finish(claim, result) {
    const temp = `${claim.path}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ fingerprint: claim.fingerprint, result })); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, claim.path);
  }
  async release(claim) { await rm(claim.path); }
}

export function createDispatcher({ socketPath, stateDirectory = join(homedir(), '.local', 'state', 'magpie-codex-dispatch'),
  timeoutMs = 8000, desktopFactory = options => new Desktop(options), writers = writerPids,
  readStored = storedStatus } = {}) {
  const journal = new Journal(stateDirectory);
  return async function execute(operation, args, { abort } = {}) {
    validate(operation, args);
    let claim;
    let submitted = false;
    let unlock;
    let desktop;
    let readingStored = false;
    try {
      if (operation === 'status' && !(await writers(args.threadId)).length) {
        readingStored = true;
        try { return await readStored(args, { signal: abort, writers }); }
        catch (error) { if (error.code !== 'WRITER_CHANGED') throw error; }
        readingStored = false;
      }
      if (operation !== 'status') {
        const values = [operation, args.threadId, args.turnId ?? null, args.prompt ?? null];
        if (args.permissionMode !== undefined && args.permissionMode !== 'inherit') values.push(args.permissionMode);
        claim = await journal.claim(args.requestId, hash(JSON.stringify(values)));
        if (claim.result) return claim.result;
        unlock = await acquireFileLock(join(stateDirectory, `thread-${hash(args.threadId.toLowerCase())}.mutex`), { signal: abort });
      }
      desktop = desktopFactory({ socketPath, timeoutMs, signal: abort });
      let snapshot = await desktop.connect(args.threadId);
      const current = summarize(snapshot);
      if (operation === 'status') return summarize(snapshot, args.turnId);
      if (abort?.aborted) throw new DispatchError('ABORTED', 'The caller cancelled before submission.');
      if (['dispatch', 'permissions'].includes(operation)) {
        if (current.runtimeStatus !== 'idle' || current.status === 'inProgress' || current.pendingRequests !== 0) {
          throw new DispatchError('THREAD_NOT_IDLE', 'The thread is busy, awaiting input, or its state is unknown. Check status first.');
        }
      } else if (current.status !== 'inProgress' || current.turnId !== args.turnId) {
        throw new DispatchError('TURN_CHANGED', 'The requested turn is no longer active. Nothing was sent.');
      }
      let permissions;
      const mode = requestedMode(args);
      if (['dispatch', 'permissions'].includes(operation)) {
        if (mode !== 'inherit' && nextPermissions(snapshot.state).mode !== mode) {
          // Settings are idempotent; a dispatch retry may verify them again, but never replays a submitted turn.
          if (operation === 'permissions') submitted = true;
          try {
            const response = await desktop.request('thread-follower-update-thread-settings', {
              conversationId: args.threadId, threadSettings: permissionSettings(mode),
            }, { mutation: true });
            if (response.result?.applied !== true) throw new Error('Settings not acknowledged');
          } catch {
            throw new DispatchError('PERMISSION_UPDATE_UNCONFIRMED', 'The permission change was not confirmed. No task was sent; inspect status before retrying.');
          }
          desktop.close();
          desktop = desktopFactory({ socketPath, timeoutMs, signal: abort });
          snapshot = await desktop.connect(args.threadId);
          const refreshed = summarize(snapshot);
          if (refreshed.runtimeStatus !== 'idle' || refreshed.status === 'inProgress' || refreshed.pendingRequests !== 0) {
            throw new DispatchError('THREAD_NOT_IDLE', 'The thread became busy during permission verification. No task was sent.');
          }
        }
        permissions = assertPermissions(snapshot.state, mode);
        if (operation === 'permissions') {
          const receipt = { accepted: true, completed: true, operation, requestId: args.requestId, threadId: args.threadId,
            permissions, threadUrl: `codex://threads/${args.threadId}` };
          await journal.finish(claim, receipt);
          return receipt;
        }
      }
      if (abort?.aborted) throw new DispatchError('ABORTED', 'The caller cancelled before submission.');
      const text = [{ type: 'text', text: args.prompt, text_elements: [] }];
      const method = operation === 'dispatch' ? 'thread-follower-start-turn' : operation === 'followup' ? 'thread-follower-steer-turn' : 'thread-follower-interrupt-turn';
      const params = operation === 'dispatch'
        ? { conversationId: args.threadId, turnStart: { request: { threadId: args.threadId, input: text, ...permissionSettings(mode) }, context: { inheritThreadSettings: true } } }
        : operation === 'followup' ? { conversationId: args.threadId, input: text, restoreMessage: { text: args.prompt, context: {} } }
          : { conversationId: args.threadId, mode: 'user-stop', expectedTurnId: args.turnId };
      // No retries after this boundary: even a lost response can mean accepted work.
      submitted = true;
      const response = await desktop.request(method, params, { mutation: true });
      const result = response.result?.result;
      if (operation === 'stop' && (response.result?.ok !== true || response.result?.interruptedTurnId !== args.turnId)) {
        throw new DispatchError('OUTCOME_UNKNOWN', 'Desktop did not confirm interruption of the requested turn. Check status.');
      }
      if (operation === 'followup' && result?.turnId !== args.turnId) {
        throw new DispatchError('OUTCOME_UNKNOWN', 'Desktop did not confirm steering the requested turn. Check status.');
      }
      const turnId = operation === 'dispatch' ? result?.turn?.id : args.turnId;
      if (typeof turnId !== 'string' || !turnId) throw new DispatchError('OUTCOME_UNKNOWN', 'Desktop replied without a turn ID. Inspect the thread before retrying.');
      const receipt = { accepted: true, completed: false, operation, requestId: args.requestId,
        threadId: args.threadId, turnId, ...(permissions ? { permissions } : {}), threadUrl: `codex://threads/${args.threadId}` };
      await journal.finish(claim, receipt);
      return receipt;
    } catch (error) {
      if (operation === 'status' && !readingStored) {
        const terminal = await terminalBackgroundState(stateDirectory, args.threadId, args.turnId);
        if (terminal) return { ...terminal, source: 'durable-background-result' };
      }
      if (claim?.path && !submitted) await journal.release(claim);
      if (submitted && error.code !== 'OUTCOME_UNKNOWN') throw new DispatchError('OUTCOME_UNKNOWN', 'The command may have been accepted but its receipt was not confirmed. Check status; do not resend with a new requestId.');
      throw error;
    } finally {
      try { desktop?.close(); } finally { await unlock?.(); }
    }
  };
}
