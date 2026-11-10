import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLifecycle } from '../src/lifecycle.js';
import { rpcRejection } from '../src/rpc.js';
import { createFlows } from '../src/flows.js';
import { Operations } from '../src/operations.js';
const threadId = '01900000-0000-7000-8000-000000000001';
const childId = '01900000-0000-7000-8000-000000000002';
async function fixture(t, options = {}) {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'mcd-lifecycle-'));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const calls = [];
  const server = async (config, fn) => fn({ request: async (method, params) => {
    calls.push([method, params]);
    if (options.rejectRead && method === 'thread/read') throw rpcRejection(method, params, { code: -32600, message: `thread not loaded: ${params.threadId}` });
    if (method === 'thread/read') return { thread: { id: threadId, ephemeral: false, ...(options.turns ? { turns: options.turns } : {}) } };
    if (method === 'thread/list') return { data: params.archived ? [] : [{ id: childId }], nextCursor: null };
    if (options.lost) throw new Error('lost reply');
    config.onNotification({ method: method === 'thread/archive' ? 'thread/archived' : 'thread/deleted', params: { threadId } });
    return {};
  } });
  return { calls, stateDirectory, run: createLifecycle({ stateDirectory, server, writers: options.writers ?? (async () => []), inspect: options.inspect ?? (async () => { throw Error('unknown owner'); }) }) };
}
test('automatic archive checks the reviewed turn again under lifecycle locks', async t => {
  for (const turn of [{ id: 'reviewed', status: 'completed' }, { id: 'newer', status: 'completed' }, { id: 'reviewed', status: 'failed' }]) {
    const f = await fixture(t, { turns: [turn] });
    const args = { threadId, requestId: 'guarded-archive-001', expectedTurnId: 'reviewed' };
    if (turn.id === 'reviewed' && turn.status === 'completed') {
      assert.equal((await f.run('archive', args)).phase, 'archived');
      assert.equal((await f.run('archive', args)).replayed, true);
      await assert.rejects(f.run('archive', { ...args, expectedTurnId: 'another' }), { code: 'REQUEST_ID_CONFLICT' });
    } else {
      await assert.rejects(f.run('archive', args), { code: 'TURN_CHANGED' });
      assert.equal(f.calls.some(([method]) => method === 'thread/archive'), false);
    }
  }
});

test('automatic archival refuses a legacy owner that would ignore the exact-turn guard', async t => {
  const f = await fixture(t);
  let submitted = false;
  const run = createLifecycle({ stateDirectory: f.stateDirectory,
    server: async (_config, read) => read({ request: async method => method === 'thread/list' ? { data: [] }
      : { thread: { id: threadId, ephemeral: false, turns: [{ id: 'reviewed', status: 'completed' }] } } }),
    writers: async () => [123], inspect: async () => ({ owner: 'background', runtimeStatus: 'idle', status: 'completed', pendingRequests: 0 }),
    findOwner: async () => ({ capabilities: {} }), ownerRequest: async () => { submitted = true; },
  });
  await assert.rejects(run('archive', { threadId, requestId: 'old-owner-guard-001', expectedTurnId: 'reviewed' }), { code: 'OWNER_UPGRADE_REQUIRED' });
  assert.equal(submitted, false);
});
for (const operation of ['archive']) {
  test(`${operation}: sends once, persists receipt, exposes operation status and rejects conflicting IDs`, async t => {
    const f = await fixture(t);
    const args = { threadId, requestId: 'lifecycle-test-0001' };
    const result = await f.run(operation, args);
    assert.equal(result.completed, true);
    assert.deepEqual(result.affectedThreadIds, [threadId]);
    assert.equal(result.serverAcknowledged, true);
    assert.equal((await f.run(operation, args)).replayed, true);
    assert.equal(f.calls.filter(([m]) => m === `thread/${operation}`).length, 1);
    const status = await createFlows({ stateDirectory: f.stateDirectory })('operation_status', { requestId: args.requestId });
    assert.equal(status.phase, operation === 'archive' ? 'archived' : 'deleted');
    assert.equal(status.fingerprint, undefined);
    await assert.rejects(f.run(operation, { ...args, threadId: childId }), { code: 'REQUEST_ID_CONFLICT' });
  });
  test(`${operation}: waits for an unconfirmed writer on root or descendant`, async t => {
    for (const held of [threadId, childId]) {
      const f = await fixture(t, { writers: async id => id === held ? [123] : [] });
      const result = await f.run(operation, { threadId, requestId: 'busy-test-0001' });
      assert.equal(result.phase, 'owner_action_required');
      assert.equal(result.completed, false);
      assert.equal(result.submitted, false);
      assert.equal(result.heldThreads[0].reason, 'OWNERSHIP_UNCONFIRMED');
      assert.equal(f.calls.some(([m]) => m === `thread/${operation}`), false);
    }
  });
  test(`${operation}: lost reply never resends even after restart`, async t => {
    const f = await fixture(t, { lost: true });
    const args = { threadId, requestId: 'lost-test-0001' };
    await assert.rejects(f.run(operation, args), { code: 'OUTCOME_UNKNOWN' });
    const replay = await createLifecycle({ stateDirectory: f.stateDirectory, server: async () => { throw Error('must not connect'); } })(operation, args);
    assert.equal(replay.phase, 'outcome_unknown');
    assert.equal(replay.completed, false);
    assert.equal(f.calls.filter(([m]) => m === `thread/${operation}`).length, 1);
  });
}
test('lifecycle validation happens before contacting Codex', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run('archive', { threadId: '../../bad', requestId: 'valid-id-0001' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(f.calls.length, 0);
});
for (const operation of ['archive']) {
  test(`${operation}: idle desktop owner waits without sending; the same ID progresses after unload`, async t => {
    let held = true;
    const f = await fixture(t, { writers: async id => held && id === threadId ? [123] : [],
      inspect: async () => ({ owner: 'desktop', runtimeStatus: 'idle', status: 'completed', turnFound: true, pendingRequests: 0 }) });
    const args = { threadId, requestId: 'idle-desktop-0001' };
    const waiting = await f.run(operation, args);
    assert.equal(waiting.heldThreads[0].reason, 'OWNER_ARCHIVE_REQUIRED');
    assert.equal(waiting.phase, 'owner_action_required');
    assert.equal(waiting.completed, false);
    assert.equal(waiting.automaticRetry, false);
    assert.equal(waiting.retryAfterMs, undefined);
    assert.equal(f.calls.some(([m]) => m === `thread/${operation}`), false);
    const status = await createFlows({ stateDirectory: f.stateDirectory })('operation_status', { requestId: args.requestId });
    assert.equal(status.phase, 'owner_action_required');
    held = false;
    assert.equal((await f.run(operation, args)).completed, true);
    assert.equal(f.calls.filter(([m]) => m === `thread/${operation}`).length, 1);
  });
  test(`${operation}: refuses active roots, active descendants and pending approvals even when last turn completed`, async t => {
    for (const [held, snapshot] of [
      [threadId, { runtimeStatus: 'active', status: 'completed', pendingRequests: 0 }],
      [childId, { runtimeStatus: 'idle', status: 'inProgress', pendingRequests: 0 }],
      [threadId, { runtimeStatus: 'idle', status: 'completed', pendingRequests: 1 }],
    ]) {
      const f = await fixture(t, { writers: async id => id === held ? [123] : [], inspect: async () => ({ owner: 'desktop', ...snapshot }) });
      const args = { threadId, requestId: 'active-test-0001' };
      await assert.rejects(f.run(operation, args), { code: 'THREAD_ACTIVE' });
      assert.equal(f.calls.some(([m]) => m === `thread/${operation}`), false);
      const status = await createFlows({ stateDirectory: f.stateDirectory })('operation_status', { requestId: args.requestId });
      assert.equal(status.phase, 'preflight_failed');
      assert.equal(status.blockingThreadId, held);
      assert.equal(status.submitted, false);
    }
  });
}
test('unreadable target retains a stage-specific receipt, never claims archival or sends a mutation', async t => {
  const f = await fixture(t, { rejectRead: true });
  const args = { threadId, requestId: 'unavailable-test-0001' };
  for (let i = 0; i < 2; i++) await assert.rejects(f.run('archive', args), { code: 'THREAD_UNAVAILABLE' });
  const status = await createFlows({ stateDirectory: f.stateDirectory })('operation_status', { requestId: args.requestId });
  assert.equal(status.stage, 'read_target');
  assert.equal(status.rpcMethod, 'thread/read');
  assert.equal(status.rpcCode, -32600);
  assert.equal(status.errorCode, 'THREAD_UNAVAILABLE');
  assert.equal(status.completed, false);
  assert.equal(status.submitted, false);
  assert.equal(f.calls.some(([m]) => m === 'thread/archive'), false);
});
test('permanent deletion is refused before connection while legacy deletion receipts stay readable', async t => {
  const f = await fixture(t);
  const requestId = 'legacy-delete-receipt-01';
  await new Operations(f.stateDirectory).save(requestId, { operation: 'delete', requestId, threadId,
    fingerprint: 'historical-fingerprint', phase: 'deleted', completed: true, serverAcknowledged: true, reason: 'Use the old shared desktop lifecycle setup.' });
  const status = await createFlows({ stateDirectory: f.stateDirectory })('operation_status', { requestId });
  assert.equal(status.phase, 'deleted'); assert.equal(status.fingerprint, undefined);
  assert.equal(status.retired, true); assert.equal(status.automaticRetry, false);
  assert.doesNotMatch(status.reason, /shared|setup/); assert.match(status.reason, /do not retry/);
  await assert.rejects(f.run('delete', { threadId, requestId }), { code: 'UNSUPPORTED_OPERATION' });
  assert.equal(f.calls.length, 0);
});
test('old archive waiting receipts no longer recommend a timed retry loop', async t => {
  const f = await fixture(t), requestId = 'old-archive-wait-01';
  await new Operations(f.stateDirectory).save(requestId, { operation: 'archive', requestId, threadId,
    fingerprint: 'historical-fingerprint', phase: 'waiting_writer_release', completed: false, retryAfterMs: 5000, reason: 'Use the old shared desktop lifecycle setup.' });
  const status = await createFlows({ stateDirectory: f.stateDirectory })('operation_status', { requestId });
  assert.equal(status.phase, 'owner_action_required'); assert.equal(status.legacyPhase, 'waiting_writer_release');
  assert.equal(status.automaticRetry, false); assert.equal(status.retryAfterMs, undefined);
  assert.doesNotMatch(status.reason, /shared|setup/);
  assert.equal(f.calls.length, 0);
});
