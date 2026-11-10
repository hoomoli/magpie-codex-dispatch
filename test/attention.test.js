import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { attentionRequests, pendingTaskEvents } from '../src/attention.js';
import { ChannelStore } from '../src/channel-store.js';
import { CompletionMonitor } from '../src/channel-monitor.js';
import { summarize } from '../src/desktop.js';
import { runHook } from '../src/desktop-hook.js';
import { configuration } from '../src/install-desktop.js';

const threadId = '00000000-0000-4000-8000-000000000001', turnId = 'attention-turn';
const approval = { id: 3, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, reason: 'private reason', command: 'private command' } };
const snapshot = (requests = [approval], status = 'inProgress') => ({ revision: 1, state: {
  id: threadId, threadRuntimeStatus: { type: status === 'inProgress' ? 'active' : 'idle', activeFlags: [] },
  turns: [{ turnId, status, items: [] }], requests,
} });
async function fixture(t) {
  const dir = await mkdtemp('/tmp/mcd-attention-'); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ChannelStore(dir); await store.init();
  const key = await store.register('codex_dispatch', { requestId: 'attention-request', threadId, prompt: 'private task prompt' });
  await store.accept(key, { accepted: true, threadId, turnId });
  return { dir, store, key };
}

test('live status identifies approval/input, includes actionable details, and excludes unrelated turns', () => {
  const result = summarize(snapshot(), turnId);
  assert.equal(result.activity, 'waiting_on_approval');
  assert.equal(result.attentionRequests[0].command, 'private command');
  assert.deepEqual(attentionRequests(snapshot().state, 'other'), []);
  const request = { id: 'question', method: 'item/tool/requestUserInput', params: { turnId } };
  assert.equal(summarize(snapshot([request]), turnId).activity, 'waiting_on_input');
  assert.equal(summarize(snapshot([]), turnId).activity, 'running');
});

test('pending events survive restart without commands/prompts, clear on resolution, and never become reviews', async t => {
  const { dir, store, key } = await fixture(t);
  const result = summarize(snapshot(), turnId);
  assert.equal(await store.setAttention(key, result), true);
  const recovered = new ChannelStore(dir); await recovered.init();
  const event = pendingTaskEvents(Object.values(recovered.data.tasks))[0];
  assert.equal(pendingTaskEvents([{ attention: [event] }, { attention: [event] }]).length, 1);
  assert.equal(event.kind, 'attention'); assert.equal(event.status, 'waiting_on_approval');
  await assert.rejects(recovered.review(event.eventId, 'passed', 'Not a completed task'), /belong/);
  const text = await readFile(join(dir, 'queue.json'), 'utf8');
  for (const secret of ['private command', 'private reason', 'private task prompt']) assert.ok(!text.includes(secret));
  assert.equal(await recovered.setAttention(key, result), false);
  assert.equal(await recovered.setAttention(key, { ...result, turnId: 'wrong' }), false);
  assert.equal(await recovered.setAttention(key, summarize(snapshot([]), turnId)), true);
  assert.deepEqual(pendingTaskEvents(Object.values(recovered.data.tasks)), []);
  await recovered.setAttention(key, result);
  await recovered.complete(key, summarize(snapshot([], 'completed'), turnId));
  assert.deepEqual(recovered.data.tasks[key].attention, []);
  assert.equal(pendingTaskEvents(Object.values(recovered.data.tasks)).length, 1);
});

test('monitor emits attention once, keeps its subscription, clears requests and still reports completion', async t => {
  const { store, key } = await fixture(t); let hooks, events = 0, closed = 0;
  const monitor = new CompletionMonitor({ store, onEvent: () => events++, desktopFactory: options => {
    hooks = options; return { connect: async () => {}, close: () => closed++ };
  } });
  t.after(() => monitor.close()); monitor.refresh();
  hooks.onState(snapshot()); hooks.onState(snapshot());
  await store.queue; await new Promise(r => setImmediate(r));
  assert.equal(events, 1); assert.equal(closed, 0); assert.equal(store.data.tasks[key].event, undefined);
  hooks.onState(snapshot([])); await store.queue;
  assert.deepEqual(store.data.tasks[key].attention, []);
  hooks.onState(snapshot([], 'completed')); await store.queue; await new Promise(r => setImmediate(r));
  assert.equal(store.data.tasks[key].event.status, 'completed'); assert.equal(closed, 1);
});

test('attention hook wakes without claiming completion and notification diagnostics rearm monitoring', async () => {
  const input = { session_id: 'session', hook_event_name: 'SessionStart' };
  const request = async (_, method) => method === 'hook_resume' ? { keys: ['key'] } : { events: [{ kind: 'attention', eventId: 'request-1', threadId, turnId }] };
  const result = await runHook(input, request);
  assert.equal(result.code, 2); assert.match(result.text, /NOT task completion/);
  assert.match(result.text, /Never approve/); assert.match(result.text, /rearm/);
  const calls = [];
  await runHook({ ...input, hook_event_name: 'PostToolUse', tool_name: 'mcp__codex-notifications__codex_notification_status' }, async (_, method) => {
    calls.push(method); return method === 'hook_resume' ? { keys: ['key'] } : { events: [] };
  });
  assert.deepEqual(calls, ['hook_resume', 'hook_watch']);
  const config = configuration({}, {}, '/plugin/src');
  assert.ok(new RegExp(config.settings.hooks.PostToolUse[0].matcher).test('mcp__codex-notifications__codex_notification_status'));
});
