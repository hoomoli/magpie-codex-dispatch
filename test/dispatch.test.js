import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDispatcher, Journal } from '../src/dispatch.js';
import { Desktop, summarize } from '../src/desktop.js';
import plugin from '../src/index.js';
import { spawn } from 'node:child_process';

const threadId = '00000000-0000-4000-8000-000000000001';
const turnId = 'turn-example';
const command = { threadId, requestId: 'request-0001', prompt: 'Reply OK; do not use tools.' };
function state(status = 'completed') {
  return { id: threadId, currentPermissions: { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false } }, requests: [], threadRuntimeStatus: { type: status === 'inProgress' ? 'active' : 'idle' },
    turnHistory: { history: { entitiesByKey: { tail: { turnId, status, turnStartedAtMs: 100,
      items: [{ type: 'agentMessage', text: 'OK' }] } } } } };
}
function frame(value) {
  const data = Buffer.from(JSON.stringify(value));
  const prefix = Buffer.alloc(4); prefix.writeUInt32LE(data.length);
  return Buffer.concat([prefix, data]);
}
async function fixture(t, options = {}) {
  // Keep Unix socket paths short on macOS.
  const directory = await mkdtemp(join('/tmp', 'mcd-'));
  const socketPath = join(directory, 'ipc.sock');
  const calls = [];
  let updated = false;
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    const send = value => {
      const data = frame(value);
      // Split the length prefix and coalesce body parts to exercise framing.
      socket.write(data.subarray(0, 2)); socket.write(data.subarray(2));
    };
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0);
        const message = JSON.parse(buffer.subarray(4, length + 4)); buffer = buffer.subarray(length + 4);
        if (message.type === 'request') {
          calls.push(message);
          const reply = result => send({ type: 'response', requestId: message.requestId, resultType: 'success', result, handledByClientId: 'owner' });
          if (message.method === 'initialize') reply({ clientId: 'plugin' });
          else if (message.method === 'thread-owner-discovery') reply({});
          else if (options.dropMutation) socket.destroy();
          else if (options.silentMutation) { /* Simulate an accepted command with a lost reply. */ }
          else if (message.method === 'thread-follower-update-thread-settings') { updated = true; reply({ applied: !options.rejectSettings }); }
          else if (message.method === 'thread-follower-start-turn') {
            if (options.onStart) options.onStart(reply);
            else reply({ result: { turn: { id: turnId } } });
          }
          else if (message.method === 'thread-follower-steer-turn') reply({ result: { turnId } });
          else reply({ ok: !options.rejectStop, interruptedTurnId: turnId });
        } else if (message.method === 'thread-stream-following-changed' && message.params.following && !options.noSnapshot) {
          if (options.badFrame) { socket.write(Buffer.from([255, 255, 255, 255])); continue; }
          send({ type: 'broadcast', method: 'thread-stream-state-changed', version: options.version ?? 11,
            sourceClientId: 'owner', params: { hostId: 'local', conversationId: threadId,
              change: { type: 'snapshot', revision: 3, conversationState: options.snapshot ? options.snapshot(updated) : state(options.status) } } });
        }
      }
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const settings = { socketPath, stateDirectory: join(directory, 'receipts'), timeoutMs: 200 };
  return { calls, settings, directory, run: createDispatcher(settings) };
}
const mutations = calls => calls.filter(call => /follower/.test(call.method));

test('fresh status reconstructs modern desktop history without dispatching', async t => {
  const f = await fixture(t, { status: 'interrupted' });
  const result = await f.run('status', { threadId });
  assert.equal(result.status, 'interrupted'); assert.equal(result.output, 'OK');
  assert.equal(mutations(f.calls).length, 0);
});

test('dispatch targets owner and inherits settings; retry after restart never resends', async t => {
  const f = await fixture(t);
  const result = await f.run('dispatch', command);
  assert.equal(result.accepted, true); assert.equal(result.completed, false);
  const call = mutations(f.calls)[0];
  assert.equal(call.version, 2); assert.equal(call.targetClientId, 'owner');
  assert.deepEqual(call.params.turnStart.context, { inheritThreadSettings: true });
  const restarted = createDispatcher(f.settings);
  assert.equal((await restarted('dispatch', command)).replayed, true);
  assert.equal(mutations(f.calls).length, 1);
  await assert.rejects(restarted('dispatch', { ...command, prompt: 'Different task' }), { code: 'REQUEST_ID_CONFLICT' });
});

test('busy target fails before submission and allows the same ID after preflight failure', async t => {
  const f = await fixture(t, { status: 'inProgress' });
  for (let i = 0; i < 2; i++) await assert.rejects(f.run('dispatch', command), { code: 'THREAD_NOT_IDLE' });
  assert.equal(mutations(f.calls).length, 0);
});

async function dispatchInProcess(settings, args) {
  const source = `import { createDispatcher } from ${JSON.stringify(new URL('../src/dispatch.js', import.meta.url).href)};
    try { console.log(JSON.stringify(await createDispatcher(${JSON.stringify(settings)})('dispatch', ${JSON.stringify(args)}))); }
    catch (error) { console.log(JSON.stringify({ code: error.code })); }`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Dispatch worker timed out')); }, 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Worker failed: ${errors}`)); });
  });
  return JSON.parse(output);
}

test('independent dispatchers and processes serialize a thread and recheck fresh state', async t => {
  let ready; const entered = new Promise(resolve => { ready = resolve; });
  let respond; let running = false;
  const f = await fixture(t, { snapshot: () => state(running ? 'inProgress' : 'completed'), onStart: reply => { respond = reply; ready(); } });
  const settings = { ...f.settings, timeoutMs: 3000 };
  const first = createDispatcher(settings)('dispatch', command);
  // Attach a rejection handler before testing contenders, so failures still clean up.
  first.catch(() => {});
  await entered;
  try {
    const second = { ...command, requestId: 'competing-command-0002' };
    await assert.rejects(createDispatcher(settings)('dispatch', second), { code: 'BUSY' });
    assert.equal((await dispatchInProcess(settings, second)).code, 'BUSY');
    assert.equal(mutations(f.calls).length, 1);
    running = true;
    respond({ result: { turn: { id: turnId } } });
    await first;
    // The failed contender's receipt is released; a retry gets a new snapshot,
    // which now reports busy instead of accidentally steering the first turn.
    assert.equal((await dispatchInProcess(settings, second)).code, 'THREAD_NOT_IDLE');
    assert.equal(mutations(f.calls).length, 1);
  } finally { respond({ result: { turn: { id: turnId } } }); await first; }
});

for (const option of ['dropMutation', 'silentMutation']) {
  test(`${option}: uncertain results survive restart and cannot be replayed`, async t => {
    const f = await fixture(t, { [option]: true });
    await assert.rejects(f.run('dispatch', command), { code: 'OUTCOME_UNKNOWN' });
    await assert.rejects(createDispatcher(f.settings)('dispatch', command), { code: 'OUTCOME_UNKNOWN' });
    assert.equal(mutations(f.calls).length, 1);
  });
}

test('wrong active turn cannot be steered or interrupted', async t => {
  const f = await fixture(t, { status: 'inProgress' });
  for (const operation of ['followup', 'stop']) {
    await assert.rejects(f.run(operation, { ...command, turnId: 'old-turn' }), { code: 'TURN_CHANGED' });
  }
  assert.equal(mutations(f.calls).length, 0);
});

test('followup steers and stop sends the expected turn guard', async t => {
  const f = await fixture(t, { status: 'inProgress' });
  await f.run('followup', { ...command, turnId });
  await f.run('stop', { ...command, requestId: 'request-0002', turnId });
  const [steer, stop] = mutations(f.calls);
  assert.equal(steer.method, 'thread-follower-steer-turn'); assert.equal(steer.version, 1);
  assert.deepEqual(steer.params.restoreMessage, { text: command.prompt, context: {} });
  assert.equal(stop.version, 4); assert.equal(stop.params.expectedTurnId, turnId);
});

test('a negative interrupt confirmation is never reported as accepted', async t => {
  const f = await fixture(t, { status: 'inProgress', rejectStop: true });
  await assert.rejects(f.run('stop', { ...command, turnId }), { code: 'OUTCOME_UNKNOWN' });
});

for (const [options, code] of [[{ version: 99 }, 'PROTOCOL_MISMATCH'], [{ badFrame: true }, 'INVALID_FRAME'], [{ noSnapshot: true }, 'SNAPSHOT_TIMEOUT']]) {
  test(`preflight ${code} sends no task`, async t => {
    const f = await fixture(t, options);
    await assert.rejects(f.run('dispatch', command), { code });
    assert.equal(mutations(f.calls).length, 0);
  });
}

test('cancellation stops waiting without sending a task', async t => {
  const f = await fixture(t, { noSnapshot: true });
  const controller = new AbortController();
  const pending = f.run('dispatch', command, { abort: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, { code: 'ABORTED' });
  assert.equal(mutations(f.calls).length, 0);
});

test('ordinary files are rejected as sockets', async t => {
  const f = await fixture(t);
  const path = join(f.directory, 'not-socket'); await writeFile(path, '');
  await assert.rejects(new Desktop({ socketPath: path }).connect(threadId), { code: 'UNSAFE_SOCKET' });
});

test('receipt claim is atomic, detects unsafe permissions and does not replay incomplete writes', async t => {
  const f = await fixture(t);
  const journal = new Journal(f.settings.stateDirectory);
  const claimed = await journal.claim('unique-id', 'fingerprint');
  await assert.rejects(journal.claim('unique-id', 'fingerprint'), { code: 'OUTCOME_UNKNOWN' });
  await writeFile(claimed.path, '{');
  await assert.rejects(journal.claim('unique-id', 'fingerprint'), { code: 'OUTCOME_UNKNOWN' });
  await chmod(f.settings.stateDirectory, 0o755);
  await assert.rejects(journal.prepare(), { code: 'UNSAFE_STATE_DIRECTORY' });
});

test('unknown history is not success and assistant output is bounded', () => {
  assert.equal(summarize({ state: state(), revision: 1 }, 'missing').status, 'unknown');
  const s = state(); s.turnHistory.history.entitiesByKey.tail.items[0].text = 'a'.repeat(20000);
  const result = summarize({ state: s, revision: 1 });
  assert.equal(result.output.length, 16000); assert.equal(result.outputTruncated, true);
});

test('plugin exposes serializable tool definitions and validates mutation input', async () => {
  const { tool } = await plugin();
  assert.equal(Object.keys(tool).length, 12);
  for (const definition of Object.values(tool)) {
    assert.equal(JSON.parse(JSON.stringify(definition.args)).type, 'object');
  }
  for (const name of ['codex_dispatch', 'codex_followup', 'codex_stop', 'codex_create_task', 'codex_handoff']) {
    await assert.rejects(tool[name].execute({ threadId: 'invalid' }), /INVALID_ARGUMENT/);
  }
});

test('plugin info and status report the loaded package version without starting work', async t => {
  const f = await fixture(t);
  const previous = process.env.MAGPIE_CODEX_SOCKET;
  let tool;
  try {
    process.env.MAGPIE_CODEX_SOCKET = f.settings.socketPath;
    ({ tool } = await plugin());
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CODEX_SOCKET;
    else process.env.MAGPIE_CODEX_SOCKET = previous;
  }
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const info = JSON.parse(await tool.codex_plugin_info.execute({}));
  assert.equal(info.name, metadata.name);
  assert.equal(info.pluginVersion, metadata.version);
  assert.equal(metadata.magpie.name, `${metadata.name} v${metadata.version}`);
  assert.ok(Number.isFinite(Date.parse(info.loadedAt)));
  assert.match(tool.codex_plugin_info.description, new RegExp(`v${metadata.version.replaceAll('.', '\\.')}`));
  assert.equal(f.calls.length, 0);
  const status = JSON.parse(await tool.codex_status.execute({ threadId }));
  assert.equal(status.pluginVersion, info.pluginVersion);
  assert.equal(mutations(f.calls).length, 0);
  assert.deepEqual(JSON.parse(await tool.codex_plugin_info.execute({})), info);
});

const fullPermissions = { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' }, activePermissionProfile: { id: ':danger-full-access' } };
const fullCommand = { ...command, permissionMode: 'full-access' };
function permissionSnapshot(updated) {
  return { ...state(), ...(updated ? { latestThreadSettings: fullPermissions } : {}) };
}
test('explicit full access is applied, freshly verified, and pinned to the actual turn', async t => {
  const f = await fixture(t, { snapshot: permissionSnapshot });
  const result = await f.run('dispatch', fullCommand);
  assert.equal(result.permissions.mode, 'full-access');
  const [update, start] = mutations(f.calls);
  assert.equal(update.method, 'thread-follower-update-thread-settings');
  assert.equal(update.version, 2);
  assert.deepEqual(update.params.threadSettings, { permissions: ':danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' });
  assert.equal(start.params.turnStart.request.permissions, ':danger-full-access');
  assert.equal(start.params.turnStart.request.approvalPolicy, 'never');
  const status = await f.run('status', { threadId });
  assert.equal(status.permissions.mode, 'ask-for-approval');
  assert.equal(status.nextTurnPermissions.mode, 'full-access');
  await assert.rejects(f.run('dispatch', { ...command, permissionMode: 'read-only' }), { code: 'REQUEST_ID_CONFLICT' });
  assert.equal((await createDispatcher(f.settings)('dispatch', fullCommand)).replayed, true);
  assert.equal(mutations(f.calls).length, 2);
});
test('default inheritance preserves full access and old receipt fingerprints', async t => {
  const f = await fixture(t, { snapshot: () => ({ ...state(), currentPermissions: fullPermissions }) });
  assert.equal((await f.run('dispatch', command)).permissions.mode, 'full-access');
  assert.equal(mutations(f.calls).length, 1);
  assert.equal(mutations(f.calls)[0].params.turnStart.request.permissions, undefined);
  assert.equal((await f.run('dispatch', { ...command, permissionMode: 'inherit' })).replayed, true);
});
test('settings acknowledgement without effective readback never starts a task', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 2; i++) await assert.rejects(f.run('dispatch', fullCommand), { code: 'PERMISSION_MISMATCH' });
  assert.ok(mutations(f.calls).every(c => c.method === 'thread-follower-update-thread-settings'));
});
test('a rejected permission update never falls back to sending the task', async t => {
  const f = await fixture(t, { rejectSettings: true });
  await assert.rejects(f.run('dispatch', fullCommand), { code: 'PERMISSION_UPDATE_UNCONFIRMED' });
  assert.equal(mutations(f.calls).length, 1);
});
test('permission-only operation is idle-only, verified, and starts no turn', async t => {
  const f = await fixture(t, { snapshot: permissionSnapshot });
  const request = { threadId, requestId: command.requestId, permissionMode: 'full-access' };
  assert.equal((await f.run('permissions', request)).completed, true);
  assert.equal((await createDispatcher(f.settings)('permissions', request)).replayed, true);
  assert.equal(mutations(f.calls).length, 1);
  const busy = await fixture(t, { status: 'inProgress' });
  await assert.rejects(busy.run('permissions', request), { code: 'THREAD_NOT_IDLE' });
  assert.equal(mutations(busy.calls).length, 0);
});
test('lost permission-only reply remains unknown across restart', async t => {
  const f = await fixture(t, { dropMutation: true });
  const request = { threadId, requestId: command.requestId, permissionMode: 'full-access' };
  await assert.rejects(f.run('permissions', request), { code: 'OUTCOME_UNKNOWN' });
  await assert.rejects(createDispatcher(f.settings)('permissions', request), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(mutations(f.calls).length, 1);
});
test('a thread becoming busy after settings update is not dispatched', async t => {
  const f = await fixture(t, { snapshot: updated => ({ ...permissionSnapshot(updated), ...(updated ? { threadRuntimeStatus: { type: 'active' } } : {}) }) });
  await assert.rejects(f.run('dispatch', fullCommand), { code: 'THREAD_NOT_IDLE' });
  assert.equal(mutations(f.calls).length, 1);
});
test('unknown effective permissions and conflicting mode arguments fail before dispatch', async t => {
  const f = await fixture(t, { snapshot: () => ({ ...state(), currentPermissions: {} }) });
  await assert.rejects(f.run('dispatch', command), { code: 'PERMISSION_MISMATCH' });
  await assert.rejects(f.run('dispatch', { ...fullCommand, sandbox: 'workspace-write' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.run('permissions', { ...command, permissionMode: 'inherit' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.run('followup', { ...fullCommand, turnId }), { code: 'INVALID_ARGUMENT' });
  assert.equal(mutations(f.calls).length, 0);
});
