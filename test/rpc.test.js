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
    if (m.method === 'thread/unsubscribe') socket.write(JSON.stringify({ id: m.id, error: { message: 'Shared Codex broker is busy.' } }) + '\n');
  });
  const controller = new AbortController();
  const client = new AppServer({ signal: controller.signal, timeoutMs: 80 }); t.after(() => client.close());
  await client.connectCompanion(endpoint);
  await assert.rejects(client.request('thread/unsubscribe'), { code: 'SOURCE_BUSY' });
  await assert.rejects(client.request('thread/read'), { code: 'RPC_TIMEOUT' });
  const pending = client.request('thread/read'); controller.abort();
  await assert.rejects(pending, { code: 'ABORTED' }); assert.equal(client.pending.size, 0);
});
test('source endpoints and executable paths must be explicit local resources', async t => {
  const root = await mkdtemp('/tmp/mcd-rpc-path-'); t.after(() => rm(root, { recursive: true }));
  const file = join(root, 'not-a-socket'); await writeFile(file, 'x');
  const client = new AppServer();
  await assert.rejects(client.connectCompanion('tcp:localhost:1234'), { code: 'INVALID_SOURCE' });
  await assert.rejects(client.connectCompanion(`unix:${file}`), { code: 'INVALID_SOURCE' });
  await assert.rejects(resolveBinary('codex'), { code: 'INVALID_BINARY' });
});
