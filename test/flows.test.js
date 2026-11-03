import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFlows } from '../src/flows.js';
import { Operations } from '../src/operations.js';
import { resolveProject } from '../src/projects.js';
import { DispatchError } from '../src/desktop.js';

const threadId = '01900000-0000-7000-8000-000000000001';
const args = { requestId: 'test-create-0001', projectName: 'demo', prompt: 'private test content' };
async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mcd-flow-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const events = []; const starts = []; const dispatches = []; let created; let attached = false;
  const options = {
    stateDirectory: dir,
    resolveProject: async () => ({ cwd: dir, projectId: 'project', projectName: 'demo' }),
    server: async (_options, fn) => {
      events.push('creator-start');
      try { return await fn({ request: async (method, params) => {
        events.push(method);
        if (method === 'thread/start') {
          starts.push(params);
          created = { id: threadId, cwd: dir, projectId: 'project', threadSource: params.threadSource };
          if (overrides.loseCreation) throw new DispatchError('RPC_TIMEOUT', 'lost creation reply');
          return { thread: created };
        }
        if (method === 'thread/read') return { thread: created };
        if (method === 'thread/list') return { data: overrides.hideCreated ? [] : [{ ...created, ...(overrides.omitMarker ? { threadSource: null } : {}) }], nextCursor: null };
        return {};
      } }); } finally { events.push('creator-exit'); }
    },
    desktopState: async () => { if (!attached) throw new DispatchError('NO_OWNER', 'unattached'); return { owner: 'desktop', cwd: dir }; },
    writerPids: async () => [],
    openThread: async () => { events.push('open'); attached = true; },
    dispatch: async (_operation, request) => { dispatches.push(request); events.push('dispatch'); return { turnId: 'turn-test' }; },
    ...overrides,
  };
  return { dir, events, starts, dispatches, options, run: createFlows(options) };
}
test('creation exits its server before desktop dispatch; restart retry creates and sends once', async t => {
  const f = await fixture(t);
  const result = await f.run('create', args);
  assert.equal(result.phase, 'accepted'); assert.equal(result.completed, false);
  assert.ok(f.events.indexOf('creator-exit') < f.events.indexOf('open'));
  assert.ok(f.events.indexOf('open') < f.events.indexOf('dispatch'));
  assert.equal((await createFlows(f.options)('create', args)).replayed, true);
  assert.equal(f.events.filter(e => e === 'thread/start').length, 1);
  assert.equal(f.events.filter(e => e === 'dispatch').length, 1);
  const state = await new Operations(f.dir).read(args.requestId);
  assert.ok(!JSON.stringify(state).includes(args.prompt));
  await assert.rejects(f.run('create', { ...args, prompt: 'different' }), { code: 'REQUEST_ID_CONFLICT' });
});
test('lost creation reply is reconciled using source marker without another start', async t => {
  const f = await fixture(t, { loseCreation: true });
  await assert.rejects(f.run('create', args), { code: 'RPC_TIMEOUT' });
  const result = await createFlows(f.options)('create', args);
  assert.equal(result.phase, 'accepted');
  assert.equal(f.events.filter(e => e === 'thread/start').length, 1);
});
test('unreconciled creation remains unknown across retries', async t => {
  const f = await fixture(t, { loseCreation: true, hideCreated: true });
  await assert.rejects(f.run('create', args));
  assert.equal((await f.run('create', args)).phase, 'creation_unknown');
  assert.equal((await createFlows(f.options)('create', args)).phase, 'creation_unknown');
  assert.equal(f.events.filter(e => e === 'thread/start').length, 1);
  assert.ok(!f.events.includes('dispatch'));
});
test('delayed source unload resumes handoff without repeating unsubscribe', async t => {
  let held = true; let releases = 0;
  const f = await fixture(t, { writerPids: async () => held ? [123] : [], releaseSource: async (_id, _endpoint, { beforeRelease }) => { releases++; await beforeRelease({ pid: 123 }); } });
  const handoff = { requestId: 'test-handoff-0001', threadId };
  assert.equal((await f.run('handoff', handoff)).phase, 'waiting_source_release');
  assert.equal((await createFlows(f.options)('handoff', handoff)).phase, 'waiting_source_release');
  held = false;
  assert.equal((await f.run('handoff', handoff)).phase, 'desktop_owned');
  assert.equal(releases, 1); assert.ok(!f.events.includes('dispatch'));
});
test('definite broker rejection after release intent retries once and then waits for unload', async t => {
  let held = true; let releases = 0;
  const f = await fixture(t, { writerPids: async () => held ? [123] : [], releaseSource: async (_id, _endpoint, { beforeRelease }) => {
    releases++;
    await beforeRelease({ pid: 123 });
    if (releases === 1) throw Object.assign(new DispatchError('SOURCE_BUSY', 'Rejected before forwarding'), { delivery: 'not-submitted' });
  } });
  const handoff = { requestId: 'rejected-release-0001', threadId };
  await assert.rejects(f.run('handoff', handoff), { code: 'SOURCE_BUSY' });
  const saved = await new Operations(f.dir).read(handoff.requestId);
  assert.equal(saved.phase, 'release_rejected'); assert.equal(saved.source, null);
  assert.equal((await createFlows(f.options)('handoff', handoff)).phase, 'waiting_source_release');
  assert.equal((await createFlows(f.options)('handoff', handoff)).phase, 'waiting_source_release');
  assert.equal(releases, 2);
  held = false;
  assert.equal((await f.run('handoff', handoff)).phase, 'desktop_owned');
  assert.equal(releases, 2);
});
for (const code of ['RPC_TIMEOUT', 'RPC_CLOSED', 'RPC_REJECTED', 'ABORTED']) {
  test(`${code} after release intent never retries an uncertain unsubscribe`, async t => {
    let releases = 0;
    const f = await fixture(t, { writerPids: async () => [123], releaseSource: async (_id, _endpoint, { beforeRelease }) => {
      releases++; await beforeRelease({ pid: 123 }); throw new DispatchError(code, 'Outcome not confirmed');
    } });
    const handoff = { requestId: 'unknown-release-0001', threadId };
    await assert.rejects(f.run('handoff', handoff), { code });
    for (let i = 0; i < 2; i++) assert.equal((await createFlows(f.options)('handoff', handoff)).phase, 'waiting_source_release');
    assert.equal(releases, 1);
  });
}
test('busy source is not forcibly released or opened', async t => {
  const f = await fixture(t, { writerPids: async () => [123], releaseSource: async () => { throw new DispatchError('SOURCE_NOT_IDLE', 'active'); } });
  await assert.rejects(f.run('handoff', { requestId: 'busy-source-0001', threadId }), { code: 'SOURCE_NOT_IDLE' });
  assert.ok(!f.events.includes('open')); assert.ok(!f.events.includes('dispatch'));
});
test('desktop acquisition pending retains one created thread across process restart', async t => {
  let available = false;
  const f = await fixture(t, { desktopState: async () => { if (!available) throw new DispatchError('NO_OWNER', 'unattached'); return {}; } });
  assert.equal((await f.run('create', args)).phase, 'waiting_desktop');
  available = true;
  assert.equal((await createFlows(f.options)('create', args)).phase, 'accepted');
  assert.equal(f.events.filter(e => e === 'thread/start').length, 1);
});
test('operation lock serializes callers and recovers a dead process lock', async t => {
  const f = await fixture(t); const store = new Operations(f.dir);
  let release; const gate = new Promise(resolve => { release = resolve; });
  let entered; const ready = new Promise(resolve => { entered = resolve; });
  const first = store.locked(args.requestId, async () => { entered(); await gate; });
  await ready;
  await assert.rejects(store.locked(args.requestId, async () => {}), { code: 'OPERATION_BUSY' });
  release(); await first;
  const lock = `${store.path(args.requestId)}.lock`;
  await mkdir(lock); await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
  await mkdir(`${lock}.recovery`);
  assert.equal(await store.locked(args.requestId, async () => 'recovered'), 'recovered');
});
test('a live or incomplete legacy lock cannot be bypassed during upgrade', async t => {
  const f = await fixture(t); const store = new Operations(f.dir);
  const lock = `${store.path(args.requestId)}.lock`;
  await mkdir(lock);
  await assert.rejects(store.locked(args.requestId, async () => assert.fail('entered')), { code: 'OPERATION_BUSY' });
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(store.locked(args.requestId, async () => assert.fail('entered')), { code: 'OPERATION_BUSY' });
});
test('project selection rejects ambiguity, UI IDs, outside roots, and implicit defaults', async t => {
  const f = await fixture(t);
  const server = async (_opts, fn) => fn({ request: async () => ({ data: [{ id: 'canonical', name: 'demo', roots: [{ path: f.dir }] }] }) });
  assert.deepEqual(await resolveProject({ projectName: 'demo' }, { server }), { cwd: await realpath(f.dir), projectId: 'canonical', projectName: 'demo' });
  await assert.rejects(resolveProject({ projectId: 'ui-id' }, { server }), { code: 'PROJECT_NOT_UNIQUE' });
  await assert.rejects(resolveProject({ projectName: 'demo', cwd: '/' }, { server }), { code: 'PROJECT_PATH_MISMATCH' });
  await assert.rejects(resolveProject({}, { server }), { code: 'PROJECT_REQUIRED' });
  const duplicate = async (_opts, fn) => fn({ request: async () => ({ data: [{ id: '1', name: 'demo', roots: [] }, { id: '2', name: 'demo', roots: [] }] }) });
  await assert.rejects(resolveProject({ projectName: 'demo' }, { server: duplicate }), { code: 'PROJECT_NOT_UNIQUE' });
});

test('unlisted empty thread recovery verifies the marker before binding and never recreates', async t => {
  const f = await fixture(t, { loseCreation: true, hideCreated: true });
  await assert.rejects(f.run('create', args));
  assert.equal((await f.run('create', args)).phase, 'creation_unknown');
  await assert.rejects(f.run('recover_creation', { requestId: args.requestId, threadId: '01900000-0000-7000-8000-000000000002' }), { code: 'RECOVERY_MISMATCH' });
  assert.equal((await f.run('recover_creation', { requestId: args.requestId, threadId })).phase, 'thread_created');
  assert.equal((await f.run('create', args)).phase, 'accepted');
  assert.equal(f.events.filter(e => e === 'thread/start').length, 1);
});

test('creation reconciliation reads metadata when list entries omit source markers', async t => {
  const f = await fixture(t, { loseCreation: true, omitMarker: true });
  await assert.rejects(f.run('create', args));
  assert.equal((await f.run('create', args)).phase, 'accepted');
  assert.ok(f.events.includes('thread/read'));
  assert.equal(f.events.filter(e => e === 'thread/start').length, 1);
});

test('crash after saving ID cannot skip project validation on resume', async t => {
  const f = await fixture(t);
  await f.run('create', args);
  const store = new Operations(f.dir);
  const state = await store.read(args.requestId);
  await store.save(args.requestId, { ...state, phase: 'thread_created', accepted: false, projectVerified: false });
  const changed = createFlows({ ...f.options, server: async (_options, fn) => fn({ request: async () => ({ thread: { id: threadId, cwd: f.dir, projectId: 'wrong-project', threadSource: state.marker } }) }) });
  await assert.rejects(changed('create', args), { code: 'PROJECT_MISMATCH' });
  assert.equal(f.events.filter(e => e === 'dispatch').length, 1);
});

test('creation carries explicit permissions through creator and native dispatch', async t => {
  const f = await fixture(t);
  await f.run('create', { ...args, permissionMode: 'full-access' });
  assert.equal(f.starts[0].permissions, ':danger-full-access');
  assert.equal(f.starts[0].approvalPolicy, 'never');
  assert.equal(f.dispatches[0].permissionMode, 'full-access');
  await assert.rejects(f.run('create', { ...args, permissionMode: 'read-only' }), { code: 'REQUEST_ID_CONFLICT' });
});
test('default creation inherits desktop settings; legacy sandbox retains compatible child receipt identity', async t => {
  const f = await fixture(t);
  await f.run('create', args);
  assert.equal(f.starts[0].permissions, undefined);
  assert.equal(f.starts[0].approvalPolicy, undefined);
  assert.equal(f.dispatches[0].permissionMode, undefined);
  const legacy = await fixture(t);
  await legacy.run('create', { ...args, sandbox: 'read-only' });
  assert.equal(legacy.starts[0].permissions, ':read-only');
  assert.equal(legacy.dispatches[0].sandbox, 'read-only');
  assert.equal(legacy.dispatches[0].permissionMode, undefined);
});
