import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLifecycle } from '../src/lifecycle.js';
import { createFlows } from '../src/flows.js';
const threadId = '01900000-0000-7000-8000-000000000001';
const childId = '01900000-0000-7000-8000-000000000002';
async function fixture(t, options = {}) {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'mcd-lifecycle-'));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const calls = [];
  const server = async (config, fn) => fn({ request: async (method, params) => {
    calls.push([method, params]);
    if (method === 'thread/read') return { thread: { id: threadId, ephemeral: false } };
    if (method === 'thread/list') return { data: params.archived ? [] : [{ id: childId }], nextCursor: null };
    if (options.lost) throw new Error('lost reply');
    config.onNotification({ method: method === 'thread/archive' ? 'thread/archived' : 'thread/deleted', params: { threadId } });
    return {};
  } });
  return { calls, stateDirectory, run: createLifecycle({ stateDirectory, server, writers: options.writers ?? (async () => []) }) };
}
for (const operation of ['archive', 'delete']) {
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
  test(`${operation}: refuses a writer on root or descendant`, async t => {
    for (const held of [threadId, childId]) {
      const f = await fixture(t, { writers: async id => id === held ? [123] : [] });
      await assert.rejects(f.run(operation, { threadId, requestId: 'busy-test-0001' }), { code: 'THREAD_IN_USE' });
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
  await assert.rejects(f.run('delete', { threadId: '../../bad', requestId: 'valid-id-0001' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(f.calls.length, 0);
});
