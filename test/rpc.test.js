import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppServer, resolveBinary } from '../src/rpc.js';

async function broker(t, respond) {
  const root = await mkdtemp('/tmp/mcd-rpc-'); const path = join(root, 'broker.sock');
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = ''; socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk; let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        if (message.id) respond(socket, message);
      }
    });
  });
  server.listen(path); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(r => server.close(r)); await rm(root, { recursive: true }); });
  return `unix:${path}`;
}
const reply = (socket, id, result) => socket.write(JSON.stringify({ id, result }) + '\n');
test('companion handshake, fragmented responses and forbidden temporary execution methods', async t => {
  const endpoint = await broker(t, (socket, m) => {
    const result = m.method === 'initialize' ? { userAgent: 'codex-companion-broker' } : { thread: { id: 'test', status: { type: 'idle' } } };
    const data = JSON.stringify({ id: m.id, result }) + '\n'; socket.write(data.slice(0, 5)); socket.write(data.slice(5));
  });
  const client = new AppServer(); t.after(() => client.close());
  await client.connectCompanion(endpoint);
  assert.equal((await client.request('thread/read')).thread.status.type, 'idle');
  await assert.rejects(client.request('turn/start', {}), { code: 'UNSUPPORTED_METHOD' });
});
test('wrong source handshake cannot be treated as a supported broker', async t => {
  const endpoint = await broker(t, (socket, m) => reply(socket, m.id, { userAgent: 'different-app' }));
  const client = new AppServer(); t.after(() => client.close());
  await assert.rejects(client.connectCompanion(endpoint), { code: 'UNSUPPORTED_SOURCE' });
});
test('busy replies are explicit, timeout is bounded, cancellation cleans pending RPCs', async t => {
  const endpoint = await broker(t, (socket, m) => {
    if (m.method === 'initialize') reply(socket, m.id, { userAgent: 'codex-companion-broker' });
    if (m.method === 'thread/unsubscribe') socket.write(JSON.stringify({ id: m.id, error: { code: -32001, message: 'Shared Codex broker is busy.' } }) + '\n');
  });
  const controller = new AbortController();
  const client = new AppServer({ signal: controller.signal, timeoutMs: 80 }); t.after(() => client.close());
  await client.connectCompanion(endpoint);
  await assert.rejects(client.request('thread/unsubscribe'), { code: 'SOURCE_BUSY', delivery: 'not-submitted' });
  await assert.rejects(client.request('thread/read'), { code: 'RPC_TIMEOUT' });
  const pending = client.request('thread/read'); controller.abort();
  await assert.rejects(pending, { code: 'ABORTED' }); assert.equal(client.pending.size, 0);
});
test('generic busy and RPC errors do not authorize release resubmission', async t => {
  const endpoint = await broker(t, (socket, m) => {
    if (m.method === 'initialize') reply(socket, m.id, { userAgent: 'codex-companion-broker' });
    else socket.write(JSON.stringify({ id: m.id, error: { code: -32000, message: 'Shared Codex broker is busy.' } }) + '\n');
  });
  const client = new AppServer(); t.after(() => client.close());
  await client.connectCompanion(endpoint);
  await assert.rejects(client.request('thread/unsubscribe'), error => error.code === 'RPC_REJECTED' && error.delivery === undefined);
});
test('source endpoints and executable paths must be explicit local resources', async t => {
  const root = await mkdtemp('/tmp/mcd-rpc-path-'); t.after(() => rm(root, { recursive: true }));
  const file = join(root, 'not-a-socket'); await writeFile(file, 'x');
  const client = new AppServer();
  await assert.rejects(client.connectCompanion('tcp:localhost:1234'), { code: 'INVALID_SOURCE' });
  await assert.rejects(client.connectCompanion(`unix:${file}`), { code: 'INVALID_SOURCE' });
  await assert.rejects(resolveBinary('codex'), { code: 'INVALID_BINARY' });
});
test('lifecycle clients allow only archive, never permanent delete, Companion mutation or turn execution', async t => {
  const endpoint = await broker(t, (socket, m) => reply(socket, m.id, { userAgent: 'codex-companion-broker' }));
  const companion = new AppServer({ lifecycle: true }); t.after(() => companion.close());
  await companion.connectCompanion(endpoint);
  for (const method of ['thread/archive', 'thread/delete']) {
    await assert.rejects(companion.request(method), { code: 'UNSUPPORTED_METHOD' });
    const plain = new AppServer();
    await assert.rejects(plain.request(method), { code: 'UNSUPPORTED_METHOD' });
    const lifecycle = new AppServer({ lifecycle: true });
    lifecycle.input = { write(line) { const { id } = JSON.parse(line); const pending = lifecycle.pending.get(id); clearTimeout(pending.timer); lifecycle.pending.delete(id); pending.resolve({}); } };
    if (method === 'thread/archive') assert.deepEqual(await lifecycle.request(method, { threadId: 'example' }), {});
    else await assert.rejects(lifecycle.request(method, { threadId: 'example' }), { code: 'UNSUPPORTED_METHOD' });
    for (const denied of ['turn/start', 'thread/resume', 'thread/unarchive', 'command/exec']) {
      await assert.rejects(lifecycle.request(denied), { code: 'UNSUPPORTED_METHOD' });
    }
  }
});
test('RPC errors retain safe method/code diagnostics without leaking raw payloads', async t => {
  const id = '01900000-0000-7000-8000-000000000001';
  const failures = [
    [{ code: -32600, message: `thread not loaded: ${id}` }, 'THREAD_UNAVAILABLE'],
    [{ code: -32600, message: `thread ${id} already has an active writer` }, 'THREAD_IN_USE'],
    [{ code: -32601, message: 'private raw unsupported payload' }, 'UNSUPPORTED_METHOD'],
    [{ code: -32600, message: 'private prompt /private/path' }, 'RPC_REJECTED'],
  ];
  let failure;
  const endpoint = await broker(t, (socket, m) => {
    if (m.method === 'initialize') reply(socket, m.id, { userAgent: 'codex-companion-broker' });
    else socket.write(JSON.stringify({ id: m.id, error: failure }) + '\n');
  });
  const client = new AppServer(); t.after(() => client.close());
  await client.connectCompanion(endpoint);
  for (const [value, code] of failures) {
    failure = value;
    await assert.rejects(client.request('thread/read', { threadId: id }), error => {
      assert.equal(error.code, code);
      assert.equal(error.rpcMethod, 'thread/read');
      assert.equal(error.rpcCode, value.code);
      assert.ok(!error.message.includes('private'));
      return true;
    });
  }
});
