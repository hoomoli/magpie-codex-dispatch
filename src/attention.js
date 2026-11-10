const approval = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval']);
const input = new Set(['item/tool/requestUserInput', 'mcpServer/elicitation/request']);

export function attentionRequests(state, turnId) {
  if (!turnId) return [];
  return (state.requests ?? []).filter(r => r.params?.turnId === turnId &&
    (approval.has(r.method) || input.has(r.method))).map(r => ({
    requestId: r.id, method: r.method, kind: approval.has(r.method) ? 'approval' : 'input',
    reason: r.params.reason ?? null, command: r.params.command ?? null,
    cwd: r.params.cwd ?? null,
  }));
}

// Only live pending events are delivered. Commands and reasons never enter the durable queue.
export function pendingTaskEvents(tasks) {
  const events = new Map();
  for (const event of tasks.flatMap(t => t.event ? (t.review ? [] : [t.event]) : t.attention ?? [])) {
    if (!events.has(event.eventId)) events.set(event.eventId, event);
  }
  return [...events.values()];
}
