import { hash } from './channel-store.js';

export const finalizationProperties = {
  eventId: { type: 'string', minLength: 1 },
  mergeStatus: { type: 'string', enum: ['pending', 'completed', 'not_required'] },
  mainValidationStatus: { type: 'string', enum: ['pending', 'passed', 'not_required'] },
  followupRequired: { type: 'boolean' },
  keep: { type: 'boolean', description: 'True when the user requires retaining this conversation.' },
  evidence: { type: 'string', minLength: 1, maxLength: 8000, description: 'Actual merge/validation evidence or why they are not required; include outstanding work and user retention instructions.' },
};
export const finalizationDescription = 'Record task closure after review and any authorized merge/main-branch validation. Automatically archives only a passed, fully finished task with no follow-up or user retention request. Pending/failed/retained tasks stay available. Never bypass ownership or retry an unknown archive with a new ID.';

function eventTasks(store, eventId) {
  if (typeof eventId !== 'string' || !eventId) throw new Error('FINALIZATION_INVALID: A completion eventId is required.');
  const tasks = Object.values(store.data.tasks).filter(t => t.event?.eventId === eventId);
  if (!tasks.length) throw new Error('FINALIZATION_INVALID: Event does not belong to this Claude session.');
  return tasks;
}

export function createTaskFinalizer({ store, sessionId, readLatest, archive, readArchive = async () => null }) {
  let queue = Promise.resolve();
  const save = (eventId, value) => store.change(data => {
    for (const task of Object.values(data.tasks)) if (task.event?.eventId === eventId) task.finalization = value;
    return value;
  });
  async function submit(eventId, intent) {
    try {
      const receipt = await archive({ threadId: intent.threadId, requestId: intent.requestId, expectedTurnId: intent.turnId });
      const phase = receipt.completed === true && receipt.serverAcknowledged === true ? 'archived'
        : receipt.phase === 'owner_action_required' ? 'owner_action_required'
          : receipt.submitted === false || receipt.serverRejected === true ? 'blocked' : 'outcome_unknown';
      return await save(eventId, { ...intent, phase, receipt, updatedAt: new Date().toISOString() });
    } catch (error) {
      // The lifecycle journal owns submission/replay safety. Never manufacture a replacement ID.
      const blocked = ['THREAD_ACTIVE', 'TURN_CHANGED', 'OWNER_UPGRADE_REQUIRED', 'BUSY', 'OPERATION_BUSY', 'DESCENDANT_HELD', 'OWNER_CHANGED', 'SCOPE_CHANGED'].includes(error.code);
      return save(eventId, { ...intent, phase: blocked ? 'blocked' : 'outcome_unknown', errorCode: error.code ?? 'ARCHIVE_UNCONFIRMED', updatedAt: new Date().toISOString() });
    }
  }
  async function finalize(args) {
    const tasks = eventTasks(store, args.eventId), task = tasks[0];
    if (!['pending', 'completed', 'not_required'].includes(args.mergeStatus) ||
        !['pending', 'passed', 'not_required'].includes(args.mainValidationStatus) ||
        typeof args.followupRequired !== 'boolean' || typeof args.keep !== 'boolean' ||
        typeof args.evidence !== 'string' || !args.evidence.trim() || args.evidence.length > 8000) {
      throw new Error('FINALIZATION_INVALID: Explicit merge, main validation, follow-up, retention and factual evidence are required.');
    }
    // Once intent is durable, changing flags cannot undo a possibly submitted archive.
    const old = task.finalization;
    if (old?.phase === 'archiving') return submit(args.eventId, old);
    if (old?.phase === 'archived') return old;
    if (old?.phase === 'outcome_unknown') {
      const receipt = await readArchive(old.requestId).catch(() => null);
      if (receipt?.completed === true && receipt.serverAcknowledged === true) {
        return save(args.eventId, { ...old, phase: 'archived', receipt, updatedAt: new Date().toISOString() });
      }
      return old;
    }
    const reasons = [];
    if (!task.review || task.review.verdict !== 'passed' || !task.resultRead || task.event.status !== 'completed' || task.event.hasError || task.resultRead.hasError) reasons.push('review_not_passed');
    if (args.mergeStatus === 'pending') reasons.push('merge_pending');
    if (args.mainValidationStatus === 'pending') reasons.push('main_validation_pending');
    if (args.followupRequired) reasons.push('followup_required');
    if (args.keep) reasons.push('user_requested_retention');
    const value = { ...args, threadId: task.threadId, turnId: task.turnId,
      requestId: `finalize_${hash(`${sessionId}:${args.eventId}`)}`, updatedAt: new Date().toISOString() };
    if (reasons.length) return save(args.eventId, { ...value, phase: 'retained', reasons });
    const latest = await readLatest(task.threadId);
    if (latest.threadId !== task.threadId || latest.turnId !== task.turnId || latest.turnFound !== true ||
        latest.status !== 'completed' || latest.hasError ||
        !(latest.runtimeStatus === 'idle' && latest.pendingRequests === 0 || latest.historyOnly === true && latest.runtimeStatus === 'notLoaded')) {
      return save(args.eventId, { ...value, phase: 'retained', reasons: ['thread_changed_or_not_idle'] });
    }
    const intent = await save(args.eventId, { ...value, phase: 'archiving' });
    return submit(args.eventId, intent);
  }
  function run(args) {
    const result = queue.then(() => finalize(args)); queue = result.catch(() => {}); return result;
  }
  run.recover = async () => {
    const seen = new Set();
    for (const task of Object.values(store.data.tasks)) {
      if (task.finalization?.phase !== 'archiving' || seen.has(task.event.eventId)) continue;
      seen.add(task.event.eventId);
      await run(task.finalization);
    }
  };
  return run;
}
