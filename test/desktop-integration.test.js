import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 200; i++) { if (await fn()) return; await pause(20); } throw new Error('Timed out'); }
function frame(value) { const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32LE(body.length); return Buffer.concat([header, body]); }

for (const mode of ['normal', 'owner-replacement', 'worker-restart']) test(`native hook processes recover and wake (mode=${mode})`, { timeout: 20000 }, async t => {
  const root = await mkdtemp('/tmp/mcd-hook-'), sessionId = randomUUID(), threadId = randomUUID(), turnId = 'hook-test-turn';
  const sockets = new Set(), followers = new Set(), children = new Set();
  let status = 'inProgress', reads = 0, owner = 'owner';
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => { sockets.delete(socket); followers.delete(socket); });
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const size = buffer.readUInt32LE(0), msg = JSON.parse(buffer.subarray(4, size + 4)); buffer = buffer.subarray(size + 4);
        if (msg.type === 'request') {
          reads++;
          socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', handledByClientId: owner, result: msg.method === 'initialize' ? { clientId: randomUUID() } : {} }));
        } else if (msg.method === 'thread-stream-following-changed' && msg.params.following) {
          followers.add(socket);
          socket.write(frame({ type: 'broadcast', sourceClientId: owner, method: 'thread-stream-state-changed', version: 11, params: { hostId: 'local', conversationId: threadId, change: { type: 'snapshot', revision: 1, conversationState: { id: threadId, turns: [{ turnId, status, items: [] }], requests: [] } } } }));
        }
      }
    });
  });
  const ipc = join(root, 'ipc.sock'); await new Promise(resolve => server.listen(ipc, resolve));
  const env = { ...process.env, MAGPIE_CODEX_STATE_DIR: root, MAGPIE_CODEX_SOCKET: ipc };
  let client;
  t.after(async () => {
    await client?.close(); for (const child of children) child.kill();
    try { process.kill(JSON.parse(await readFile(join(root, 'channels', sessionId, 'worker.json'))).pid, 'SIGTERM'); } catch {}
    for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
    await pause(100); await rm(root, { recursive: true, force: true });
  });
  function hook(input) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/desktop-hook.js', import.meta.url))], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child); let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    child.stdin.end(JSON.stringify(input));
    return new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => { children.delete(child); resolve({ code, stdout, stderr }); }); });
  }
  const base = { session_id: sessionId, tool_name: 'mcp__magpie__magpie-codex-dispatch_codex_dispatch', tool_input: { requestId: 'native-hook-test-001', threadId, prompt: 'OK' } };
  assert.equal((await hook({ ...base, hook_event_name: 'PreToolUse' })).code, 0);
  const input = { ...base, hook_event_name: 'PostToolUse', tool_response: { content: [{ type: 'text', text: JSON.stringify({ requestId: base.tool_input.requestId, accepted: true, threadId, turnId }) }] } };
  const a = hook(input), b = hook(input);
  await until(() => followers.size === 1);
  const before = reads; await pause(150); assert.equal(reads, before, 'waiting performs no status polling');
  status = 'completed';
  if (mode === 'worker-restart') {
    const info = JSON.parse(await readFile(join(root, 'channels', sessionId, 'worker.json')));
    process.kill(info.pid, 'SIGTERM');
  } else if (mode === 'owner-replacement') {
    const previous = owner; owner = 'replacement-owner';
    // Keep the router and waiting hook connections alive; only its owner went away.
    for (const socket of followers) socket.write(frame({ type: 'broadcast', method: 'client-status-changed',
      params: { clientId: previous, status: 'disconnected' } }));
  } else {
  for (const socket of followers) socket.write(frame({ type: 'broadcast', sourceClientId: owner, method: 'thread-stream-state-changed', version: 11, params: { hostId: 'local', conversationId: threadId, change: { type: 'patches', baseRevision: 1, revision: 2, patches: [{ op: 'replace', path: ['turns', 0, 'status'], value: status }] } } }));
  }
  const results = await Promise.all([a, b]);
  if (mode === 'worker-restart') { assert.ok(results.some(r => r.code === 2)); assert.ok(results.every(r => [0, 2].includes(r.code))); }
  else assert.deepEqual(results.map(r => r.code).sort(), [0, 2]);
  assert.equal(reads, before + (mode === 'normal' ? 0 : 2)); assert.match(results.find(r => r.code === 2).stderr, /completion notification/);
  const recovered = await hook({ session_id: sessionId, hook_event_name: 'SessionStart' }); assert.equal(recovered.code, 2);
  const queue = JSON.parse(await readFile(join(root, 'channels', sessionId, 'queue.json')));
  const eventId = Object.values(queue.tasks)[0].event.eventId;
  client = new Client({ name: 'desktop-notifications-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/notifications.js', import.meta.url))], env, stderr: 'pipe' }));
  assert.equal(client.getServerCapabilities().experimental, undefined, 'no Channels capability or launch flag needed');
  assert.equal((await client.listTools()).tools.length, 3);
  const premature = await client.callTool({ name: 'codex_review_complete', arguments: { sessionId, eventId, verdict: 'passed', summary: 'Skipped reading.' } });
  assert.equal(premature.isError, true);
  assert.match(premature.content[0].text, /RESULT_NOT_READ/);
  const final = await client.callTool({ name: 'codex_notification_result', arguments: { sessionId, eventId } });
  assert.ok(!final.isError, JSON.stringify(final));
  assert.equal(JSON.parse(final.content[0].text).turnId, turnId);
  const ack = await client.callTool({ name: 'codex_review_complete', arguments: { sessionId, eventId, verdict: 'passed', summary: 'Isolated hook fixture checked.' } });
  assert.ok(!ack.isError, JSON.stringify(ack));
  const repeated = await hook({ session_id: sessionId, hook_event_name: 'SessionStart' }); assert.equal(repeated.code, 0);
  const diagnostic = await client.callTool({ name: 'codex_notification_status', arguments: { sessionId } });
  assert.equal(JSON.parse(diagnostic.content[0].text).tasks[0].state, 'reviewed');
});
