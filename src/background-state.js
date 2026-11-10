// Render state is distinct from AppServer wire state. Never omit turn input.
import { DispatchError } from './errors.js';

export function renderItem(item) {
  if (item.type !== 'collabAgentToolCall') return item;
  if (!Array.isArray(item.receiverThreadIds) || !item.receiverThreadIds.every(id => typeof id === 'string')) {
    throw new DispatchError('INVALID_RENDER_STATE', 'A subagent item has invalid receiver IDs; no desktop snapshot was sent.');
  }
  const old = Array.isArray(item.receiverThreads) ? item.receiverThreads : [];
  const receivers = new Map(old.filter(r => r && typeof r.threadId === 'string').map(r => [r.threadId, r]));
  const receiverThreads = item.receiverThreadIds.map(threadId => {
    const receiver = receivers.get(threadId);
    return receiver && Object.hasOwn(receiver, 'thread') ? receiver : { ...receiver, threadId, thread: null };
  });
  if (Array.isArray(item.receiverThreads) && old.length === receiverThreads.length && receiverThreads.every((r, i) => r === old[i])) return item;
  return { ...item, receiverThreads };
}

// Repair old live and paginated items at the outgoing boundary, including retransmission/handoff.
// Copy only changed containers. Never rewrite persisted transcripts or erase hydrated child metadata.
export function renderConversation(state) {
  const renderTurn = turn => {
    if (!Array.isArray(turn?.items)) return turn;
    const items = turn.items.map(renderItem);
    return items.some((item, i) => item !== turn.items[i]) ? { ...turn, items } : turn;
  };
  let result = state;
  if (Array.isArray(state.turns)) {
    const turns = state.turns.map(renderTurn);
    if (turns.some((turn, i) => turn !== state.turns[i])) result = { ...result, turns };
  }
  const history = state.turnHistory?.history;
  if (history?.entitiesByKey) {
    let changed = false;
    const entitiesByKey = Object.fromEntries(Object.entries(history.entitiesByKey).map(([key, turn]) => {
      const rendered = renderTurn(turn); if (rendered !== turn) changed = true; return [key, rendered];
    }));
    if (changed) result = { ...result, turnHistory: { ...state.turnHistory, history: { ...history, entitiesByKey } } };
  }
  return result;
}

export function conversationState(thread, settings, title) {
  return { id: thread.id, hostId: 'local', forkedFromId: null, parentThreadId: null,
    turns: [], requests: [], createdAt: thread.createdAt * 1000, updatedAt: thread.updatedAt * 1000,
    title, mode: 'default', threadStartKind: 'default', modelProvider: thread.modelProvider,
    latestModel: settings.model ?? thread.model ?? '', latestReasoningEffort: settings.reasoningEffort ?? null,
    previousTurnModel: null, latestCollaborationMode: { mode: 'default', settings: {
      developer_instructions: null, model: settings.model ?? thread.model ?? '', reasoning_effort: settings.reasoningEffort ?? null } },
    hasUnreadTurn: true, threadGoal: null, threadRuntimeStatus: thread.status,
    rolloutPath: thread.path, gitInfo: thread.gitInfo, resumeState: 'resumed', latestTokenUsageInfo: null,
    workspaceKind: 'project', cwd: thread.cwd, environments: thread.environments,
    currentPermissions: { approvalPolicy: settings.approvalPolicy, approvalsReviewer: settings.approvalsReviewer,
      sandboxPolicy: settings.sandbox, activePermissionProfile: settings.activePermissionProfile },
    latestThreadSettings: {}, turnsPagination: { olderCursor: null, oldestLoadedTurnId: null, isLoadingOlder: false, hasLoadedOldest: true } };
}
export function applyNotification(state, message, input = []) {
  const p = message.params ?? {};
  if ((p.threadId ?? p.thread?.id) !== state.id) return false;
  let turn = state.turns.find(t => t.turnId === (p.turnId ?? p.turn?.id));
  if (message.method === 'turn/started' && !turn) {
    turn = { turnId: p.turn.id, rootTurnId: p.turn.rootTurnId, status: p.turn.status, error: null,
      items: [], completedItemIds: [], turnStartedAtMs: Date.now(), durationMs: null,
      params: { threadId: state.id, input, attachments: [], model: state.latestModel, cwd: state.cwd,
        effort: state.latestReasoningEffort, ...state.currentPermissions } };
    state.turns.push(turn);
  }
  if (message.method === 'thread/status/changed') state.threadRuntimeStatus = p.status;
  if (turn && ['item/started', 'item/completed'].includes(message.method)) {
    const rendered = renderItem(p.item);
    const index = turn.items.findIndex(i => i.id === p.item.id);
    if (index < 0) turn.items.push(rendered); else turn.items[index] = rendered;
    if (message.method === 'item/completed' && !turn.completedItemIds.includes(p.item.id)) turn.completedItemIds.push(p.item.id);
  }
  const item = turn?.items.find(i => i.id === p.itemId);
  if (item) {
    if (message.method === 'item/agentMessage/delta' || message.method === 'item/plan/delta') item.text = (item.text ?? '') + p.delta;
    if (message.method === 'item/commandExecution/outputDelta') item.aggregatedOutput = (item.aggregatedOutput ?? '') + p.delta;
    if (message.method === 'item/reasoning/summaryTextDelta') { item.summary ??= []; item.summary[p.summaryIndex] = (item.summary[p.summaryIndex] ?? '') + p.delta; }
    if (message.method === 'item/reasoning/textDelta') { item.content ??= []; item.content[p.contentIndex] = (item.content[p.contentIndex] ?? '') + p.delta; }
  }
  if (message.method === 'turn/completed' && turn) {
    turn.status = p.turn.status; turn.error = p.turn.error; turn.durationMs = p.turn.durationMs;
    state.requests = state.requests.filter(r => r.params.turnId !== turn.turnId);
    state.threadRuntimeStatus = { type: 'idle' };
  }
  return true;
}
