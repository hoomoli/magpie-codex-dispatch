import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runHook, dispatchName, acceptedReceipt, watchNotifications } from '../src/desktop-hook.js';
import { configuration, install } from '../src/install-desktop.js';
import { hash } from '../src/channel-store.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const base = { session_id: '00000000-0000-4000-8000-000000000001', tool_name: 'mcp__magpie__magpie-codex-dispatch_codex_dispatch', tool_input: { requestId: 'desktop-test-001', threadId: 'thread-1', prompt: 'OK' } };
const receipt = { accepted: true, requestId: base.tool_input.requestId, threadId: 'thread-1', turnId: 'turn-1' };
test('only Magpie task dispatch tools match; CLI channel and unrelated servers do not', () => {
  assert.equal(dispatchName(base.tool_name), 'codex_dispatch');
  assert.equal(dispatchName('mcp__magpie__magpie-codex-dispatch_codex_create_task'), 'codex_create_task');
  for (const name of ['mcp__codex-completion__codex_dispatch', 'mcp__other__codex_dispatch', 'mcp__magpie__codex_status', null]) assert.equal(dispatchName(name), null);
});
test('MCP nested receipt decoding rejects errors, ambiguity and non-acceptance', () => {
  assert.deepEqual(acceptedReceipt({ content: [{ type: 'text', text: JSON.stringify(receipt) }] }), receipt);
  assert.equal(acceptedReceipt({ isError: true, content: [{ text: JSON.stringify(receipt) }] }), null);
  assert.equal(acceptedReceipt([receipt, receipt]), null);
  assert.equal(acceptedReceipt({ accepted: false }), null);
});
test('PreToolUse binds session before dispatch without waiting for completion', async () => {
  const calls = [];
  const result = await runHook({ ...base, hook_event_name: 'PreToolUse' }, async (...args) => { calls.push(args); return { key: 'key' }; });
  assert.equal(result.code, 0); assert.match(result.json.hookSpecificOutput.additionalContext, /Do not poll/);
  assert.deepEqual(calls.map(c => c[1]), ['hook_register']); assert.equal(calls[0][0], base.session_id);
});

test('follow-up validates before binding and repairs an exact legacy binding on a live old worker', async () => {
  const input = { ...base, hook_event_name: 'PreToolUse', tool_name: 'mcp__magpie__codex_followup',
    tool_input: { ...base.tool_input, threadId: base.session_id, turnId: 'turn-1' } };
  const calls = [];
  const { turnId, ...missingTurn } = input.tool_input;
  const request = async (session, method, args) => {
    calls.push([method, args]);
    if (method === 'status') return { tasks: [{ requestId: input.tool_input.requestId, state: 'awaiting_receipt' }] };
    if (args.input.turnId) throw new Error('REQUEST_ID_CONFLICT: notification binding differs.');
    assert.deepEqual(args.input, missingTurn);
    return { key: 'legacy' };
  };
  assert.equal((await runHook(input, request)).code, 0);
  assert.deepEqual(calls.map(c => c[0]), ['hook_register', 'status', 'hook_register']);
  calls.length = 0;
  await assert.rejects(runHook({ ...input, tool_input: missingTurn }, request), /turnId is required/);
  assert.equal(calls.length, 0);
  await assert.rejects(runHook(input, async (session, method) => {
    if (method === 'status') return { tasks: [{ requestId: input.tool_input.requestId, state: 'watching' }] };
    throw new Error('REQUEST_ID_CONFLICT: notification binding differs.');
  }), /CONFLICT/);
});

test('native hook reports a missing turn as invalid arguments rather than a broken notification service', () => {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../src/desktop-hook.js', import.meta.url))], {
    input: JSON.stringify({ ...base, hook_event_name: 'PreToolUse', tool_name: 'mcp__magpie__codex_followup',
      tool_input: { ...base.tool_input, threadId: base.session_id } }), encoding: 'utf8', timeout: 5000,
  });
  assert.equal(child.status, 0);
  const output = JSON.parse(child.stdout).hookSpecificOutput;
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason, /turnId is required/);
  assert.doesNotMatch(output.permissionDecisionReason, /binding failed/);
});
test('PostToolUse binds accepted exact turn and returns native idle wake exit code', async () => {
  const calls = [], event = { eventId: 'event-1', threadId: 'thread-1', turnId: 'turn-1', status: 'failed' };
  const result = await runHook({ ...base, hook_event_name: 'PostToolUse', tool_response: { content: [{ text: JSON.stringify(receipt) }] } }, async (...args) => {
    calls.push(args); return args[1] === 'hook_watch' ? { events: [event] } : { key: 'key' };
  });
  assert.equal(result.code, 2); assert.match(result.text, /codex-notifications/); assert.match(result.text, /Do not resubmit/);
  assert.deepEqual(calls.map(c => c[1]), ['hook_register', 'hook_receipt', 'hook_watch']);
  assert.deepEqual(calls[1][2], { key: 'key', receipt });
  assert.equal(calls[2][3].timeoutMs, 23 * 60 * 60 * 1000);
});
test('unaccepted receipt does not wait; mismatched request and thread cannot bind', async () => {
  const calls = [], request = async (...args) => { calls.push(args); return { key: 'key' }; };
  assert.equal((await runHook({ ...base, hook_event_name: 'PostToolUse', tool_response: { pending: true } }, request)).code, 0);
  assert.equal(calls.length, 1);
  for (const wrong of [{ ...receipt, requestId: 'wrong' }, { ...receipt, threadId: 'wrong' }]) {
    await assert.rejects(runHook({ ...base, hook_event_name: 'PostToolUse', tool_response: wrong }, request), /did not match/);
  }
});
test('create flow hashed receipt and resume recovery use the same event delivery path', async () => {
  const calls = [], request = async (...args) => { calls.push(args); return { key: 'key', keys: ['key'], events: [] }; };
  const input = { ...base, tool_name: base.tool_name.replace('codex_dispatch', 'codex_create_task'), hook_event_name: 'PostToolUse', tool_response: { ...receipt, requestId: `flow_${hash(base.tool_input.requestId)}` } };
  assert.equal((await runHook(input, request)).code, 0);
  calls.length = 0;
  assert.equal((await runHook({ session_id: base.session_id, hook_event_name: 'SessionStart' }, request)).code, 0);
  assert.deepEqual(calls.map(c => c[1]), ['hook_resume', 'hook_watch']);
});
test('installer preserves unrelated settings and hooks, remains idempotent, and keeps permissions', () => {
  const settings = { permissions: { deny: ['Bash(rm *)'] }, hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'existing' }] }] } };
  const config = { mcpServers: { magpie: { url: 'http://localhost:1111/mcp' } }, projects: { '/example': { trusted: true } } };
  const next = configuration(settings, config, '/plugin/src', '/node');
  assert.deepEqual(configuration(next.settings, next.config, '/plugin/src', '/node'), next);
  assert.deepEqual(next.settings.permissions, settings.permissions);
  assert.deepEqual(next.config.mcpServers.magpie, config.mcpServers.magpie);
  assert.equal(next.settings.hooks.PostToolUse.length, 2);
  assert.equal(next.settings.hooks.PostToolUse[1].hooks[0].asyncRewake, true);
  assert.equal(next.settings.hooks.PreToolUse[0].hooks[0].onFailure, 'block');
  assert.equal(config.mcpServers['codex-notifications'], undefined);
  assert.throws(() => configuration({}, { mcpServers: { 'codex-notifications': { command: '/other' } } }, '/plugin/src'), /unrelated/);
});
test('review tool completion rearms recovery for remaining tasks without replaying announced events', async () => {
  const calls = [];
  const result = await runHook({ session_id: base.session_id, hook_event_name: 'PostToolUse', tool_name: 'mcp__codex-notifications__codex_review_complete' }, async (...args) => { calls.push(args); return { keys: ['remaining'], events: [] }; });
  assert.equal(result.code, 0);
  assert.deepEqual(calls.map(c => c[1]), ['hook_resume', 'hook_watch']);
  assert.deepEqual(calls[0][2], { replay: false });
});
test('installer writes private backups and does not duplicate registration', async t => {
  const home = await mkdtemp('/tmp/mcd-install-'); t.after(() => rm(home, { recursive: true, force: true }));
  const original = '{"existing":true}\n'; await writeFile(join(home, '.claude.json'), original);
  const first = await install(home, '/plugin/src'); assert.equal(first.backups.length, 1);
  assert.equal(await readFile(first.backups[0], 'utf8'), original);
  const second = await install(home, '/plugin/src'); assert.equal(second.backups.length, 0);
  assert.equal(JSON.parse(await readFile(join(home, '.claude.json'))).existing, true);
});


test('watch transport recovery rearms the same binding without registering or dispatching', async () => {
  const calls = []; let watches = 0;
  const event = { eventId: 'stable-event', threadId: 'thread-1', turnId: 'turn-1', status: 'completed' };
  const result = await watchNotifications(base.session_id, ['original-key'], async (session, method, args, options) => {
    assert.equal(session, base.session_id); calls.push([method, args, options]);
    if (method === 'hook_watch' && ++watches === 1) throw Object.assign(Error('transport lost'), { code: 'NOTIFICATION_DISCONNECTED' });
    return method === 'hook_watch' ? { events: [event] } : { keys: ['original-key'] };
  }, { delayMs: 0 });
  assert.deepEqual(result.events, [event]);
  assert.deepEqual(calls.map(c => c[0]), ['hook_watch', 'hook_resume', 'hook_watch']);
  assert.deepEqual(calls[0][1], calls[2][1]);
  assert.ok(calls[2][2].timeoutMs <= calls[0][2].timeoutMs);
});

test('logical watch errors and repeated transport loss terminate without resubmission', async () => {
  let calls = 0;
  await assert.rejects(watchNotifications(base.session_id, ['key'], async () => { calls++; throw Error('Invalid watch binding.'); }, { delayMs: 0 }));
  assert.equal(calls, 1);
  let watches = 0;
  await assert.rejects(watchNotifications(base.session_id, ['key'], async (_session, method) => {
    if (method === 'hook_watch') { watches++; throw Object.assign(Error('gone'), { code: 'NOTIFICATION_DISCONNECTED' }); }
    return { keys: ['key'] };
  }, { delayMs: 0, maxReconnects: 1 }), { code: 'NOTIFICATION_DISCONNECTED' });
  assert.equal(watches, 2);
});
