import { validatePin } from './pinning.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { Operations, digest, requestKey } from './operations.js';
import { atomicJSON, privateDirectory, readJSON } from './channel-store.js';
import { resolveProject } from './projects.js';
import { requestedMode } from './permissions.js';
import { DispatchError } from './errors.js';
export const backgroundDirectory = root => join(root, 'background');
export async function terminalBackgroundState(root, threadId, turnId) {
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) return null;
  try {
    const s = await readJSON(join(backgroundDirectory(root), `thread-${threadId}.json`));
    if (!s) return null;
    return s.threadId === threadId && (!turnId || s.turnId === turnId) && ['completed', 'failed', 'interrupted'].includes(s.status) ? s : null;
  } catch { return null; }
}
export function createBackground({ stateDirectory, socketPath, resolve = resolveProject,
  launch = input => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./background-worker.js', import.meta.url)), input], {
      detached: true, stdio: 'ignore', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'CLAUDE_CODE_MESSAGING_TOKEN')) });
    return new Promise((yes, no) => { child.once('error', no); child.once('spawn', () => { child.unref(); yes(); }); });
  }, startupTimeoutMs = 35000 } = {}) {
  const directory = backgroundDirectory(stateDirectory), store = new Operations(directory);
  return async (args, { abort } = {}) => {
    requestKey(args.requestId); requestedMode(args); validatePin(args);
    const fingerprint = digest(JSON.stringify(['background-v1', args.prompt, args.title ?? null,
      args.projectId ?? null, args.projectName ?? null, args.cwd ?? null, requestedMode(args), ...(args.pin === true ? [{ pin: true }] : [])]));
    await store.locked(args.requestId, async () => {
      const old = await store.read(args.requestId);
      if (old) { if (old.fingerprint !== fingerprint) throw new DispatchError('REQUEST_ID_CONFLICT', 'This request ID belongs to different arguments.'); return; }
      const project = await resolve(args, { signal: abort });
      await privateDirectory(directory);
      const input = join(directory, `${requestKey(args.requestId)}.input.json`);
      await atomicJSON(input, { args, project, stateDirectory, socketPath });
      await store.save(args.requestId, { requestId: args.requestId, fingerprint, phase: 'queued', accepted: false });
      try { await launch(input); }
      catch { await rm(input, { force: true }); await store.save(args.requestId, { requestId: args.requestId, fingerprint, phase: 'launch_failed', accepted: false }); }
    }, { signal: abort });
    const end = Date.now() + startupTimeoutMs;
    do {
      const state = await store.read(args.requestId);
      if (state?.accepted || ['failed', 'launch_failed', 'outcome_unknown'].includes(state?.phase)) {
        const { fingerprint: _, ...result } = state; return result;
      }
      if (abort?.aborted) throw new DispatchError('OUTCOME_UNKNOWN', 'Background creation continues independently. Check this request ID; do not create a replacement.');
      await new Promise(r => setTimeout(r, 100));
    } while (Date.now() < end);
    throw new DispatchError('OUTCOME_UNKNOWN', 'Background startup is not confirmed. Retry this exact request ID; it will not start a second worker.');
  };
}
