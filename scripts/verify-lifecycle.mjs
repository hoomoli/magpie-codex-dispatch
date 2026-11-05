// Isolated acceptance against the installed Codex AppServer. No model turn or user thread is used.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServer, withServer } from '../src/rpc.js';
import { createLifecycle } from '../src/lifecycle.js';
const root = await mkdtemp(join(tmpdir(), 'mcd-lifecycle-acceptance-'));
const previousHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = root;
const owner = new AppServer({ execution: true });
try {
  await owner.start({ cwd: root });
  const { thread } = await owner.request('thread/start', { cwd: root, ephemeral: false });
  await owner.request('thread/name/set', { threadId: thread.id, name: 'Isolated lifecycle acceptance' });
  // A second real server cannot mutate a thread held by the first, even while idle.
  await assert.rejects(withServer({ lifecycle: true }, c => c.request('thread/delete', { threadId: thread.id })),
    { code: 'THREAD_IN_USE', rpcMethod: 'thread/delete', rpcCode: -32600 });
  const run = createLifecycle({ stateDirectory: join(root, 'receipts'), inspect: async id => {
    // This substitutes only the desktop snapshot transport, not the lifecycle RPC or writer check.
    const { thread: current } = await owner.request('thread/read', { threadId: id, includeTurns: true });
    return { owner: 'desktop', runtimeStatus: current.status.type, turnFound: current.turns.length > 0,
      status: current.turns.at(-1)?.status ?? 'unknown', pendingRequests: 0 };
  } });
  const args = { threadId: thread.id, requestId: 'isolated-archive-0001' };
  const waiting = await run('archive', args);
  assert.equal(waiting.phase, 'waiting_writer_release');
  assert.equal(waiting.completed, false);
  assert.equal(waiting.heldThreads[0].reason, 'IDLE_OWNER_MUST_UNLOAD');
  await owner.close();
  assert.equal((await run('archive', args)).phase, 'archived');
  assert.equal((await run('delete', { threadId: thread.id, requestId: 'isolated-delete-0001' })).phase, 'deleted');
  await withServer({}, async client => {
    for (const archived of [false, true]) {
      const page = await client.request('thread/list', { archived, limit: 100 });
      assert.ok(!page.data.some(item => item.id === thread.id));
    }
    await assert.rejects(client.request('thread/read', { threadId: thread.id, includeTurns: false }),
      { code: 'THREAD_UNAVAILABLE', rpcMethod: 'thread/read', rpcCode: -32600 });
  });
  console.log('PASS: held idle writer waits; same request archives after unload; deletion and unavailable classification verified.');
} finally {
  await owner.close();
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
}
