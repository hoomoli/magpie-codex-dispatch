import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

const threadId = '00000000-0000-4000-8000-000000000011';
const turnId = 'integration-turn';
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 200; i++) { if (await fn()) return; await pause(20); } throw new Error('Timed out'); }
function frame(message) { const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4); header.writeUInt32LE(body.length); return Buffer.concat([header, body]); }

for (const crash of [false, true]) test(`real stdio channel + detached worker: offline completion and durable review (crash=${crash})`, { timeout: 20000 }, async t => {
  const root = await mkdtemp('/tmp/mcd-e2e-'), id = randomUUID(), sockets = new Set(), followers = new Set();
  const ipc = join(root, 'ipc.sock');
  let status = 'completed', starts = 0, ownerReads = 0;
  const state = () => ({ id: threadId, currentPermissions: { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false } }, requests: [], threadRuntimeStatus: { type: status === 'inProgress' ? 'active' : 'idle' }, turns: starts ? [{ turnId, status, items: [] }] : [] });
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => { sockets.delete(socket); followers.delete(socket); });
    let buffer = Buffer.alloc(0);
    const send = m => socket.write(frame(m));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const size = buffer.readUInt32LE(0), m = JSON.parse(buffer.subarray(4, size + 4)); buffer = buffer.subarray(size + 4);
        if (m.type === 'request') {
          let result = {};
          if (m.method === 'initialize') result = { clientId: randomUUID() };
          if (m.method === 'thread-owner-discovery') ownerReads++;
          if (m.method === 'thread-follower-start-turn') { starts++; status = 'inProgress'; result = { result: { turn: { id: turnId } } }; }
          send({ type: 'response', requestId: m.requestId, resultType: 'success', handledByClientId: 'owner', result });
        } else if (m.method === 'thread-stream-following-changed') {
          if (!m.params.following) { followers.delete(socket); continue; }
          followers.add(socket); send({ type: 'broadcast', sourceClientId: 'owner', method: 'thread-stream-state-changed', version: 11,
            params: { hostId: 'local', conversationId: threadId, change: { type: 'snapshot', revision: 1, conversationState: state() } } });
        }
      }
    });
  });
  await new Promise(r => server.listen(ipc, r));
  let client;
  t.after(async () => {
    await client?.close();
    try { const info = JSON.parse(await readFile(join(root, 'channels', id, 'worker.json'))); process.kill(info.pid, 'SIGTERM'); } catch {}
    for (const s of sockets) s.destroy();
    await new Promise(r => server.close(r)); await pause(100); await rm(root, { recursive: true, force: true });
  });
  const events = [];
  async function connect() {
    client = new Client({ name: 'channel-test', version: '1.0.0' });
    client.setNotificationHandler(z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }) }), event => events.push(event));
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/channel.js', import.meta.url))],
      env: { ...process.env, MAGPIE_CODEX_CHANNEL_ID: id, MAGPIE_CODEX_STATE_DIR: root, MAGPIE_CODEX_SOCKET: ipc }, stderr: 'pipe' }));
    assert.deepEqual(client.getServerCapabilities().experimental, { 'claude/channel': {} });
  }
  await connect();
  const tools = await client.listTools(); assert.ok(tools.tools.some(t => t.name === 'codex_review_complete'));
  const args = { threadId, requestId: 'offline-event-1', prompt: 'Only reply OK' };
  const receipt = await client.callTool({ name: 'codex_dispatch', arguments: args });
  assert.ok(!receipt.isError, JSON.stringify(receipt)); assert.equal(JSON.parse(receipt.content[0].text).completionChannel, id);
  await until(() => followers.size === 1);
  await client.close(); client = null;
  if (crash) {
    const info = JSON.parse(await readFile(join(root, 'channels', id, 'worker.json')));
    process.kill(info.pid, 'SIGKILL');
    await until(() => followers.size === 0);
    // Model the crash window: dispatch's receipt is durable, route acceptance is not.
    const queuePath = join(root, 'channels', id, 'queue.json');
    const queue = JSON.parse(await readFile(queuePath));
    for (const task of Object.values(queue.tasks)) { delete task.threadId; delete task.turnId; }
    await writeFile(queuePath, JSON.stringify(queue), { mode: 0o600 });
    await connect(); await until(() => followers.size === 1);
    await client.close(); client = null;
  }
  const readsBefore = ownerReads;
  status = 'completed';
  for (const socket of followers) socket.write(frame({ type: 'broadcast', sourceClientId: 'owner', method: 'thread-stream-state-changed', version: 11,
    params: { hostId: 'local', conversationId: threadId, change: { type: 'patches', baseRevision: 1, revision: 2, patches: [
      { op: 'replace', path: ['turns',0,'status'], value: 'completed' }, { op: 'replace', path: ['threadRuntimeStatus','type'], value: 'idle' }] } } }));
  await until(async () => Object.values(JSON.parse(await readFile(join(root, 'channels', id, 'queue.json'))).tasks).some(t => t.event));
  assert.equal(ownerReads, readsBefore);
  await connect(); await until(() => events.length === 1);
  const eventId = events[0].params.meta.event_id;
  const premature = await client.callTool({ name: 'codex_review_complete', arguments: { eventId, verdict: 'passed', summary: 'Skipped reading.' } });
  assert.equal(premature.isError, true);
  assert.match(premature.content[0].text, /RESULT_NOT_READ/);
  const final = await client.callTool({ name: 'codex_notification_result', arguments: { eventId } });
  assert.ok(!final.isError, JSON.stringify(final));
  assert.equal(JSON.parse(final.content[0].text).turnId, turnId);
  const ack = await client.callTool({ name: 'codex_review_complete', arguments: { eventId, verdict: 'passed', summary: 'Isolated fixture reviewed.' } });
  assert.ok(!ack.isError, JSON.stringify(ack));
  await client.close(); await connect();
  await client.listTools(); await pause(100);
  assert.equal(events.length, 1);
  const replay = await client.callTool({ name: 'codex_dispatch', arguments: args });
  assert.equal(JSON.parse(replay.content[0].text).replayed, true); assert.equal(starts, 1);
});
