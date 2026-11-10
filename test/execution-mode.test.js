import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createFlows } from '../src/flows.js';
import { Operations } from '../src/operations.js';
const id = '01900000-0000-7000-8000-000000000001';

test('desktop execution verifies native ownership before dispatch and cannot be switched on replay', async t => {
  const root = await mkdtemp('/tmp/mcd-desktop-mode-'); t.after(() => rm(root, { recursive: true, force: true }));
  const events = []; let opened = false, created;
  const run = createFlows({ stateDirectory: root, backgroundCreate: async () => { throw Error('Wrong route'); },
    resolveProject: async () => ({ cwd: root, projectId: 'project' }), writerPids: async () => [],
    server: async (_, fn) => { try { return await fn({ request: async (method, params) => {
      if (method === 'thread/start') { events.push('create'); created = { id, cwd: root, projectId: 'project', threadSource: params.threadSource }; return { thread: created }; }
      return { thread: created };
    } }); } finally { events.push('creator-exit'); } },
    desktopState: async () => { if (!opened) throw Error('Not open'); events.push('desktop-confirmed'); return { owner: 'desktop', cwd: root }; },
    openThread: async () => { events.push('open'); opened = true; },
    dispatch: async () => { events.push('dispatch'); return { turnId: 'turn' }; },
  });
  const args = { requestId: 'desktop-mode-1', prompt: 'Test', executionMode: 'desktop' };
  const result = await run('create', args);
  assert.equal(result.owner, 'desktop'); assert.equal(result.executionMode, 'desktop'); assert.equal(result.accepted, true);
  assert.ok(events.indexOf('creator-exit') < events.indexOf('open'));
  assert.ok(events.indexOf('desktop-confirmed') < events.indexOf('dispatch'));
  assert.equal((await run('create', args)).replayed, true); assert.equal(events.filter(e => e === 'create').length, 1);
  await assert.rejects(run('create', { ...args, executionMode: 'background' }), { code: 'REQUEST_ID_CONFLICT' });
});

test('background request IDs cannot be recreated through desktop mode; invalid modes fail before any creation', async t => {
  const root = await mkdtemp('/tmp/mcd-mode-conflict-'); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Operations(join(root, 'background'));
  await mkdir(join(root, 'background'), { mode: 0o700 });
  const args = { requestId: 'mode-conflict-1', prompt: 'Test' };
  await store.save(args.requestId, { phase: 'queued', accepted: false });
  const run = createFlows({ stateDirectory: root, backgroundCreate: async () => { throw Error('Must not create'); } });
  await assert.rejects(run('create', { ...args, executionMode: 'desktop' }), { code: 'REQUEST_ID_CONFLICT' });
  await assert.rejects(run('create', { ...args, executionMode: 'invalid' }), { code: 'INVALID_ARGUMENT' });
});

test('execution route is reserved even before background startup produces its receipt', async t => {
  const root = await mkdtemp('/tmp/mcd-mode-reservation-'); t.after(() => rm(root, { recursive: true, force: true }));
  let launches = 0;
  const run = createFlows({ stateDirectory: root, backgroundCreate: async () => { launches++; return { accepted: false }; } });
  const args = { requestId: 'mode-reservation-1', prompt: 'Test' };
  await run('create', args);
  await assert.rejects(run('create', { ...args, executionMode: 'desktop' }), { code: 'REQUEST_ID_CONFLICT' });
  assert.equal(launches, 1);
});
