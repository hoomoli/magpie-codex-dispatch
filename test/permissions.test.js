import test from 'node:test';
import assert from 'node:assert/strict';
import { permissionSettings, assertPermissions } from '../src/permissions.js';
import { BackgroundRuntime } from '../src/background-runtime.js';

test('background auto-review survives backend initialization and reaches turn/start', async () => {
  const settings = permissionSettings('auto-review');
  const calls = [];
  const runtime = new BackgroundRuntime({ rpc: { request: async (method, params) => { calls.push({ method, params }); return { turn: { id: 'turn-1' } }; } }, publish() {} });
  runtime.initialize({ thread: { id: 'thread-1', cwd: '/tmp', status: { type: 'idle' } }, ...settings,
    sandbox: { type: 'workspaceWrite', networkAccess: false } }, 'Auto review');
  assert.equal(assertPermissions(runtime.state, 'auto-review').mode, 'auto-review');
  await runtime.start({ threadId: 'thread-1', input: [{ type: 'text', text: 'OK' }], ...settings });
  assert.equal(calls[0].method, 'turn/start');
  assert.equal(calls[0].params.approvalsReviewer, 'auto_review');
  runtime.state.currentPermissions.approvalsReviewer = 'user';
  assert.throws(() => assertPermissions(runtime.state, 'auto-review'), { code: 'PERMISSION_MISMATCH' });
});
