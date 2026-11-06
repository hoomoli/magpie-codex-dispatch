// Isolated acceptance against the installed Codex AppServer. No model turn or user thread is used.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServer, withServer } from '../src/rpc.js';
import { createLifecycle } from '../src/lifecycle.js';
import { randomUUID } from 'node:crypto';
const root = await mkdtemp(join(tmpdir(), 'mcd-lifecycle-acceptance-'));
const previousHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = root;
const owner = new AppServer({ execution: true });
try {
  await owner.start({ cwd: root });
  const { thread } = await owner.request('thread/start', { cwd: root, ephemeral: false });
  await owner.request('thread/name/set', { threadId: thread.id, name: 'Isolated lifecycle acceptance' });
  await assert.rejects(withServer({ lifecycle: true }, c => c.request('thread/archive', { threadId: thread.id })),
    { code: 'THREAD_IN_USE', rpcMethod: 'thread/archive', rpcCode: -32600 });
  await assert.rejects(withServer({ lifecycle: true }, c => c.request('thread/delete', { threadId: thread.id })),
    { code: 'UNSUPPORTED_METHOD' });
  await withServer({}, async client => {
    assert.equal((await client.request('thread/unsubscribe', { threadId: thread.id })).status, 'notLoaded');
  });
  assert.ok((await owner.request('thread/loaded/list')).data.includes(thread.id));
  const run = createLifecycle({ stateDirectory: join(root, 'receipts'), inspect: async id => {
    // This substitutes only the desktop snapshot transport, not the lifecycle RPC or writer check.
    const { thread: current } = await owner.request('thread/read', { threadId: id, includeTurns: true });
    return { owner: 'desktop', runtimeStatus: current.status.type, turnFound: current.turns.length > 0,
      status: current.turns.at(-1)?.status ?? 'unknown', pendingRequests: 0 };
  } });
  const args = { threadId: thread.id, requestId: 'isolated-archive-0001' };
  const waiting = await run('archive', args);
  assert.equal(waiting.phase, 'owner_action_required');
  assert.equal(waiting.completed, false);
  assert.equal(waiting.automaticRetry, false);
  assert.equal(waiting.heldThreads[0].reason, 'OWNER_ARCHIVE_REQUIRED');
  await owner.close();
  assert.equal((await run('archive', args)).phase, 'archived');
  await assert.rejects(run('delete', { threadId: thread.id, requestId: 'isolated-delete-0001' }), { code: 'UNSUPPORTED_OPERATION' });
  await withServer({}, async client => {
    for (const archived of [false, true]) {
      const page = await client.request('thread/list', { archived, limit: 100 });
      assert.equal(page.data.some(item => item.id === thread.id), archived);
    }
    assert.equal((await client.request('thread/read', { threadId: thread.id, includeTurns: false })).thread.id, thread.id);
    await assert.rejects(client.request('thread/read', { threadId: randomUUID(), includeTurns: false }),
      { code: 'THREAD_UNAVAILABLE', rpcMethod: 'thread/read', rpcCode: -32600 });
  });
  console.log('PASS: held archive requires owner action without submission; external unsubscribe cannot release owner; same request archives after unload; permanent deletion is disabled.');
} finally {
  await owner.close();
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
}
