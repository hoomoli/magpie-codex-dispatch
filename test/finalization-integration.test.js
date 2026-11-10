import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ChannelStore, routeDirectory } from '../src/channel-store.js';

for (const transport of ['notifications', 'channel']) test(`${transport}: eligible closure reaches guarded lifecycle RPC once through a real worker`, { timeout: 20000 }, async t => {
  const root = await mkdtemp('/tmp/mcd-finalize-e2e-'), sessionId = randomUUID(), threadId = randomUUID(), turnId = 'accepted-turn';
  const directory = routeDirectory(sessionId, root), log = join(root, 'rpc.jsonl'), binary = join(root, 'fake-codex');
  const store = new ChannelStore(directory); await store.init();
  const key = await store.register('codex_dispatch', { requestId: 'finalize-e2e-001', prompt: 'Fixture only' });
  await store.accept(key, { accepted: true, threadId, turnId });
  const result = { threadId, turnId, turnFound: true, status: 'completed', hasError: false };
  await store.complete(key, result);
  const eventId = store.data.tasks[key].event.eventId;
  await store.resultRead(eventId, result); await store.review(eventId, 'passed', 'Isolated fixture checked.');
  await writeFile(binary, `#!${process.execPath}
const {createInterface}=require('node:readline');
const {appendFileSync}=require('node:fs');
const turn={id:process.env.TEST_TURN,status:'completed',items:[]};
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;
 appendFileSync(process.env.TEST_RPC_LOG,JSON.stringify({method:m.method,params:m.params})+'\\n');
 let result={};
 if(m.method==='thread/read')result={thread:{id:process.env.TEST_THREAD,ephemeral:false,status:{type:'idle'},turns:m.params.includeTurns?[turn]:[]}};
 if(m.method==='thread/turns/list')result={data:[turn],nextCursor:null};
 if(m.method==='thread/list')result={data:[],nextCursor:null};
 process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
});
`, { mode: 0o700 });
  const client = new Client({ name: 'finalize-e2e', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    try { const worker = JSON.parse(await readFile(join(directory, 'worker.json'))); process.kill(worker.pid, 'SIGTERM'); } catch {}
    await new Promise(resolve => setTimeout(resolve, 100)); await rm(root, { recursive: true, force: true });
  });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL(`../src/${transport}.js`, import.meta.url))],
    env: { ...process.env, MAGPIE_CODEX_CHANNEL_ID: sessionId, MAGPIE_CODEX_STATE_DIR: root,
      CODEX_HOME: root, MAGPIE_CODEX_BINARY: binary, TEST_THREAD: threadId, TEST_TURN: turnId, TEST_RPC_LOG: log }, stderr: 'pipe' }));
  const args = { ...(transport === 'notifications' ? { sessionId } : {}), eventId,
    mergeStatus: 'completed', mainValidationStatus: 'passed', followupRequired: false, keep: false,
    evidence: 'Fixture integration and main validation are complete.' };
  for (let n = 0; n < 2; n++) {
    const response = await client.callTool({ name: 'codex_task_finalize', arguments: args });
    assert.ok(!response.isError, JSON.stringify(response));
    assert.equal(JSON.parse(response.content[0].text).phase, 'archived');
  }
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.filter(c => c.method === 'thread/archive').length, 1);
  assert.ok(calls.some(c => c.method === 'thread/read' && c.params.includeTurns === true));
  assert.ok(!calls.some(c => c.method === 'turn/start' || c.method === 'thread/unsubscribe'));
  const saved = JSON.parse(await readFile(join(directory, 'queue.json')));
  assert.equal(saved.tasks[key].finalization.phase, 'archived');
});
