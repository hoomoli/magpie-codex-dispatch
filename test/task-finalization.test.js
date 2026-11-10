import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { ChannelStore } from '../src/channel-store.js';
import { createTaskFinalizer } from '../src/task-finalization.js';

const threadId = '01900000-0000-7000-8000-000000000001', turnId = 'reviewed-turn';
async function fixture(t, status = 'completed') {
  const root = await mkdtemp('/tmp/mcd-finalize-'); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ChannelStore(root); await store.init();
  const key = await store.register('codex_dispatch', { requestId: 'finalize-test-001', prompt: 'Task' });
  await store.accept(key, { accepted: true, threadId, turnId });
  const result = { threadId, turnId, turnFound: true, status, hasError: status === 'failed', runtimeStatus: 'idle', pendingRequests: 0 };
  await store.complete(key, result);
  const eventId = store.data.tasks[key].event.eventId;
  await store.resultRead(eventId, result);
  await store.review(eventId, status === 'completed' ? 'passed' : 'changes_requested', 'Checked actual changes and logs.');
  const calls = [];
  let latest = result;
  const archive = async args => { calls.push(args); return { phase: 'archived', completed: true, serverAcknowledged: true }; };
  const make = (options = {}) => createTaskFinalizer({ store, sessionId: 'session-1', readLatest: async () => latest, archive, ...options });
  const args = { eventId, mergeStatus: 'completed', mainValidationStatus: 'passed', followupRequired: false, keep: false, evidence: 'Merge and main validation logs checked.' };
  return { root, store, key, result, args, calls, make, setLatest: value => { latest = value; } };
}

test('fully accepted work archives once with an exact-turn guard and durable replay', async t => {
  const f = await fixture(t), finalize = f.make();
  const [a, b] = await Promise.all([finalize(f.args), finalize(f.args)]);
  assert.equal(a.phase, 'archived'); assert.equal(b.phase, 'archived'); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].expectedTurnId, turnId); assert.equal(f.calls[0].threadId, threadId);
  const recovered = new ChannelStore(f.root); await recovered.init();
  const retry = createTaskFinalizer({ store: recovered, sessionId: 'session-1', archive: async () => { throw Error('Must not resubmit'); } });
  assert.equal((await retry(f.args)).phase, 'archived');
});

for (const [patch, reason] of [
  [{ mergeStatus: 'pending' }, 'merge_pending'], [{ mainValidationStatus: 'pending' }, 'main_validation_pending'],
  [{ followupRequired: true }, 'followup_required'], [{ keep: true }, 'user_requested_retention'],
]) test(`retains ${reason} and permits closure after conditions actually change`, async t => {
  const f = await fixture(t), finalize = f.make();
  const kept = await finalize({ ...f.args, ...patch });
  assert.equal(kept.phase, 'retained'); assert.ok(kept.reasons.includes(reason)); assert.equal(f.calls.length, 0);
  assert.equal((await finalize(f.args)).phase, 'archived'); assert.equal(f.calls.length, 1);
});

for (const status of ['failed', 'interrupted']) test(`retains ${status} execution despite caller closure flags`, async t => {
  const f = await fixture(t, status);
  assert.ok((await f.make()(f.args)).reasons.includes('review_not_passed')); assert.equal(f.calls.length, 0);
});

test('missing review/result evidence, attention, malformed and foreign events never archive', async t => {
  const f = await fixture(t), finalize = f.make();
  await assert.rejects(finalize({ ...f.args, eventId: 'another-event' }), /FINALIZATION_INVALID/);
  await assert.rejects(finalize({ ...f.args, keep: undefined }), /FINALIZATION_INVALID/);
  await assert.rejects(finalize({ ...f.args, evidence: ' ' }), /FINALIZATION_INVALID/);
  await f.store.change(data => { delete data.tasks[f.key].resultRead; });
  assert.ok((await finalize(f.args)).reasons.includes('review_not_passed'));
  await f.store.change(data => { delete data.tasks[f.key].review; });
  assert.ok((await finalize(f.args)).reasons.includes('review_not_passed')); assert.equal(f.calls.length, 0);
});

test('later turns, activity, unknown state and pending input retain the conversation', async t => {
  const f = await fixture(t), finalize = f.make();
  for (const patch of [{ turnId: 'newer' }, { status: 'inProgress' }, { runtimeStatus: 'active' }, { pendingRequests: 1 }, { pendingRequests: null }, { hasError: true }, { turnFound: false }]) {
    f.setLatest({ ...f.result, ...patch });
    assert.deepEqual((await finalize(f.args)).reasons, ['thread_changed_or_not_idle']);
  }
  assert.equal(f.calls.length, 0);
});

test('not-required work is explicit, and writerless verified history can be finalized', async t => {
  const f = await fixture(t);
  f.setLatest({ ...f.result, historyOnly: true, runtimeStatus: 'notLoaded', pendingRequests: null });
  assert.equal((await f.make()({ ...f.args, mergeStatus: 'not_required', mainValidationStatus: 'not_required', evidence: 'Read-only diagnosis; no merge or branch validation needed.' })).phase, 'archived');
});

test('owner action, busy owners and uncertain outcomes stay visible without automatic loops', async t => {
  const f = await fixture(t);
  const blocked = f.make({ archive: async () => ({ phase: 'owner_action_required', submitted: false }) });
  assert.equal((await blocked(f.args)).phase, 'owner_action_required');
  const busy = f.make({ archive: async () => { throw Object.assign(Error('busy'), { code: 'TURN_CHANGED' }); } });
  assert.equal((await busy(f.args)).phase, 'blocked');
  let attempts = 0;
  const unknown = f.make({ archive: async () => { attempts++; throw Object.assign(Error('lost response'), { code: 'OUTCOME_UNKNOWN' }); } });
  assert.equal((await unknown(f.args)).phase, 'outcome_unknown');
  assert.equal((await unknown(f.args)).phase, 'outcome_unknown'); assert.equal(attempts, 1);
});

test('startup recovers only explicit durable closure intents using the original archive ID', async t => {
  const f = await fixture(t);
  const requestId = 'finalize-original-001';
  await f.store.change(data => { data.tasks[f.key].finalization = { ...f.args, threadId, turnId, requestId, phase: 'archiving' }; });
  await f.make().recover(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].requestId, requestId);
  await f.make().recover(); assert.equal(f.calls.length, 1);
});

test('a late durable archive ACK resolves uncertainty through a read, without another submission', async t => {
  const f = await fixture(t);
  let submissions = 0, lookup;
  const finalize = f.make({ archive: async () => { submissions++; throw Object.assign(Error('late'), { code: 'OUTCOME_UNKNOWN' }); },
    readArchive: async requestId => { lookup = requestId; return { completed: true, serverAcknowledged: true }; } });
  const unknown = await finalize(f.args); assert.equal(unknown.phase, 'outcome_unknown');
  assert.equal((await finalize(f.args)).phase, 'archived'); assert.equal(lookup, unknown.requestId); assert.equal(submissions, 1);
});
