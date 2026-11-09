import test from 'node:test';
import assert from 'node:assert/strict';
import { pinNewThread, pinnedSectionId } from '../src/pinning.js';

test('pin discovers the server section across pages, moves the exact thread, and verifies persistence', async () => {
  const calls = [];
  const client = { request: async (method, params) => {
    calls.push([method, params]);
    if (method === 'threadSection/list') return params.cursor ? { data: [{ id: pinnedSectionId }] } : { data: [], nextCursor: 'next' };
    if (method === 'thread/read') return { thread: { section: { id: pinnedSectionId } } };
    return {};
  } };
  assert.deepEqual(await pinNewThread(client, 'target'), { pinned: true, pinConfirmed: true });
  assert.deepEqual(calls[2], ['thread/section/move', { threadId: 'target', sectionId: pinnedSectionId }]);
});

test('missing section refuses mutation and failed readback never claims pin success', async () => {
  await assert.rejects(pinNewThread({ request: async method => {
    assert.equal(method, 'threadSection/list'); return { data: [] };
  } }, 'target'), { code: 'PIN_UNAVAILABLE' });
  await assert.rejects(pinNewThread({ request: async method => {
    if (method === 'threadSection/list') return { data: [{ id: pinnedSectionId }] };
    return { thread: {} };
  } }, 'target'), { code: 'PIN_UNCONFIRMED' });
});
