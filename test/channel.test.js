import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ChannelStore, hash } from '../src/channel-store.js';
import { CompletionMonitor } from '../src/channel-monitor.js';
import { Desktop } from '../src/desktop.js';

const threadId = '00000000-0000-4000-8000-000000000001';
const turnId = 'turn-1';
async function fixture(t) {
  const dir = await mkdtemp('/tmp/mcd-queue-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ChannelStore(dir); await store.init();
  const key = await store.register('codex_dispatch', { requestId: 'channel-request-1', prompt: 'secret prompt' });
  await store.accept(key, { accepted: true, threadId, turnId });
  return { dir, store, key };
}
const result = (status = 'completed') => ({ threadId, turnId, status, hasError: status === 'failed' });
const snapshot = (status = 'completed', id = turnId) => ({ revision: 1, state: { id: threadId, turns: [{ turnId: id, status }] } });

test('queue survives restart, excludes prompts/output, deduplicates completion, requires explicit review', async t => {
  const { dir, store, key } = await fixture(t);
  assert.equal(await store.complete(key, result('inProgress')), false);
  assert.equal(await store.complete(key, { ...result(), turnId: 'another' }), false);
  assert.equal(await store.complete(key, result()), true);
  assert.equal(await store.complete(key, result()), false);
  const recovered = new ChannelStore(dir); await recovered.init();
  assert.equal(recovered.pending().length, 1);
  assert.ok(!(await readFile(join(dir, 'queue.json'), 'utf8')).includes('secret prompt'));
  const event = recovered.pending()[0].event;
  await assert.rejects(recovered.review('unknown', 'passed', 'checked'), /belong/);
  await recovered.review(event.eventId, 'passed', 'Checked changes and tests.');
  assert.equal(recovered.pending().length, 0);
  await recovered.review(event.eventId, 'passed', 'Checked changes and tests.');
  await assert.rejects(recovered.review(event.eventId, 'passed', 'different'), /different/);
});

test('bindings cannot change and concurrent queue updates are retained', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.register('codex_dispatch', { requestId: 'channel-request-1', prompt: 'changed' }), /CONFLICT/);
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.register('codex_dispatch', { requestId: `request-${i}`, prompt: 'a' })));
  assert.equal(Object.keys(store.data.tasks).length, 11);
});

test('invalid follow-up cannot poison a request ID before a corrected retry', async t => {
  const { store } = await fixture(t);
  const args = { requestId: 'followup-invalid-1', threadId, prompt: 'Cancel item 5.' };
  assert.throws(() => store.register('codex_followup', args), /turnId is required/);
  assert.equal(store.data.tasks[hash(args.requestId)], undefined);
  const key = await store.register('codex_followup', { ...args, turnId });
  await store.accept(key, { accepted: true, threadId, turnId });
  assert.equal(store.data.tasks[key].turnId, turnId);
});

test('legacy missing-turn follow-up binding can be repaired without weakening request identity', async t => {
  const { dir, store } = await fixture(t);
  const args = { requestId: 'followup-legacy-1', threadId, prompt: 'Cancel item 5.' };
  const key = hash(args.requestId);
  const fingerprint = hash(JSON.stringify(['codex_followup', Object.keys(args).sort().map(k => [k, args[k]])]));
  await store.change(data => { data.tasks[key] = { key, name: 'codex_followup', requestId: args.requestId, fingerprint }; });
  const recovered = new ChannelStore(dir); await recovered.init();
  await assert.rejects(recovered.register('codex_followup', { ...args, turnId, prompt: 'Changed prompt' }), /CONFLICT/);
  await assert.rejects(recovered.register('codex_followup', { ...args, turnId, threadId: '00000000-0000-4000-8000-000000000002' }), /CONFLICT/);
  assert.equal(await recovered.register('codex_followup', { ...args, turnId }), key);
  assert.equal(await recovered.register('codex_followup', { ...args, turnId }), key);
  await assert.rejects(recovered.register('codex_followup', { ...args, turnId: 'different' }), /CONFLICT/);
  await recovered.accept(key, { accepted: true, threadId, turnId });
  await assert.rejects(recovered.register('codex_followup', { ...args, turnId: 'different' }), /CONFLICT/);
});

for (const status of ['completed','failed','interrupted']) test(`monitor reacts to ${status} without polling and ignores other turns`, async t => {
  const { store, key } = await fixture(t);
  let hooks, connections = 0, events = 0;
  const monitor = new CompletionMonitor({ store, onEvent: () => events++, desktopFactory: options => {
    hooks = options; return { async connect() { connections++; }, close() {} };
  } });
  t.after(() => monitor.close()); monitor.refresh();
  hooks.onState(snapshot(status, 'different'));
  assert.equal(store.pending().length, 0);
  hooks.onState(snapshot('inProgress')); hooks.onState(snapshot(status)); hooks.onState(snapshot(status));
  await store.queue; await new Promise(r => setImmediate(r));
  assert.equal(store.data.tasks[key].event.status, status);
  assert.equal(events, 1); assert.equal(connections, 1);
});

test('monitor reconnects after disconnect and recovers a completed snapshot', async t => {
  const { store } = await fixture(t);
  let count = 0;
  const monitor = new CompletionMonitor({ store, retryMs: 5, desktopFactory: hooks => ({
    async connect() { if (++count === 1) hooks.onDisconnect({ code: 'DISCONNECTED' }); else hooks.onState(snapshot()); }, close() {},
  }) });
  t.after(() => monitor.close()); monitor.refresh();
  for (let n = 0; n < 40 && !store.pending().length; n++) await new Promise(r => setTimeout(r, 5));
  assert.equal(count, 2); assert.equal(store.pending().length, 1);
});

test('desktop applies ordered patches and rejects revision gaps, wrong owners and unsafe paths', () => {
  const updates = [], errors = [];
  const desktop = new Desktop({ onState: state => updates.push(state), onDisconnect: e => errors.push(e.code) });
  desktop.owner = 'owner'; desktop.threadId = threadId;
  const push = (change, sourceClientId = 'owner') => desktop.message({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId,
    params: { hostId: 'local', conversationId: threadId, change } });
  push({ type: 'snapshot', conversationState: snapshot('inProgress').state, revision: 1 });
  push({ type: 'patches', baseRevision: 1, revision: 2, patches: [{ op: 'replace', path: ['turns',0,'status'], value: 'completed' }] }, 'other');
  assert.equal(updates.length, 1);
  push({ type: 'patches', baseRevision: 1, revision: 2, patches: [{ op: 'replace', path: ['turns',0,'status'], value: 'completed' }] });
  assert.equal(updates[1].state.turns[0].status, 'completed');
  push({ type: 'patches', baseRevision: 0, revision: 3, patches: [] });
  assert.deepEqual(errors, ['STREAM_GAP']);
  const unsafe = new Desktop({ onState() {}, onDisconnect: e => errors.push(e.code) });
  unsafe.owner = 'owner'; unsafe.threadId = threadId; unsafe.current = snapshot();
  unsafe.message({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'owner', params: { hostId: 'local', conversationId: threadId,
    change: { type: 'patches', baseRevision: 1, revision: 2, patches: [{ op: 'add', path: ['__proto__','polluted'], value: true }] } } });
  assert.equal({}.polluted, undefined); assert.equal(errors.at(-1), 'PROTOCOL_MISMATCH');
});
