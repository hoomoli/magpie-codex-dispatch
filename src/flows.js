import { validatePin, pinNewThread } from './pinning.js';
import { createBackground, backgroundDirectory } from './background.js';
import { requestedMode, permissionSettings } from './permissions.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withServer } from './rpc.js';
import { listProjects, resolveProject } from './projects.js';
import { Operations, digest, requestKey } from './operations.js';
import { createDispatcher } from './dispatch.js';
import { DispatchError } from './desktop.js';
import { desktopState, inspectOwnership, openThread, releaseSource, validateThread, writerPids } from './ownership.js';
import { retainedOwner, requestOwner, readOwnerOutcome } from './owner-control.js';
import { acquireFileLock } from './locks.js';

function validate(operation, args) {
  requestKey(args?.requestId);
  if (operation === 'handoff') validateThread(args.threadId);
  if (operation === 'create') {
    requestedMode(args); validatePin(args);
    if (typeof args.prompt !== 'string' || !args.prompt.trim() || Buffer.byteLength(args.prompt) > 65536) throw new DispatchError('INVALID_ARGUMENT', 'prompt must contain 1-65536 UTF-8 bytes.');
    if (args.title !== undefined && (typeof args.title !== 'string' || !args.title.trim() || args.title.length > 160)) throw new DispatchError('INVALID_ARGUMENT', 'title must contain 1-160 characters.');
    for (const key of ['projectId', 'projectName', 'cwd']) if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key])) throw new DispatchError('INVALID_ARGUMENT', `${key} must be a nonempty string.`);
  }
}
function fingerprint(operation, args) {
  const keys = operation === 'create' ? ['prompt', 'title', 'projectId', 'projectName', 'cwd', 'sandbox'] : ['threadId', 'sourceEndpoint'];
  const values = [operation, ...keys.map(key => args[key] ?? null)];
  if (operation === 'create' && args.permissionMode !== undefined) values.push(args.permissionMode);
  if (operation === 'create' && args.pin === true) values.push({ pin: true });
  return digest(JSON.stringify(values));
}
function publicState(state) {
  const { fingerprint, marker, source, projectVerified, ...result } = state;
  return { ...result, ...(state.threadId ? { threadUrl: `codex://threads/${state.threadId}` } : {}),
    ...(state.phase === 'accepted' || state.phase === 'desktop_owned' ? {} : { retrySameRequestId: true, retryAfterMs: 2500 }) };
}

export function createFlows(options = {}) {
  const directory = options.stateDirectory ?? join(homedir(), '.local', 'state', 'magpie-codex-dispatch');
  const store = options.store ?? new Operations(directory);
  const server = options.server ?? withServer;
  const resolve = options.resolveProject ?? resolveProject;
  const attach = options.desktopState ?? desktopState;
  const writers = options.writerPids ?? writerPids;
  const release = options.releaseSource ?? releaseSource;
  const open = options.openThread ?? openThread;
  const dispatch = options.dispatch ?? createDispatcher({ ...options, stateDirectory: directory });
  const inspect = options.inspectOwnership ?? inspectOwnership;
  const background = options.backgroundCreate ?? createBackground({ stateDirectory: directory, socketPath: options.socketPath, resolve });
  return async function execute(operation, args = {}, { abort } = {}) {
    if (operation === 'create' && options.background !== false) {
      validate(operation, args);
      const legacy = await store.read(args.requestId);
      if (legacy) {
        if (legacy.fingerprint !== fingerprint(operation, args)) throw new DispatchError('REQUEST_ID_CONFLICT', 'This ID belongs to different arguments.');
        if (legacy.accepted) return { ...publicState(legacy), replayed: true };
        throw new DispatchError('LEGACY_OPERATION_PENDING', 'An older create operation already owns this request ID. Inspect it before migration; no new task was created.');
      }
      return background(args, { abort });
    }
    if (operation === 'projects') return listProjects({ signal: abort, server });
    if (operation === 'ownership') {
      const state = await inspect(args.threadId, { signal: abort, socketPath: options.socketPath });
      if (state.owner === 'background') {
        const record = await retainedOwner(directory, args.threadId);
        if (record) {
          try { state.backgroundControl = { available: true, ...await requestOwner(record, 'status',
            { threadId: args.threadId, requestId: `inspect-${args.threadId}` }, { signal: abort, timeoutMs: 2000 }) }; }
          catch (error) { state.backgroundControl = error.code === 'UNSUPPORTED_OPERATION'
            ? { available: true, statusAvailable: false } : { available: false }; }
        } else state.backgroundControl = { available: false };
      }
      return state;
    }
    if (operation === 'operation_status') {
      const state = await new Operations(backgroundDirectory(directory)).read(args.requestId) ?? await store.read(args.requestId);
      if (!state) throw new DispatchError('OPERATION_NOT_FOUND', 'No operation exists for this requestId.');
      if (['archive', 'delete'].includes(state.operation)) {
        const { fingerprint: _, ...result } = state;
      if (state.route === 'background-owner' && state.operation === 'archive') {
        const receipt = await readOwnerOutcome(directory, { requestId: args.requestId, threadId: state.threadId });
        if (receipt) return { ...result, ...receipt };
      }
        if (state.operation === 'delete') {
          const { retryAfterMs: ignored, ...historical } = result;
          return { ...historical, retired: true, automaticRetry: false, retrySameRequestId: false,
            reason: 'Historical deletion receipt only. Permanent deletion is no longer available; do not retry this operation. Inspect current state separately.' };
        }
        if (state.phase === 'waiting_writer_release') {
          const { retryAfterMs: ignored, ...historical } = result;
          return { ...historical, legacyPhase: state.phase, phase: 'owner_action_required', supported: false,
            actionRequired: 'archive_in_owner', automaticRetry: false, retryOnlyAfter: 'confirmed_writer_release',
            reason: 'Held archival is outside plugin scope. Archive in the owning desktop/client; retry this archive request only after confirmed natural writer release. No automatic retry or app restart.' };
        }
        return result;
      }
      return publicState(state);
    }
    if (operation === 'recover_creation') {
      requestKey(args.requestId); validateThread(args.threadId);
      return store.locked(args.requestId, async () => {
        const state = await store.read(args.requestId);
        if (!state || state.operation !== 'create') throw new DispatchError('OPERATION_NOT_FOUND', 'No creation operation exists for this requestId.');
        if (state.threadId) {
          if (state.threadId !== args.threadId) throw new DispatchError('RECOVERY_MISMATCH', 'This operation already belongs to another thread.');
          return publicState(state);
        }
        if (!['creating', 'creation_unknown'].includes(state.phase)) throw new DispatchError('RECOVERY_NOT_REQUIRED', 'Creation has not been submitted. Retry the original create request.');
        const { thread } = await server({ signal: abort }, c => c.request('thread/read', { threadId: args.threadId, includeTurns: false }));
        if (thread?.id !== args.threadId || thread.threadSource !== state.marker || thread.cwd !== state.cwd || (thread.projectId ?? null) !== state.projectId) {
          throw new DispatchError('RECOVERY_MISMATCH', 'The thread does not match this operation source marker and project. Nothing was bound or dispatched.');
        }
        const recovered = { ...state, threadId: thread.id, phase: 'thread_created', projectVerified: true, reason: null };
        await store.save(args.requestId, recovered);
        return publicState(recovered);
      }, { signal: abort });
    }
    validate(operation, args);
    if (!['create', 'handoff'].includes(operation)) throw new DispatchError('INVALID_ARGUMENT', 'Unknown flow.');
    return store.locked(args.requestId, async () => {
      const fp = fingerprint(operation, args);
      let state = await store.read(args.requestId);
      if (state && state.fingerprint !== fp) throw new DispatchError('REQUEST_ID_CONFLICT', 'This requestId belongs to different arguments.');
      if (state?.phase === 'accepted') return { ...publicState(state), replayed: true };
      state ??= { requestId: args.requestId, operation, fingerprint: fp, phase: 'preparing', accepted: false,
        ...(operation === 'handoff' ? { threadId: args.threadId } : {}) };
      const save = async patch => { state = { ...state, ...patch }; await store.save(args.requestId, state); };
      const settings = { signal: abort, socketPath: options.socketPath, timeoutMs: 2000 };
      const checkAbort = () => { if (abort?.aborted) throw new DispatchError('ABORTED', 'Cancelled. Retry this operation with the same requestId.'); };
      checkAbort();
      if (operation === 'create' && !state.threadId) {
        if (state.phase === 'creating' || state.phase === 'creation_unknown') {
          // Reconcile by a unique persisted source marker. Never infer failure from absence.
          const found = await server({ signal: abort }, async client => {
            let cursor; const matches = [];
            let inspected = 0;
            for (let page = 0; page < 10; page++) {
              const result = await client.request('thread/list', { cwd: state.cwd, limit: 100, sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'], ...(cursor ? { cursor } : {}) });
              for (const listed of result.data ?? []) {
                // Some desktop builds omit threadSource from list entries.
                if (listed.threadSource === state.marker) { matches.push(listed); continue; }
                if (listed.threadSource || inspected >= 30) continue;
                inspected++;
                const { thread } = await client.request('thread/read', { threadId: listed.id, includeTurns: false });
                if (thread?.threadSource === state.marker) matches.push(thread);
              }
              cursor = result.nextCursor; if (!cursor) break;
            }
            return matches;
          });
          if (found.length !== 1) { await save({ phase: 'creation_unknown', reason: 'Creation may have succeeded. No second thread will be created. Empty threads may be absent from listings; use codex_recover_creation with the verified thread ID, then retry this ID.' }); return publicState(state); }
          validateThread(found[0].id);
          if (found[0].cwd !== state.cwd || (found[0].projectId ?? null) !== state.projectId) {
            await save({ threadId: found[0].id, phase: 'project_mismatch' });
            throw new DispatchError('PROJECT_MISMATCH', 'Recovered thread belongs to a different workspace. Nothing was dispatched.');
          }
          await save({ threadId: found[0].id, phase: 'thread_created', projectVerified: true, reason: null });
        } else {
          const project = await resolve(args, { signal: abort, server });
          await save({ ...project, phase: 'preparing', marker: `magpie-codex-dispatch:${requestKey(args.requestId)}` });
          await server({ signal: abort, cwd: project.cwd }, async client => {
            checkAbort();
            await save({ phase: 'creating' });
            const { thread } = await client.request('thread/start', { cwd: project.cwd, projectId: project.projectId,
              ephemeral: false, historyMode: 'paginated', ...permissionSettings(requestedMode(args)), threadSource: state.marker });
            validateThread(thread?.id);
            await save({ threadId: thread.id, phase: 'thread_created' });
            if (thread.cwd !== project.cwd || (thread.projectId ?? null) !== project.projectId) {
              await save({ phase: 'project_mismatch' });
              throw new DispatchError('PROJECT_MISMATCH', 'Created thread did not confirm the requested project. No task was dispatched.');
            }
            await client.request('thread/name/set', { threadId: thread.id, name: args.title ?? 'Magpie task' });
            await save({ projectVerified: true });
          }); // Creator must exit before desktop attachment; it never receives turn/start.
        }
      }
      if (state.phase === 'project_mismatch') throw new DispatchError('PROJECT_MISMATCH', 'Project mismatch requires inspection. No task was dispatched.');
      checkAbort();
      // A process can exit after saving the ID but before validating its metadata.
      if (operation === 'create' && !state.projectVerified) {
        const { thread } = await server({ signal: abort }, c => c.request('thread/read', { threadId: state.threadId, includeTurns: false }));
        if (thread?.id !== state.threadId || thread.cwd !== state.cwd || (thread.projectId ?? null) !== state.projectId || thread.threadSource !== state.marker) {
          await save({ phase: 'project_mismatch' });
          throw new DispatchError('PROJECT_MISMATCH', 'Resumed creation metadata did not match. Nothing was dispatched.');
        }
        await save({ projectVerified: true });
      }
      if (operation === 'create' && args.pin === true && !state.pinConfirmed) {
        await save(await server({ signal: abort }, c => pinNewThread(c, state.threadId)));
      }
      let desktop;
      try { desktop = await attach(state.threadId, settings); } catch (error) { if (abort?.aborted) throw error; }
      const waitForActualDesktop = async () => {
        if (!desktop || desktop.owner === 'desktop') return false;
        if (operation === 'handoff' && desktop.owner === 'background') {
          const owner = await (options.findBackgroundOwner ?? retainedOwner)(directory, state.threadId);
          if (owner) {
            if (args.sourceEndpoint) throw new DispatchError('SOURCE_MISMATCH', 'A Companion endpoint cannot release this background owner.');
            const unlock = await acquireFileLock(join(directory, `thread-${digest(state.threadId.toLowerCase())}.mutex`), { signal: abort });
            let receipt;
            try {
              await save({ phase: 'background_release_requested', owner: 'background' });
              receipt = await (options.requestBackgroundOwner ?? requestOwner)(owner, 'release', { requestId: args.requestId, threadId: state.threadId }, { signal: abort });
            } finally { await unlock(); }
            if (receipt.phase !== 'release_accepted') throw new DispatchError('OUTCOME_UNKNOWN', 'Background release was not confirmed. Inspect the same request ID.');
            await save({ phase: 'waiting_source_release', owner: 'background', source: { kind: 'background' },
              reason: 'Idle background owner accepted release. Retry this handoff ID to confirm unload and attach desktop.' });
            return true;
          }
        }
        await save({ phase: 'waiting_writer_release', owner: desktop.owner ?? 'unknown',
          reason: 'The follower is connected to a non-desktop owner. Wait for normal source release; desktop ownership is not confirmed.' });
        return true;
      };
      if (await waitForActualDesktop()) return publicState(state);
      if (!desktop) {
        const pids = await writers(state.threadId);
        if (pids.length) {
          if (operation === 'handoff' && !state.source && state.phase !== 'release_requested') {
            try {
              await release(state.threadId, args.sourceEndpoint, { signal: abort, beforeRelease: async source => save({ source, phase: 'release_requested' }) });
            } catch (error) {
              if (error.delivery === 'not-submitted') {
                await save({ source: null, phase: 'release_rejected', reason: error.code });
              }
              // Timeout/disconnect/ambiguous RPC errors retain the durable intent.
              // Only a verified rejection before forwarding permits a new attempt.
              throw error;
            }
            await save({ phase: 'waiting_source_release', reason: 'Source accepted unsubscribe; waiting for its writer to unload.' });
          } else await save({ phase: state.source || state.phase === 'release_requested' ? 'waiting_source_release' : 'waiting_writer_release',
            reason: 'A writer still holds this thread. Retry the same ID; the plugin will not force release.' });
          return publicState(state);
        }
        await save({ phase: 'waiting_desktop', owner: 'unattached', reason: 'Waiting for the native desktop to attach.' });
        await open(state.threadId);
        try { desktop = await attach(state.threadId, settings); }
        catch (error) { if (abort?.aborted) throw error; return publicState(state); }
        if (await waitForActualDesktop()) return publicState(state);
      }
      if (operation === 'handoff') {
        await save({ phase: 'desktop_owned', owner: 'desktop', reason: null });
        return publicState(state);
      }
      if (desktop.cwd && desktop.cwd !== state.cwd) throw new DispatchError('PROJECT_MISMATCH', 'Desktop attached to a different workspace. Nothing was dispatched.');
      await save({ phase: 'dispatching', reason: null });
      try {
        const receipt = await dispatch('dispatch', { threadId: state.threadId, prompt: args.prompt, requestId: `flow_${requestKey(args.requestId)}`, ...(args.permissionMode !== undefined ? { permissionMode: args.permissionMode } : args.sandbox !== undefined ? { sandbox: args.sandbox } : {}) }, { abort });
        await save({ phase: 'accepted', accepted: true, completed: false, turnId: receipt.turnId, owner: 'desktop', permissions: receipt.permissions });
      } catch (error) {
        await save({ phase: error.code === 'OUTCOME_UNKNOWN' ? 'dispatch_unknown' : 'waiting_dispatch', reason: error.code ?? 'DISPATCH_FAILED' });
        if (error.code !== 'OUTCOME_UNKNOWN') throw error;
      }
      return publicState(state);
    }, { signal: abort });
  };
}
