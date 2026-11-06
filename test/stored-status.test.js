import test from 'node:test';
import assert from 'node:assert/strict';
import { storedStatus } from '../src/stored-status.js';
import { createDispatcher } from '../src/dispatch.js';
const threadId = '01900000-0000-7000-8000-000000000001';
function fixture({ pages = [{ data: [{ id: 'latest', status: 'completed', items: [{ type: 'agentMessage', text: 'OK' }] }], nextCursor: null }], writers = async () => [] } = {}) {
  const calls = []; let index = 0;
  const server = async (_options, fn) => fn({ request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: threadId, ephemeral: false } };
    return pages[index++];
  } });
  return { calls, read: args => storedStatus({ threadId, ...args }, { server, writers }) };
}
test('unloaded status reads latest persisted output without connecting to desktop or loading the thread', async () => {
  const f = fixture();
  const run = createDispatcher({ writers: async () => [], readStored: f.read,
    desktopFactory: () => { throw Error('must not connect to desktop'); } });
  const result = await run('status', { threadId });
  assert.equal(result.runtimeStatus, 'notLoaded');
  assert.equal(result.historyOnly, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'OK');
  assert.equal(result.pendingRequests, null);
  assert.deepEqual(f.calls.map(c => c.method), ['thread/read', 'thread/turns/list']);
});
test('requested old turn paginates and returns exact history; missing turn is unknown', async () => {
  const f = fixture({ pages: [{ data: [{ id: 'other' }], nextCursor: 'older' },
    { data: [{ id: 'wanted', status: 'failed', items: [] }], nextCursor: null }] });
  const result = await f.read({ turnId: 'wanted' });
  assert.equal(result.turnId, 'wanted'); assert.equal(result.status, 'failed');
  assert.equal(f.calls[2].params.cursor, 'older');
  const missing = await fixture().read({ turnId: 'absent' });
  assert.equal(missing.status, 'unknown'); assert.equal(missing.turnFound, false);
});
test('persisted in-progress and empty history never claim a live active or completed turn', async () => {
  const result = await fixture({ pages: [{ data: [{ id: 'stale', status: 'inProgress', items: [] }] }] }).read({});
  assert.equal(result.status, 'unknown'); assert.equal(result.recordedStatus, 'inProgress');
  assert.equal(result.runtimeStatus, 'notLoaded');
  const empty = await fixture({ pages: [{ data: [] }] }).read({});
  assert.equal(empty.status, 'unknown'); assert.equal(empty.turnFound, false);
});
test('history is bounded, output is capped, and a writer attaching during the read forces live lookup', async () => {
  const f = fixture({ writers: async () => [123] });
  await assert.rejects(f.read({}), { code: 'WRITER_CHANGED' });
  const pages = Array.from({ length: 10 }, (_, i) => ({ data: [], nextCursor: `page-${i}` }));
  assert.equal((await fixture({ pages }).read({ turnId: 'absent' })).historyTruncated, true);
  const long = await fixture({ pages: [{ data: [{ id: 'long', status: 'completed', items: [{ type: 'agentMessage', text: 'x'.repeat(17000) }] }] }] }).read({});
  assert.equal(long.output.length, 16000); assert.equal(long.outputTruncated, true);
  let connected = false;
  const run = createDispatcher({ writers: async () => [], readStored: fixture({ writers: async () => [123] }).read, desktopFactory: () => ({
    connect: async () => { connected = true; throw Object.assign(Error('live lookup attempted'), { code: 'NO_OWNER' }); }, close() {} }) });
  await assert.rejects(run('status', { threadId }), { code: 'NO_OWNER' });
  assert.equal(connected, true);
});
test('unavailable persisted history propagates; no stale completion receipt is substituted', async () => {
  const run = createDispatcher({ writers: async () => [], readStored: async () => { throw Object.assign(Error('unavailable'), { code: 'THREAD_UNAVAILABLE' }); },
    desktopFactory: () => { throw Error('must not connect'); } });
  await assert.rejects(run('status', { threadId }), { code: 'THREAD_UNAVAILABLE' });
});
