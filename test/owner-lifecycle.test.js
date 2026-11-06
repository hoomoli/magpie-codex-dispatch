import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { atomicJSON } from '../src/channel-store.js';
import { BackgroundRuntime } from '../src/background-runtime.js';
import { createOwnerLifecycle } from '../src/owner-lifecycle.js';
import { createLifecycle } from '../src/lifecycle.js';
import { createFlows } from '../src/flows.js';
import { serveOwner, retainedOwner, requestOwner, readOwnerOutcome, reserveOwnerSlot, ownerRecordPath, ownerOperationDirectory } from '../src/owner-control.js';
import { Operations } from '../src/operations.js';
import { rpcRejection } from '../src/rpc.js';

const id = '01900000-0000-7000-8000-000000000001';
const child = '01900000-0000-7000-8000-000000000002';
const args = { threadId: id, requestId: 'owner-archive-test-0001' };
async function fixture(t, options = {}) {
  const root = await mkdtemp('/tmp/mcd-owner-test-'); t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], events = [];
  const writers = options.writers ?? (async value => value === id ? [123] : []);
  const rpc = { request: async (method, params) => {
    calls.push([method, params]);
    if (method === 'thread/read') return { thread: { id, ephemeral: false, status: { type: 'idle' }, turns: [] } };
    if (method === 'thread/list') return { data: options.descendant && !params.archived ? [{ id: child }] : [], nextCursor: null };
    if (method === 'thread/archive') { events.push('submit'); return options.archive?.(); }
    return { turn: { id: 'turn-test' } };
  } };
  const runtime = new BackgroundRuntime({ rpc });
  runtime.initialize({ thread: { id, cwd: root, createdAt: 1, updatedAt: 1, status: { type: 'idle' }, turns: [] } }, 'Fixture');
  const run = createOwnerLifecycle({ root, runtime, serverPid: 123, writers, announce: async () => {
    assert.equal((await readOwnerOutcome(root, args)).serverAcknowledged, true);
    events.push('announce'); await options.announce?.();
  } });
  return { root, runtime, run, calls, events, writers, rpc };
}

test('owner archives once, journals ACK before notifying, and replays durably across handler reload', async t => {
  const f = await fixture(t);
  const receipt = await f.run('archive', args);
  assert.equal(receipt.phase, 'archived'); assert.equal(receipt.desktopNotified, true);
  assert.deepEqual(f.events, ['submit', 'announce']);
  assert.equal((await f.run('archive', args)).replayed, true);
  const reloaded = createOwnerLifecycle({ root: f.root, runtime: f.runtime, serverPid: 123 });
  assert.equal((await reloaded('archive', args)).completed, true);
  assert.equal(f.calls.filter(([m]) => m === 'thread/archive').length, 1);
  await assert.rejects(f.run('release', args), { code: 'REQUEST_ID_CONFLICT' });
});

test('active and pending-input owners refuse before archive, same ID can retry after preflight refusal', async t => {
  for (const pending of [false, true]) {
    const f = await fixture(t);
    if (pending) f.runtime.state.requests.push({ id: 1 }); else f.runtime.state.threadRuntimeStatus = { type: 'active' };
    await assert.rejects(f.run('archive', args), { code: 'THREAD_ACTIVE' });
    assert.equal((await readOwnerOutcome(f.root, args)).submitted, false);
    assert.equal(f.events.length, 0);
    f.runtime.state.requests = []; f.runtime.state.threadRuntimeStatus = { type: 'idle' };
    assert.equal((await f.run('archive', args)).phase, 'archived');
  }
});

test('wrong writer and held descendant are refused without takeover or mutation', async t => {
  const changed = await fixture(t, { writers: async () => [456] });
  await assert.rejects(changed.run('archive', args), { code: 'OWNER_CHANGED' });
  assert.equal(changed.events.length, 0);
  const descendants = await fixture(t, { descendant: true, writers: async value => value === id ? [123] : [456] });
  await assert.rejects(descendants.run('archive', args), { code: 'DESCENDANT_HELD' });
  assert.equal(descendants.events.length, 0);
});
test('owner rechecks the locked descendant scope before sending archive', async t => {
  const f = await fixture(t, { descendant: true });
  await assert.rejects(f.run('archive', { ...args, expectedThreadIds: [id] }), { code: 'SCOPE_CHANGED' });
  assert.equal(f.events.length, 0);
});

test('lost backend reply freezes mutation, persists unknown, and never resends after reload or new ID', async t => {
  const f = await fixture(t, { archive: async () => { throw Error('connection lost after possible delivery'); } });
  assert.equal((await f.run('archive', args)).phase, 'outcome_unknown');
  assert.equal((await f.run('archive', args)).replayed, true);
  await assert.rejects(f.runtime.handle('thread-follower-start-turn', { conversationId: id, turnStart: { request: { threadId: id, input: [] } } }), { code: 'OWNER_CLOSING' });
  await assert.rejects(f.run('archive', { ...args, requestId: 'unknown-new-id-0001' }), { code: 'OWNER_CLOSING' });
  assert.deepEqual(f.events, ['submit']);
  assert.equal((await readOwnerOutcome(f.root, args)).completed, false);
});

test('structured archive rejection is terminal for the ID and does not disable normal execution', async t => {
  const f = await fixture(t, { archive: async () => { throw rpcRejection('thread/archive', args, { code: -32600, message: `thread ${id} already has an active writer` }); } });
  const result = await f.run('archive', args);
  assert.equal(result.phase, 'rejected'); assert.equal(result.serverRejected, true);
  assert.equal(f.runtime.lifecycleBlocked, false);
  assert.equal((await f.run('archive', args)).replayed, true);
  assert.deepEqual(f.events, ['submit']);
});

test('archive ACK remains successful when desktop notification fails', async t => {
  const f = await fixture(t, { announce: async () => { throw Error('desktop disconnected'); } });
  const result = await f.run('archive', args);
  assert.equal(result.phase, 'archived'); assert.equal(result.serverAcknowledged, true);
  assert.equal(result.desktopNotified, false);
});

test('failed durable ACK write keeps unknown intent and cannot repeat the mutation', async t => {
  const f = await fixture(t); const operations = new Operations(ownerOperationDirectory(f.root));
  const save = operations.save.bind(operations);
  operations.save = async (id, state) => { if (state.phase === 'archived') throw Error('disk failure'); return save(id, state); };
  const run = createOwnerLifecycle({ root: f.root, runtime: f.runtime, serverPid: 123, writers: f.writers,
    operations, announce: async () => assert.fail('Must not announce before durable ACK') });
  await assert.rejects(run('archive', args), { code: 'OUTCOME_UNKNOWN' });
  assert.equal((await readOwnerOutcome(f.root, args)).phase, 'outcome_unknown');
  assert.equal((await run('archive', args)).phase, 'outcome_unknown');
  assert.equal(f.calls.filter(([m]) => m === 'thread/archive').length, 1);
  assert.equal(f.runtime.lifecycleBlocked, true);
});

test('notification metadata write failure preserves durable ACK and allows confirmed cleanup', async t => {
  const f = await fixture(t); const operations = new Operations(ownerOperationDirectory(f.root));
  const save = operations.save.bind(operations); let ackWrites = 0;
  operations.save = async (id, state) => {
    if (state.phase === 'archived' && ++ackWrites === 2) throw Error('metadata failure'); return save(id, state);
  };
  const run = createOwnerLifecycle({ root: f.root, runtime: f.runtime, serverPid: 123, writers: f.writers, operations });
  const result = await run('archive', args);
  assert.equal(result.phase, 'archived'); assert.equal(result.serverAcknowledged, true);
  assert.equal(result.desktopNotified, false);
  assert.equal((await readOwnerOutcome(f.root, args)).phase, 'archived');
});

test('archive is serialized with follower commands and different archive IDs', async t => {
  let release, entered;
  const waiting = new Promise(r => { entered = r; }); const gate = new Promise(r => { release = r; });
  const f = await fixture(t, { archive: async () => { entered(); await gate; } });
  const first = f.run('archive', args); await waiting;
  const second = f.run('archive', { ...args, requestId: 'concurrent-archive-0001' });
  const follower = f.runtime.handle('thread-follower-start-turn', { conversationId: id, turnStart: { request: { threadId: id, input: [] } } });
  const checks = [assert.rejects(second, { code: 'OWNER_CLOSING' }), assert.rejects(follower, { code: 'OWNER_CLOSING' })];
  release(); assert.equal((await first).phase, 'archived'); await Promise.all(checks);
  assert.equal(f.calls.filter(([m]) => m === 'thread/archive').length, 1);
});

test('explicit idle release is durable, does not archive, and blocks later follower mutation', async t => {
  const f = await fixture(t);
  const result = await f.run('release', args);
  assert.equal(result.phase, 'release_accepted'); assert.equal(result.submitted, false);
  assert.equal((await f.run('release', args)).replayed, true);
  assert.equal(f.events.length, 0);
  await assert.rejects(f.runtime.start({ threadId: id, input: [] }), { code: 'OWNER_CLOSING' });
});

test('private control authenticates generation, checks actual writer and removes socket/descriptor on close', async t => {
  const f = await fixture(t);
  const server = await serveOwner({ root: f.root, threadId: id, serverPid: 123, handle: f.run });
  t.after(() => server.close());
  const record = await retainedOwner(f.root, id, f.writers);
  assert.equal(record.generation, server.record.generation);
  assert.equal(await retainedOwner(f.root, id, async () => [456]), null);
  await assert.rejects(requestOwner({ ...record, generation: 'wrong' }, 'archive', args), { code: 'INVALID_OWNER_RESPONSE' });
  assert.equal(f.events.length, 0);
  assert.equal((await requestOwner(record, 'archive', args)).phase, 'archived');
  await server.close();
  await assert.rejects(access(record.endpoint)); await assert.rejects(access(ownerRecordPath(f.root, id)));
  assert.equal((await readOwnerOutcome(f.root, args)).phase, 'archived');
});

test('caller timeout does not lose durable ACK; lifecycle and status recover receipt without reconnecting', async t => {
  let release; const gate = new Promise(r => { release = r; });
  const f = await fixture(t, { archive: () => gate });
  let replied; const done = new Promise(r => { replied = r; });
  const server = await serveOwner({ root: f.root, threadId: id, serverPid: 123, handle: f.run, afterReply: replied });
  t.after(() => server.close());
  const run = createLifecycle({ stateDirectory: f.root, server: async (_o, fn) => fn(f.rpc), writers: f.writers,
    inspect: async () => ({ owner: 'background', runtimeStatus: 'idle', pendingRequests: 0 }),
    ownerRequest: (record, command, request) => requestOwner(record, command, request, { timeoutMs: 50 }) });
  const unknown = await run('archive', args);
  assert.equal(unknown.phase, 'outcome_unknown'); release(); await done;
  await server.close();
  assert.equal((await run('archive', args)).phase, 'archived');
  assert.equal((await createFlows({ stateDirectory: f.root })('operation_status', { requestId: args.requestId })).phase, 'archived');
  assert.equal(f.calls.filter(([m]) => m === 'thread/archive').length, 1);
});

test('owner admission is bounded and graceful release makes the capacity reusable', async t => {
  const f = await fixture(t); const dir = join(f.root, 'slots');
  const a = await reserveOwnerSlot(dir, 2), b = await reserveOwnerSlot(dir, 2);
  await assert.rejects(reserveOwnerSlot(dir, 2), { code: 'OWNER_LIMIT_REACHED' });
  await a(); const c = await reserveOwnerSlot(dir, 2); await b(); await c();
});

test('a crashed test worker releases its admission lock; stale descriptor never starts a replacement', async t => {
  const f = await fixture(t); const directory = join(f.root, 'crash-slots');
  const source = `import {reserveOwnerSlot} from ${JSON.stringify(new URL('../src/owner-control.js', import.meta.url).href)};
    await reserveOwnerSlot(${JSON.stringify(directory)}, 1); process.send('ready'); setInterval(()=>{},1000);`;
  const childProcess = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { if (childProcess.exitCode === null && !childProcess.signalCode) childProcess.kill('SIGKILL'); });
  await once(childProcess, 'message');
  await assert.rejects(reserveOwnerSlot(directory, 1), { code: 'OWNER_LIMIT_REACHED' });
  const exited = once(childProcess, 'exit'); childProcess.kill('SIGKILL'); await exited;
  const release = await reserveOwnerSlot(directory, 1); await release();
  const server = await serveOwner({ root: f.root, threadId: id, serverPid: 123, handle: f.run });
  t.after(() => server.close());
  await atomicJSON(ownerRecordPath(f.root, id), { ...server.record, pid: childProcess.pid });
  assert.equal(await retainedOwner(f.root, id, f.writers), null);
  assert.equal(f.events.length, 0);
  // Restore only this test's record so normal server cleanup can remove it.
  await atomicJSON(ownerRecordPath(f.root, id), server.record);
});
