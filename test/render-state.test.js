import test from 'node:test';
import assert from 'node:assert/strict';
import { renderItem, renderConversation } from '../src/background-state.js';
import { BackgroundIPC } from '../src/background-ipc.js';

const raw = { type: 'collabAgentToolCall', id: 'old-spawn', tool: 'spawnAgent', receiverThreadIds: ['child-1'] };
const ready = { ...raw, id: 'new-spawn', receiverThreads: [{ threadId: 'child-1', thread: { agentNickname: 'Existing child', source: 'subagent' } }] };
const source = () => ({ id: 'parent', turns: [{ turnId: 'live', items: [raw, ready] }],
  turnHistory: { history: { ids: ['past'], entitiesByKey: { past: { turnId: 'past', items: [raw] } } }, other: 'preserved' } });

test('mixed historical/live snapshots normalize without mutating originals or dropping child metadata', () => {
  const original = source(), copy = structuredClone(original), state = renderConversation(original);
  assert.deepEqual(original, copy);
  for (const turn of [...state.turns, ...Object.values(state.turnHistory.history.entitiesByKey)]) {
    for (const item of turn.items) assert.doesNotThrow(() => new Map(item.receiverThreads.map(r => [r.threadId, r.thread])));
  }
  assert.equal(state.turns[0].items[1], ready);
  assert.equal(state.turns[0].items[1].receiverThreads[0].thread.agentNickname, 'Existing child');
  assert.equal(state.turnHistory.history.ids, original.turnHistory.history.ids);
  assert.equal(renderConversation(state), state);
});

test('outbound IPC normalizes a legacy provider on initial publish and repeated follower snapshots', () => {
  const original = source(), sent = [];
  const ipc = new BackgroundIPC({ threadId: 'parent', snapshot: () => ({ state: original, revision: 17 }) });
  ipc.broadcast = (...args) => sent.push(args);
  ipc.publish(['desktop']); ipc.publish(['desktop']);
  assert.equal(sent.length, 2);
  for (const [, params] of sent) {
    assert.equal(params.change.revision, 17);
    assert.ok(params.change.conversationState.turnHistory.history.entitiesByKey.past.items[0].receiverThreads);
  }
  assert.equal(original.turns[0].items[0].receiverThreads, undefined);
});

test('malformed receiver IDs stop publication rather than shipping another crashing snapshot', () => {
  const bad = { ...raw, receiverThreadIds: null };
  const ipc = new BackgroundIPC({ threadId: 'parent', snapshot: () => ({ state: { turns: [{ items: [bad] }] } }) });
  let sent = false; ipc.broadcast = () => { sent = true; };
  assert.throws(() => ipc.publish(['desktop']), { code: 'INVALID_RENDER_STATE' }); assert.equal(sent, false);
  assert.throws(() => renderItem({ ...raw, receiverThreadIds: [null] }), { code: 'INVALID_RENDER_STATE' });
});

test('receiver order and null defaults are repaired while valid hydrated records survive', () => {
  const item = { ...raw, receiverThreadIds: ['child-2', 'child-1'], receiverThreads: [ready.receiverThreads[0], { threadId: 'child-2' }] };
  const result = renderItem(item);
  assert.deepEqual(result.receiverThreads.map(r => r.threadId), ['child-2', 'child-1']);
  assert.equal(result.receiverThreads[0].thread, null); assert.equal(result.receiverThreads[1], ready.receiverThreads[0]);
});
