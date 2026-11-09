import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BackgroundRuntime } from '../src/background-runtime.js';
import { BackgroundIPC } from '../src/background-ipc.js';
import { createBackground, terminalBackgroundState } from '../src/background.js';
import { createFlows } from '../src/flows.js';
import { Operations } from '../src/operations.js';
import { atomicJSON, privateDirectory } from '../src/channel-store.js';
import { CompletionMonitor } from '../src/channel-monitor.js';
const id = '01900000-0000-7000-8000-000000000001';
const result = { thread: { id, cwd: '/tmp', createdAt: 1, updatedAt: 1, status: { type: 'idle' } }, model: 'test',
  approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false } };
function fixture() {
  const calls = [], replies = []; let published = 0;
  const rpc = { request: async (m,p) => { calls.push([m,p]); return m === 'thread/resume' ? result : { turn: { id: 'turn-1' }, turnId: 'turn-1' }; },
    respond: (id,r) => replies.push([id,r]), input: { write: line => replies.push(JSON.parse(line)) } };
  const runtime = new BackgroundRuntime({ rpc, publish: () => published++ }); runtime.initialize(result, 'Test');
  return { runtime, calls, replies, published: () => published };
}
test('render state preserves input and real streaming items; completion has exact output', async () => {
  const { runtime:r } = fixture(); const input = [{type:'text',text:'count'}];
  await r.start({ threadId:id,input }); r.notify({method:'turn/started',params:{threadId:id,turn:{id:'turn-1',status:'inProgress'}}});
  assert.deepEqual(r.state.turns[0].params.input,input);
  r.notify({method:'item/started',params:{threadId:id,turnId:'turn-1',item:{type:'commandExecution',id:'cmd',aggregatedOutput:'1\n'}}});
  r.notify({method:'item/commandExecution/outputDelta',params:{threadId:id,turnId:'turn-1',itemId:'cmd',delta:'2\n'}});
  assert.equal(r.state.turns[0].items[0].aggregatedOutput,'1\n2\n');
  r.notify({method:'turn/completed',params:{threadId:id,turn:{id:'turn-1',status:'completed',error:null}}});
  assert.equal(r.state.turns[0].status,'completed');
  r.notify({method:'thread/status/changed',params:{threadId:'other',status:{type:'active'}}});
  assert.equal(r.state.threadRuntimeStatus.type,'idle');
});
test('approval requires matching pending method and ID; unsupported requests are rejected, never approved', async () => {
  const { runtime:r,replies }=fixture();
  r.request({id:7,method:'item/commandExecution/requestApproval',params:{threadId:id,turnId:'turn-1'}});
  assert.equal(replies.length,0);
  await assert.rejects(r.handle('thread-follower-file-approval-decision',{conversationId:id,requestId:7,decision:'accept'}));
  await r.handle('thread-follower-command-approval-decision',{conversationId:id,requestId:7,decision:'decline'});
  assert.deepEqual(replies,[[7,{decision:'decline'}]]);assert.equal(r.state.requests.length,0);
  await assert.rejects(r.handle('thread-follower-command-approval-decision',{conversationId:id,requestId:7,decision:'accept'}));
  r.request({id:9,method:'unknown/approval',params:{threadId:id}});
  assert.equal(replies[1].error.code,-32601);
});
test('interrupt and steer bind to active turn; active permission mutations are rejected', async () => {
  const {runtime:r,calls}=fixture();
  r.notify({method:'turn/started',params:{threadId:id,turn:{id:'turn-1',status:'inProgress'}}});
  await assert.rejects(r.handle('thread-follower-interrupt-turn',{conversationId:id,expectedTurnId:'old'}));
  await assert.rejects(r.handle('thread-follower-update-thread-settings',{conversationId:id,threadSettings:{}}));
  await r.handle('thread-follower-steer-turn',{conversationId:id,input:[{type:'text',text:'stop soon'}]});
  assert.equal(calls[0][1].expectedTurnId,'turn-1');
  await r.handle('thread-follower-interrupt-turn',{conversationId:id,expectedTurnId:'turn-1'});
  assert.deepEqual(calls[1],['turn/interrupt',{threadId:id,turnId:'turn-1'}]);
});
test('owner protocol rejects wrong thread, host and version and supplies fresh reconnect snapshots', async () => {
  const {runtime:r}=fixture();const ipc=new BackgroundIPC({threadId:id,snapshot:()=>r.snapshot(),handle:r.handle});
  const sent=[];ipc.send=m=>sent.push(m);
  assert.equal(ipc.accepts({method:'thread-owner-discovery',version:1,params:{conversationId:id,hostId:'local'}}),true);
  for(const q of [{method:'thread-owner-discovery',version:0,params:{conversationId:id}}, {method:'thread-owner-discovery',version:1,params:{conversationId:'other'}}, {method:'thread-owner-discovery',version:1,params:{conversationId:id,hostId:'remote'}}]) assert.equal(ipc.accepts(q),false);
  const follow={type:'broadcast',method:'thread-stream-following-changed',version:1,sourceClientId:'desktop',params:{hostId:'local',conversationId:id,following:true}};
  await ipc.receive(follow);r.state.title='Fresh';r.revision++;
  await ipc.receive(follow);assert.equal(sent.at(-1).params.change.conversationState.title,'Fresh');
  await ipc.receive({...follow,params:{...follow.params,following:false}});assert.equal(ipc.followers.size,0);
});
test('default create route never opens desktop; repeated requests start exactly one detached worker', async t => {
  const root=await mkdtemp('/tmp/mcd-background-'); t.after(()=>rm(root,{recursive:true,force:true}));
  const args={requestId:'background-create-1',prompt:'private prompt',cwd:root};let launches=0;
  const create=createBackground({stateDirectory:root,resolve:async()=>({cwd:root,projectId:null}),launch:async path=>{
    launches++;const input=JSON.parse(await readFile(path));assert.equal(input.args.prompt,args.prompt);
    const store=new Operations(join(root,'background'));let op=await store.read(args.requestId);
    await store.save(args.requestId,{...op,accepted:true,phase:'accepted',threadId:id,turnId:'turn-1'});
  }});
  const flow=createFlows({stateDirectory:root,backgroundCreate:create,openThread:()=>{throw Error('Must not navigate');}});
  const a=await flow('create',args),b=await flow('create',args);
  assert.equal(a.accepted,true);assert.equal(b.threadId,id);assert.equal(launches,1);
  await assert.rejects(flow('create',{...args,prompt:'other'}),{code:'REQUEST_ID_CONFLICT'});
});
test('offline completion fallback matches exact turn and does not turn missing/running into success', async t => {
  const root=await mkdtemp('/tmp/mcd-terminal-');t.after(()=>rm(root,{recursive:true,force:true}));
  await privateDirectory(join(root,'background'));
  const path=join(root,'background',`thread-${id}.json`);
  await atomicJSON(path,{threadId:id,turnId:'turn-1',status:'inProgress'});assert.equal(await terminalBackgroundState(root,id,'turn-1'),null);
  await atomicJSON(path,{threadId:id,turnId:'turn-1',status:'completed'});assert.equal(await terminalBackgroundState(root,id,'other'),null);
  let completed;const done=new Promise(resolve=>completed=resolve);
  const store={data:{tasks:{one:{key:'one',threadId:id,turnId:'turn-1'}}},complete:async(key,s)=>{assert.equal(s.status,'completed');return true;}};
  const monitor=new CompletionMonitor({store,stateDirectory:root,desktopFactory:()=>({connect:async()=>{throw Error('offline');},close(){}}),onEvent:completed});
  t.after(()=>monitor.close());monitor.refresh();await done;
});

test('optional pin is forwarded once and participates in durable request identity', async t => {
  const root = await mkdtemp('/tmp/mcd-pin-'); t.after(() => rm(root, { recursive: true, force: true }));
  let launches = 0;
  const args = { requestId: 'optional-pin-create', prompt: 'test', cwd: root, pin: true };
  const create = createBackground({ stateDirectory: root, resolve: async () => ({ cwd: root, projectId: null }), launch: async path => {
    launches++;
    assert.equal(JSON.parse(await readFile(path)).args.pin, true);
    const store = new Operations(join(root, 'background'));
    await store.save(args.requestId, { ...await store.read(args.requestId), accepted: true, phase: 'accepted', threadId: id, pinConfirmed: true });
  } });
  assert.equal((await create(args)).pinConfirmed, true);
  await create(args); assert.equal(launches, 1);
  await assert.rejects(create({ ...args, pin: false }), { code: 'REQUEST_ID_CONFLICT' });
  await assert.rejects(create({ ...args, pin: 'true' }), { code: 'INVALID_ARGUMENT' });
});

test('subagent items expose desktop receiver threads on start and completion without changing wire data', () => {
  const { runtime } = fixture();
  runtime.notify({ method: 'turn/started', params: { threadId: id, turn: { id: 'turn-1', status: 'inProgress' } } });
  const child = '01900000-0000-7000-8000-000000000002';
  const wire = { type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', status: 'inProgress',
    senderThreadId: id, receiverThreadIds: [child], agentsStates: { [child]: { status: 'running', message: null } } };
  for (const method of ['item/started', 'item/completed']) {
    const item = { ...wire, status: method === 'item/completed' ? 'completed' : 'inProgress' };
    runtime.notify({ method, params: { threadId: id, turnId: 'turn-1', item } });
    const rendered = runtime.snapshot().state.turns[0].items[0];
    // Desktop subagent rendering iterates receiverThreads, not receiverThreadIds.
    assert.deepEqual(rendered.receiverThreads.map(receiver => [receiver.threadId, receiver.thread]), [[child, null]]);
    assert.equal(rendered.status, item.status);
    assert.equal(Object.hasOwn(item, 'receiverThreads'), false);
    assert.equal(runtime.state.turns[0].items.length, 1);
  }
  runtime.notify({ method: 'item/completed', params: { threadId: id, turnId: 'turn-1',
    item: { ...wire, id: 'wait-empty', tool: 'wait', receiverThreadIds: [] } } });
  assert.deepEqual(runtime.state.turns[0].items[1].receiverThreads, []);
});
