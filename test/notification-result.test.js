import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ChannelStore } from '../src/channel-store.js';
import { notificationResult, readNotificationTurn } from '../src/notification-result.js';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { workerSocket, wire } from '../src/channel-wire.js';
import { routeDirectory } from '../src/channel-store.js';

const threadId = '00000000-0000-4000-8000-000000000001', turnId = 'result-turn';
async function fixture(t, status = 'completed', hasError = false) {
  const dir = await mkdtemp('/tmp/mcd-result-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ChannelStore(dir); await store.init();
  const key = await store.register('codex_dispatch', { requestId: 'read-result-001', prompt: 'private input' });
  await store.accept(key, { accepted: true, threadId, turnId });
  const result = { threadId, turnId, turnFound: true, status, hasError, output: 'private final output' };
  await store.complete(key, result);
  return { dir, store, result, eventId: store.data.tasks[key].event.eventId };
}

test('result retrieval is exact, durable and keeps output out of the queue', async t => {
  const { dir, store, result, eventId } = await fixture(t);
  let reads = 0;
  const read = async (thread, turn) => { reads++; assert.equal(thread, threadId); assert.equal(turn, turnId); return result; };
  await assert.rejects(notificationResult(store, 'other-session-event', read), /belong/);
  assert.equal(reads, 0);
  assert.equal((await notificationResult(store, eventId, read)).output, result.output);
  const saved = await readFile(join(dir, 'queue.json'), 'utf8');
  assert.ok(!saved.includes(result.output)); assert.ok(!saved.includes('private input'));
  const recovered = new ChannelStore(dir); await recovered.init();
  await recovered.review(eventId, 'passed', 'Checked the actual changes and validation.');
});

test('wrong, missing, nonterminal and conflicting results do not unlock review', async t => {
  const { store, result, eventId } = await fixture(t);
  for (const invalid of [undefined, null, '', 123]) {
    await assert.rejects(notificationResult(store, invalid, async () => { throw Error('Must not read'); }), /eventId is required/);
    assert.throws(() => store.review(invalid, 'passed', 'Unchecked'), /eventId is required/);
  }
  for (const patch of [{ threadId: 'other' }, { turnId: 'other' }, { turnFound: false }, { status: 'inProgress' }, { status: 'failed' }]) {
    await assert.rejects(notificationResult(store, eventId, async () => ({ ...result, ...patch })), /RESULT_UNCONFIRMED/);
    await assert.rejects(store.review(eventId, 'passed', 'Unchecked'), /RESULT_NOT_READ/);
  }
  await assert.rejects(notificationResult(store, eventId, async () => { throw Error('offline'); }), /offline/);
  await assert.rejects(store.review(eventId, 'unable_to_review', 'Result unavailable'), /RESULT_NOT_READ/);
});

test('attention events cannot be used to retrieve a completion result or unlock review', async t => {
  const { store } = await fixture(t);
  const key = await store.register('codex_dispatch', { requestId: 'attention-read-001', prompt: 'Wait for input' });
  await store.accept(key, { accepted: true, threadId, turnId: 'waiting-turn' });
  await store.setAttention(key, { threadId, turnId: 'waiting-turn', attentionRequests: [{ requestId: 'approval-1', method: 'commandExecution/requestApproval', kind: 'approval' }] });
  const eventId = store.data.tasks[key].attention[0].eventId;
  await assert.rejects(notificationResult(store, eventId, async () => { throw Error('Must not read'); }), /belong/);
  await assert.rejects(store.review(eventId, 'passed', 'Unchecked'), /belong/);
});

test('preexisting review receipts remain replayable without fabricating result-read evidence', async t => {
  const { store, eventId } = await fixture(t);
  const review = { verdict: 'passed', summary: 'Legacy review', reviewedAt: '2026-11-01T00:00:00Z' };
  await store.change(data => { Object.values(data.tasks)[0].review = review; });
  assert.deepEqual(await store.review(eventId, review.verdict, review.summary), review);
  await assert.rejects(store.review(eventId, 'changes_requested', 'Different'), /different/);
});

for (const [status, hasError] of [['failed', true], ['interrupted', false], ['completed', true]]) {
  test(`execution ${status} (error=${hasError}) cannot pass, but can receive a factual review`, async t => {
    const { store, result, eventId } = await fixture(t, status, hasError);
    await notificationResult(store, eventId, async () => result);
    await assert.rejects(store.review(eventId, 'passed', 'Looks fine'), /REVIEW_STATUS_CONFLICT/);
    await store.review(eventId, 'changes_requested', 'Execution did not finish cleanly.');
    assert.equal(store.pending().length, 0);
  });
}

test('result lookup closes the live reader and recovers history without dispatch', async () => {
  const result = { threadId, turnId, turnFound: true, status: 'completed', output: 'OK' };
  let closed = 0, histories = 0;
  const options = { desktopFactory: () => ({ async connect() { throw Error('owner offline'); }, close() { closed++; } }),
    readTerminal: async (_root, thread, turn) => { histories++; assert.equal(thread, threadId); assert.equal(turn, turnId); return result; } };
  assert.equal(await readNotificationTurn(threadId, turnId, options), result);
  assert.equal(closed, 1); assert.equal(histories, 1);
  await assert.rejects(readNotificationTurn(threadId, turnId, { ...options, readTerminal: async () => null }), /RESULT_UNAVAILABLE/);
});

test('live result lookup selects the event turn rather than the newest turn', async () => {
  let closed = false;
  const result = await readNotificationTurn(threadId, turnId, {
    desktopFactory: () => ({ async connect() { return { revision: 2, state: { id: threadId, turns: [
      { turnId, status: 'completed', items: [{ type: 'agentMessage', text: 'Exact result' }] },
      { turnId: 'newer-turn', status: 'inProgress', items: [] },
    ] } }; }, close() { closed = true; } }),
    readTerminal: async () => { throw Error('Live result should win'); },
  });
  assert.equal(result.output, 'Exact result'); assert.equal(result.turnId, turnId); assert.equal(closed, true);
});

for (const transport of ['notifications', 'channel']) test(`${transport} refuses an older worker rather than bypassing the review gate`, { timeout: 10000 }, async t => {
  const root = await mkdtemp('/tmp/mcd-old-worker-'), sessionId = randomUUID();
  const path = await workerSocket(routeDirectory(sessionId, root)), sockets = new Set(), calls = [];
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    const send = wire(socket, message => {
      if (message.method === 'ready') return;
      calls.push(message.method);
      send({ id: message.id, result: message.method === 'tools' ? [] : { sessionId, tasks: [], capabilities: { attentionNotifications: true } } });
    });
  });
  const client = new Client({ name: 'old-worker-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(path, { force: true }); await rm(root, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(path, resolve));
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL(`../src/${transport}.js`, import.meta.url))],
    env: { ...process.env, MAGPIE_CODEX_STATE_DIR: root, MAGPIE_CODEX_CHANNEL_ID: sessionId }, stderr: 'pipe' }));
  for (const name of ['codex_notification_result', 'codex_review_complete']) {
    const response = await client.callTool({ name, arguments: { ...(transport === 'notifications' ? { sessionId } : {}), eventId: 'saved-event',
      ...(name === 'codex_review_complete' ? { verdict: 'passed', summary: 'Unchecked' } : {}) } });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /NOTIFICATION_UPGRADE_REQUIRED/);
  }
  assert.ok(!calls.includes('result')); assert.ok(!calls.includes('review'));
});
