import { createDispatcher } from './dispatch.js';
import { DispatchError } from './desktop.js';

const threadId = { type: 'string', description: 'UUID of an existing, open local Codex desktop thread.' };
const turnId = { type: 'string', description: 'Turn ID returned by dispatch or status.' };
const requestId = { type: 'string', minLength: 8, maxLength: 128, description: 'Unique command ID. Reuse the same ID and arguments on retries; never automatically retry an unknown outcome with a new ID.' };
const prompt = { type: 'string', minLength: 1, description: 'User-authorized task or follow-up instruction; at most 64 KiB UTF-8.' };

export default async function MagpieCodexDispatch() {
  const run = createDispatcher({ socketPath: process.env.MAGPIE_CODEX_SOCKET,
    stateDirectory: process.env.MAGPIE_CODEX_STATE_DIR });
  const define = (operation, description, properties, required) => ({
    description,
    args: { type: 'object', properties, required, additionalProperties: false },
    async execute(args, context) {
      try { return JSON.stringify(await run(operation, args, context)); }
      catch (error) {
        // Magpie marks thrown errors as MCP isError. Do not leak raw filesystem or protocol payloads.
        const safe = new Error(error instanceof DispatchError ? `${error.code}: ${error.message}` : 'INTERNAL_ERROR: Operation failed.');
        throw safe;
      }
    },
  });
  return { tool: {
    codex_status: define('status', 'Read a fresh desktop snapshot. Unknown or missing history is never reported as success. Returns at most 16000 characters of assistant output.', { threadId, turnId }, ['threadId']),
    codex_dispatch: define('dispatch', 'Start a task in an existing idle Codex desktop thread. The app renders execution live. Acceptance is not completion. Does not create a thread or another server.', { threadId, prompt, requestId }, ['threadId', 'prompt', 'requestId']),
    codex_followup: define('followup', 'Steer an active Codex desktop turn. Checks turnId before sending; the private steer protocol has no atomic expected-turn guard. For an idle thread, use codex_dispatch.', { threadId, turnId, prompt, requestId }, ['threadId', 'turnId', 'prompt', 'requestId']),
    codex_stop: define('stop', 'Request cancellation of the specified active turn using an atomic expectedTurnId guard. Check status to confirm interruption.', { threadId, turnId, requestId }, ['threadId', 'turnId', 'requestId']),
  } };
}
