import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { AppServer, withServer } from '../src/rpc.js';
import { BackgroundRuntime } from '../src/background-runtime.js';
import { createOwnerLifecycle } from '../src/owner-lifecycle.js';
import { createLifecycle } from '../src/lifecycle.js';
import { serveOwner, retainedOwner, readOwnerOutcome, reserveOwnerSlot } from '../src/owner-control.js';
import { writerPids } from '../src/ownership.js';

// Real isolated backend + real private control transport. No model turns or desktop fallback.
const root = await mkdtemp('/tmp/mcd-retained-check-');
const previousHome = process.env.CODEX_HOME; process.env.CODEX_HOME = root;
const rpc = new AppServer({ execution: true });
let control, releaseSlot;
try {
  releaseSlot = await reserveOwnerSlot(join(root, 'background'));
  await rpc.start({ cwd: root });
  const result = await rpc.request('thread/start', { cwd: root, ephemeral: false });
  const threadId = result.thread.id;
  await rpc.request('thread/name/set', { threadId, name: 'Isolated retained owner' });
  const runtime = new BackgroundRuntime({ rpc }); runtime.initialize(result, 'Isolated retained owner');
  let notifications = 0;
  const handle = createOwnerLifecycle({ root, runtime, serverPid: rpc.child.pid, announce: async () => { notifications++; } });
  let cleanup; const closed = new Promise(resolve => { cleanup = resolve; });
  control = await serveOwner({ root, threadId, serverPid: rpc.child.pid, handle,
    afterReply: async receipt => {
      if (receipt.phase === 'archived') { await control.close(); await rpc.close(); cleanup(); }
    } });
  assert.ok(await retainedOwner(root, threadId));
  const run = () => createLifecycle({ stateDirectory: root, inspect: async () => ({ owner: 'background', runtimeStatus: 'idle', pendingRequests: 0 }) });
  const args = { threadId, requestId: 'real-retained-archive-0001' };
  const ack = await run()('archive', args);
  assert.equal(ack.phase, 'archived'); assert.equal(ack.route, 'background-owner');
  assert.equal(ack.serverAcknowledged, true); await closed;
  assert.equal((await run()('archive', args)).replayed, true);
  assert.equal((await readOwnerOutcome(root, args)).phase, 'archived'); assert.equal(notifications, 1);
  assert.deepEqual(await writerPids(threadId), []);
  await assert.rejects(access(control.record.endpoint));
  await withServer({}, async client => {
    for (const archived of [false, true]) {
      const page = await client.request('thread/list', { archived, limit: 100 });
      assert.equal(page.data.some(x => x.id === threadId), archived);
    }
    assert.equal((await client.request('thread/read', { threadId, includeTurns: false })).thread.id, threadId);
  });
  console.log('PASS: real original-owner archive, authenticated control, durable replay after shutdown, inventories/history and writer/socket release. Desktop visual refresh and Claude integration are separate checks.');
} finally {
  await control?.close(); await rpc.close(); await releaseSlot?.();
  if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
}
