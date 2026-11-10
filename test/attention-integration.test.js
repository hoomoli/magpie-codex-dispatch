import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ChannelStore } from '../src/channel-store.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let n = 0; n < 200; n++) { if (await fn()) return; await pause(20); } throw Error('Timed out'); }
function frame(value) { const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32LE(body.length); return Buffer.concat([header, body]); }

test('real native hooks wake for approval/input without polling or approval, then retain completion delivery', { timeout: 20000 }, async t => {
  const root = await mkdtemp('/tmp/mcd-attention-e2e-'), sessionId = randomUUID(), threadId = randomUUID(), turnId = 'attention-turn';
  const directory = join(root, 'channels', sessionId), store = new ChannelStore(directory);
  await store.init(); const key = await store.register('codex_dispatch', { requestId: 'attention-e2e-1', prompt: 'private task' });
  await store.accept(key, { accepted: true, threadId, turnId });
  const sockets = new Set(), followers = new Set(), children = new Set(), methods = [];
  let revision = 1, requests = [{ id: 3, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, command: 'private command', reason: 'private reason' } }], status = 'inProgress';
  const state = () => ({ id: threadId, turns: [{ turnId, status, items: [] }], requests,
    threadRuntimeStatus: { type: status === 'inProgress' ? 'active' : 'idle', activeFlags: requests.length ? ['waitingOnApproval'] : [] } });
  const snapshot = socket => socket.write(frame({ type: 'broadcast', sourceClientId: 'owner', method: 'thread-stream-state-changed', version: 11,
    params: { hostId: 'local', conversationId: threadId, change: { type: 'snapshot', revision, conversationState: state() } } }));
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => { sockets.delete(socket); followers.delete(socket); });
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const size = buffer.readUInt32LE(0), m = JSON.parse(buffer.subarray(4, size + 4)); buffer = buffer.subarray(size + 4);
        if (m.type === 'request') {
          methods.push(m.method);
          socket.write(frame({ type: 'response', requestId: m.requestId, resultType: 'success', handledByClientId: 'owner',
            result: m.method === 'initialize' ? { clientId: randomUUID() } : {} }));
        } else if (m.method === 'thread-stream-following-changed') {
          if (m.params.following) { followers.add(socket); snapshot(socket); } else followers.delete(socket);
        }
      }
    });
  });
  const ipc = join(root, 'ipc.sock'); await new Promise(resolve => server.listen(ipc, resolve));
  t.after(async () => {
    for (const child of children) child.kill();
    try { process.kill(JSON.parse(await readFile(join(directory, 'worker.json'))).pid, 'SIGTERM'); } catch {}
    for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
    await pause(100); await rm(root, { recursive: true, force: true });
  });
  function hook(event = 'SessionStart') {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/desktop-hook.js', import.meta.url))], {
      env: { ...process.env, MAGPIE_CODEX_STATE_DIR: root, MAGPIE_CODEX_SOCKET: ipc }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child); let text = '';
    child.stderr.on('data', b => text += b); child.stdout.resume();
    child.stdin.end(JSON.stringify({ session_id: sessionId, hook_event_name: event,
      tool_name: 'mcp__codex-notifications__codex_notification_status' }));
    return new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => { children.delete(child); resolve({ code, text }); }); });
  }
  const approval = await hook();
  assert.equal(approval.code, 2); assert.match(approval.text, /attention notification/); assert.match(approval.text, /waiting_on_approval/);
  const before = methods.length; let settled = false;
  const inputNotice = hook('PostToolUse').then(result => { settled = true; return result; });
  await pause(200); revision++; for (const s of followers) snapshot(s);
  await pause(100); assert.equal(settled, false, 'repeated snapshots do not repeat a pending approval notice');
  assert.equal(methods.length, before, 'the monitor does not poll the owner');
  requests = []; revision++; for (const s of followers) snapshot(s);
  await until(async () => Object.values(JSON.parse(await readFile(join(directory, 'queue.json'))).tasks).every(t => !t.attention?.length));
  requests = [{ id: 4, method: 'item/tool/requestUserInput', params: { threadId, turnId } }]; revision++; for (const s of followers) snapshot(s);
  const input = await inputNotice; assert.equal(input.code, 2); assert.match(input.text, /waiting_on_input/);
  const completion = hook('PostToolUse'); await pause(200);
  requests = []; status = 'completed'; revision++; for (const s of followers) snapshot(s);
  const completed = await completion; assert.equal(completed.code, 2); assert.match(completed.text, /completion notification/);
  assert.ok(methods.every(m => ['initialize', 'thread-owner-discovery'].includes(m)), 'no response, permission update, or task execution was submitted');
  const queue = await readFile(join(directory, 'queue.json'), 'utf8');
  for (const secret of ['private command', 'private reason', 'private task']) assert.ok(!queue.includes(secret));
});
