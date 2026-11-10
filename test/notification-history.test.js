import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalNotificationState } from '../src/notification-history.js';
import { storedStatus } from '../src/stored-status.js';
const threadId = '00000000-0000-4000-8000-000000000011', turnId = 'exact-turn';
const terminal = { threadId, turnId, status: 'completed', turnFound: true };

test('terminal background receipt wins without querying a retained writer or stored history', async () => {
  const result = await terminalNotificationState('/private', threadId, turnId, {
    background: async (root, thread, turn) => { assert.equal(root, '/private'); assert.equal(thread, threadId); assert.equal(turn, turnId); return terminal; },
    writers: async () => { throw Error('Must not inspect the writer'); }, stored: async () => { throw Error('Must not query history'); },
  });
  assert.equal(result, terminal);
});

test('a held writer prevents persisted history from fabricating interruption', async () => {
  const result = await terminalNotificationState('/private', threadId, turnId, {
    background: async () => null, writers: async () => [123], stored: async () => { throw Error('Must not read held history'); },
  });
  assert.equal(result, null);
});

test('writerless recovery requires an exact, present terminal turn', async () => {
  for (const status of ['completed', 'failed', 'interrupted', 'unknown']) {
    for (const correct of [true, false]) {
      const value = { ...terminal, status, turnId: correct ? turnId : 'another-turn' };
      const result = await terminalNotificationState('/private', threadId, turnId, {
        background: async () => null, writers: async () => [], stored: async args => { assert.deepEqual(args, { threadId, turnId }); return value; },
      });
      assert.equal(result, correct && status !== 'unknown' ? value : null);
    }
  }
  assert.equal(await terminalNotificationState('/private', threadId, turnId, {
    background: async () => null, writers: async () => [], stored: async () => ({ ...terminal, turnFound: false }),
  }), null);
});

test('a writer attaching during persisted recovery keeps completion unresolved', async () => {
  let reads = 0;
  const writers = async () => ++reads === 1 ? [] : [456];
  const server = async (_, run) => run({ request: async method => method === 'thread/read'
    ? { thread: { id: threadId, ephemeral: false } } : { data: [{ id: turnId, status: 'completed', items: [] }] } });
  await assert.rejects(terminalNotificationState('/private', threadId, turnId, {
    background: async () => null, writers, stored: (args, options) => storedStatus(args, { ...options, server }),
  }), { code: 'WRITER_CHANGED' });
  assert.equal(reads, 2);
});
