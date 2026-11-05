import { createDispatcher } from './dispatch.js';
import { createFlows } from './flows.js';
import { permissionModes } from './permissions.js';
import { DispatchError } from './desktop.js';
import { pluginName, pluginVersion, loadedAt } from './version.js';
import { createLifecycle } from './lifecycle.js';

const threadId = { type: 'string', description: 'UUID of an existing, open local Codex desktop thread.' };
const turnId = { type: 'string', description: 'Turn ID returned by dispatch or status.' };
const requestId = { type: 'string', minLength: 8, maxLength: 128, description: 'Unique command ID. Reuse the same ID and arguments on retries; never automatically retry an unknown outcome with a new ID.' };
const permissionMode = { type: 'string', enum: permissionModes, description: 'Default inherit: preserve existing thread settings or backend defaults for new background threads; does not copy another desktop chat. Use auto-review for a workspace-write sandbox with on-request approvals routed to Codex auto_review; the reviewer may approve or deny eligible requests. Use full-access only when the user explicitly authorized unrestricted filesystem/network access without shell approval prompts. Explicit modes are applied to the idle native thread and verified before dispatch.' };
const prompt = { type: 'string', minLength: 1, description: 'User-authorized task or follow-up instruction; at most 64 KiB UTF-8.' };

export default async function MagpieCodexDispatch() {
  const run = createDispatcher({ socketPath: process.env.MAGPIE_CODEX_SOCKET,
    stateDirectory: process.env.MAGPIE_CODEX_STATE_DIR });
  const flows = createFlows({ socketPath: process.env.MAGPIE_CODEX_SOCKET, stateDirectory: process.env.MAGPIE_CODEX_STATE_DIR });
  const lifecycle = createLifecycle({ stateDirectory: process.env.MAGPIE_CODEX_STATE_DIR });
  const define = (operation, description, properties, required) => ({
    description,
    args: { type: 'object', properties, required, additionalProperties: false },
    async execute(args, context) {
      try {
        if (operation === 'plugin_info') return JSON.stringify({ name: pluginName, pluginVersion, loadedAt });
        const deadline = AbortSignal.timeout(45000);
        const abort = context?.abort ? AbortSignal.any([context.abort, deadline]) : deadline;
        const executor = ['archive', 'delete'].includes(operation) ? lifecycle : ['status', 'dispatch', 'followup', 'stop', 'permissions'].includes(operation) ? run : flows;
        return JSON.stringify({ ...await executor(operation, args, { ...context, abort }), pluginVersion });
      }
      catch (error) {
        // Magpie marks thrown errors as MCP isError. Do not leak raw filesystem or protocol payloads.
        const safe = new Error(error instanceof DispatchError ? `${error.code}: ${error.message}` : 'INTERNAL_ERROR: Operation failed.');
        throw safe;
      }
    },
  });
  return { tool: {
    codex_archive: define('archive', 'Archive a user-selected persisted thread and attempt to archive its spawned descendants. Refuses any target/descendant with a writer; wait for unload. Does not stop tasks or release owners. Reuse requestId on retries. Returns server acknowledgment; affectedThreadIds are observed notifications, not proof all descendants archived.', { threadId, requestId }, ['threadId', 'requestId']),
    codex_delete: define('delete', 'Permanently delete a persisted active or archived thread AND its spawned descendants through Codex. Use only when the user explicitly requested deletion of this scope. Refuses any target/descendant with a writer; never stops tasks. Reuse requestId on retries; unknown outcomes must be inspected, never resent with a new ID.', { threadId, requestId }, ['threadId', 'requestId']),
    codex_plugin_info: define('plugin_info', `Report the loaded ${pluginName} v${pluginVersion} and module load time. No desktop connection or task execution. Use this to verify a plugin reload.`, {}, []),
    codex_projects: define('projects', 'List canonical Codex project IDs and workspace roots. Use these IDs rather than desktop UI project IDs.', {}, []),
    codex_create_task: define('create', 'Create and execute a task in the background in the selected project or cwd. Refresh the ordinary desktop sidebar without navigating or pinning. The desktop follows live progress when viewed. No manual opening is required to start execution. Reuse identical arguments and requestId after an uncertain outcome. Acceptance is not completion.', {
      requestId, prompt, permissionMode,
      title: { type: 'string', maxLength: 160 },
      projectId: { type: 'string', description: 'Canonical ID from codex_projects.' },
      projectName: { type: 'string', description: 'Exact unique project name from codex_projects.' },
      cwd: { type: 'string', description: 'Absolute existing workspace directory; required for multiple roots or projectless creation.' },
      sandbox: { type: 'string', enum: ['read-only', 'workspace-write'], description: 'Legacy alias: read-only or workspace-write/on-request. Prefer permissionMode; conflicting values are rejected.' },
    }, ['requestId', 'prompt']),
    codex_ownership: define('ownership', 'Inspect native desktop ownership and local writer holders. Does not release or execute anything.', { threadId }, ['threadId']),
    codex_handoff: define('handoff', 'Transfer an idle Codex Companion thread to native Codex Desktop. The source must stop submitting to this thread first. Never interrupts active work, deletes Codex locks, or kills shared brokers. Pending release can take over a minute: retry identical arguments and requestId.', {
      threadId, requestId, sourceEndpoint: { type: 'string', description: 'Optional unix: endpoint; must match the actual writer broker. Otherwise discovered safely.' },
    }, ['threadId', 'requestId']),
    codex_recover_creation: define('recover_creation', 'Bind a known thread ID to an uncertain create operation only after verifying its unique source marker, cwd and project. For empty threads omitted from lists. Does not dispatch; retry the original create arguments afterward.', { requestId, threadId }, ['requestId', 'threadId']),
    codex_operation_status: define('operation_status', 'Read persisted create/handoff progress without advancing it. For current execution, use codex_status with threadId and turnId.', { requestId }, ['requestId']),
    codex_set_permissions: define('permissions', 'Apply an explicitly user-authorized permission mode to an idle native desktop thread and verify next-turn settings. Does not start a task. Refuses active threads; full-access requires explicit user authorization.', { threadId, requestId, permissionMode: { ...permissionMode, enum: permissionModes.filter(mode => mode !== 'inherit'), description: 'Explicit user-authorized mode for this idle thread. Full Access requires explicit authorization for unrestricted filesystem/network access without shell approvals.' } }, ['threadId', 'requestId', 'permissionMode']),
    codex_status: define('status', 'Read a fresh desktop snapshot. Unknown or missing history is never reported as success. Returns at most 16000 characters of assistant output.', { threadId, turnId }, ['threadId']),
    codex_dispatch: define('dispatch', 'Start a task in an existing idle Codex desktop thread. The app renders execution live. Acceptance is not completion. Does not create a thread or another server.', { threadId, prompt, requestId, permissionMode }, ['threadId', 'prompt', 'requestId']),
    codex_followup: define('followup', 'Steer an active Codex desktop turn. Checks turnId before sending; the private steer protocol has no atomic expected-turn guard. For an idle thread, use codex_dispatch.', { threadId, turnId, prompt, requestId }, ['threadId', 'turnId', 'prompt', 'requestId']),
    codex_stop: define('stop', 'Request cancellation of the specified active turn using an atomic expectedTurnId guard. Check status to confirm interruption.', { threadId, turnId, requestId }, ['threadId', 'turnId', 'requestId']),
  } };
}
