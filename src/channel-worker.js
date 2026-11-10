import net from 'node:net';
import { rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import plugin from './index.js';
import { pluginVersion } from './version.js';
import { acquireFileLock } from './locks.js';
import { ChannelStore, routeDirectory, stateRoot, hash, readJSON, privateDirectory, atomicJSON } from './channel-store.js';
import { CompletionMonitor } from './channel-monitor.js';
import { pendingTaskEvents } from './attention.js';
import { notificationResult } from './notification-result.js';
import { createTaskFinalizer } from './task-finalization.js';
import { createLifecycle } from './lifecycle.js';
import { workerSocket, wire } from './channel-wire.js';

const id = process.argv[2];
const directory = routeDirectory(id);
const store = new ChannelStore(directory);
await privateDirectory(directory);
let unlock;
try { unlock = await acquireFileLock(join(directory, 'worker.mutex')); }
catch (e) { if (e.code === 'BUSY') process.exit(0); throw e; }
await store.init();
await atomicJSON(join(directory, 'worker.json'), { pid: process.pid, pluginVersion, startedAt: new Date().toISOString() });
const socketPath = await workerSocket(directory);
const existing = await lstat(socketPath).catch(e => { if (e.code !== 'ENOENT') throw e; });
if (existing && (!existing.isSocket() || existing.uid !== process.getuid())) throw new Error('Unsafe channel socket.');
await rm(socketPath, { force: true });
const { tool } = await plugin();
const finalize = createTaskFinalizer({ store, sessionId: id,
  readLatest: async threadId => JSON.parse(await tool.codex_status.execute({ threadId }, {})),
  readArchive: async requestId => JSON.parse(await tool.codex_operation_status.execute({ requestId }, {})),
  archive: args => createLifecycle({ stateDirectory: stateRoot(), socketPath: process.env.MAGPIE_CODEX_SOCKET })('archive', args, {}),
});
let subscriber, idleTimer;
const clients = new Set(), announced = new Set();
const errors = new Map();
const monitor = new CompletionMonitor({ store, socketPath: process.env.MAGPIE_CODEX_SOCKET,
  onEvent: () => { deliver(); idle(); }, onError: (key, code) => errors.set(key, code) });
function deliver() {
  for (const client of clients) {
    if (!client.watch) continue;
    const tasks = Object.values(store.data.tasks).filter(t => client.watch.keys === null || client.watch.keys.includes(t.key));
    const events = pendingTaskEvents(tasks).filter(e => !announced.has(e.eventId)).slice(0, 50);
    if (!events.length && tasks.some(t => !t.event && !t.review)) continue;
    for (const event of events) announced.add(event.eventId);
    client.send({ id: client.watch.id, result: { events } });
    client.watch = null;
  }
  if (!subscriber?.ready) return;
  for (const event of pendingTaskEvents(Object.values(store.data.tasks))) {
    if (subscriber.sent.has(event.eventId)) continue;
    subscriber.sent.add(event.eventId);
    subscriber.send({ event });
  }
}
function idle() {
  clearTimeout(idleTimer);
  if (!clients.size && !Object.values(store.data.tasks).some(t => t.turnId && !t.event)) {
    idleTimer = setTimeout(shutdown, 60000);
  }
}
// Reconcile a worker crash after dispatch persisted its receipt but before we did.
for (const task of Object.values(store.data.tasks)) {
  if (task.turnId) continue;
  const key = task.name === 'codex_create_task' ? `flow_${hash(task.requestId)}` : task.requestId;
  const journal = await readJSON(join(stateRoot(), `${hash(key)}.json`));
  if (journal?.result) await store.accept(task.key, journal.result);
}
monitor.refresh();
const server = net.createServer(socket => {
  const current = { ready: false, sent: new Set() };
  clients.add(current); clearTimeout(idleTimer);
  const send = wire(socket, message => { void handle(message).catch(() => socket.destroy()); });
  current.send = send;
  async function handle(message) {
    if (message.method === 'ready') {
      if (subscriber && subscriber !== current) { socket.end(); return; }
      subscriber = current; current.ready = true; deliver(); return;
    }
    if (!Number.isSafeInteger(message.id)) throw new Error('Invalid request.');
    try {
      let result;
      if (message.method === 'hook_register') result = { key: await store.register(message.args.name, message.args.input) };
      else if (message.method === 'hook_receipt') {
        if (!store.data.tasks[message.args.key]) throw new Error('Missing notification binding.');
        await store.accept(message.args.key, message.args.receipt); monitor.refresh(); result = { bound: true };
      } else if (message.method === 'hook_watch') {
        const keys = message.args.keys;
        if (keys !== null && (!Array.isArray(keys) || !keys.every(k => Object.hasOwn(store.data.tasks, k)))) throw new Error('Invalid watch binding.');
        current.watch = { id: message.id, keys };
        deliver(); return;
      } else if (message.method === 'hook_resume') {
        if (message.args?.replay !== false) announced.clear();
        result = { keys: Object.values(store.data.tasks).filter(t => !t.review && t.turnId).map(t => t.key) };
      } else if (message.method === 'tools') result = Object.entries(tool).map(([name, t]) => ({ name, description: t.description, inputSchema: t.args }));
      else if (message.method === 'review') {
        result = await store.review(message.args.eventId, message.args.verdict, message.args.summary);
      } else if (message.method === 'result') {
        result = await notificationResult(store, message.args.eventId);
      } else if (message.method === 'finalize') {
        result = await finalize(message.args);
      } else if (message.method === 'status') {
        result = { sessionId: id, capabilities: { attentionNotifications: true, reviewRequiresResult: true, automaticTaskArchival: true }, totalTasks: Object.keys(store.data.tasks).length, pendingReviews: store.pending().length,
          tasks: Object.values(store.data.tasks).slice(-50).map(t => ({ requestId: t.requestId, threadId: t.threadId, turnId: t.turnId,
          state: t.review ? 'reviewed' : t.event ? 'awaiting_review' : t.attention?.length ? 'awaiting_attention' : t.turnId ? 'watching' : 'awaiting_receipt',
          attention: t.attention ?? [], event: t.event, resultRead: t.resultRead, review: t.review, finalization: t.finalization, lastMonitorError: errors.get(t.key) })) };
      } else if (message.method === 'call') {
        const { name, args } = message;
        if (!Object.hasOwn(tool, name)) throw new Error('Unknown tool.');
        const watched = ['codex_dispatch', 'codex_create_task', 'codex_followup'].includes(name);
        const key = watched ? await store.register(name, args) : null;
        const text = await tool[name].execute(args, {});
        result = JSON.parse(text);
        if (key) { await store.accept(key, result); monitor.refresh(); result.completionChannel = id; }
      } else throw new Error('Unknown method.');
      send({ id: message.id, result }); deliver(); idle();
    } catch (e) { send({ id: message.id, error: e.message?.slice(0,500) ?? 'Channel operation failed.' }); }
  }
  socket.on('close', () => { clients.delete(current); if (subscriber === current) subscriber = undefined; idle(); });
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true; monitor.close(); server.close();
  await store.queue; await unlock(); process.exit(0);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
await finalize.recover();
idle();
