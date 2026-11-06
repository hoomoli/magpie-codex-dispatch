import { conversationState, applyNotification } from './background-state.js';
import { DispatchError } from './errors.js';
const responses = {
  'thread-follower-command-approval-decision': 'item/commandExecution/requestApproval',
  'thread-follower-file-approval-decision': 'item/fileChange/requestApproval',
  'thread-follower-permissions-request-approval-response': 'item/permissions/requestApproval',
  'thread-follower-submit-user-input': 'item/tool/requestUserInput',
  'thread-follower-submit-mcp-server-elicitation-response': 'mcpServer/elicitation/request',
};
export class BackgroundRuntime {
  constructor({ rpc, publish = () => {}, onComplete = () => {}, onUnsupported = () => {} }) {
    Object.assign(this, { rpc, publish, onComplete, onUnsupported });
    this.revision = 0; this.input = []; this.requests = new Map(); this.mutation = Promise.resolve();
    this.handle = (method, params) => {
      return this.exclusive(() => this.command(method, params));
    };
    this.handle.supports = method => Object.hasOwn(responses, method) || ['thread-follower-start-turn',
      'thread-follower-steer-turn', 'thread-follower-interrupt-turn', 'thread-follower-update-thread-settings',
      'thread-follower-read-model-settings', 'thread-follower-load-complete-history'].includes(method);
  }
  initialize(result, title) { this.state = conversationState(result.thread, result, title); }
  exclusive(fn) {
    const result = this.mutation.then(fn);
    this.mutation = result.catch(() => {}); return result;
  }
  snapshot() { return { state: this.state, revision: this.revision }; }
  changed() { this.revision++; this.publish(this.snapshot()); }
  notify(m) {
    if (!this.state || !applyNotification(this.state, m, this.input)) return;
    if (m.method === 'serverRequest/resolved') {
      this.requests.delete(String(m.params.requestId));
      this.state.requests = this.state.requests.filter(r => String(r.id) !== String(m.params.requestId));
    }
    this.changed();
    if (m.method === 'turn/completed') {
      for (const [id, request] of this.requests) if (request.params.turnId === m.params.turn.id) this.requests.delete(id);
      this.onComplete(this.snapshot());
    }
  }
  request(m) {
    if (!this.state || m.params?.threadId !== this.state.id || !Object.values(responses).includes(m.method)) {
      // Unsupported requests must never silently authorize an action.
      this.rpc.input.write(JSON.stringify({ id: m.id, error: { code: -32601, message: 'Unsupported background request; no action approved.' } }) + '\n');
      this.onUnsupported(m.method); return;
    }
    this.requests.set(String(m.id), m); this.state.requests.push(m); this.changed();
  }
  idle() {
    if (this.state.threadRuntimeStatus?.type !== 'idle' || this.state.requests.length || this.state.turns.at(-1)?.status === 'inProgress')
      throw new DispatchError('THREAD_NOT_IDLE', 'The background thread is not idle.');
  }
  async start(request) {
    if (this.lifecycleBlocked) throw new DispatchError('OWNER_CLOSING', 'A lifecycle operation blocks further execution. Inspect its receipt.');
    this.idle();
    if (request.threadId !== this.state.id || !Array.isArray(request.input)) throw Error('Invalid turn target');
    this.input = request.input;
    return this.rpc.request('turn/start', request);
  }
  async command(method, p) {
    if (p.conversationId !== this.state.id) throw Error('Wrong thread');
    if (this.lifecycleBlocked && method !== 'thread-follower-load-complete-history' && method !== 'thread-follower-read-model-settings')
      throw new DispatchError('OWNER_CLOSING', 'A lifecycle operation blocks mutations. Inspect its receipt.');
    if (Object.hasOwn(responses, method)) {
      const pending = this.requests.get(String(p.requestId));
      if (!pending || pending.method !== responses[method]) throw Error('Approval/request no longer pending');
      const result = Object.hasOwn(p, 'decision') ? { decision: p.decision } : p.response;
      if (!result || typeof result !== 'object') throw Error('Missing response');
      this.rpc.respond(pending.id, result); this.requests.delete(String(p.requestId));
      this.state.requests = this.state.requests.filter(r => r.id !== pending.id); this.changed(); return { ok: true };
    }
    if (method === 'thread-follower-start-turn') return { result: await this.start(p.turnStart.request) };
    if (method === 'thread-follower-read-model-settings') return { settings: { model: this.state.latestModel,
      reasoningEffort: this.state.latestReasoningEffort, resumeState: this.state.resumeState, modelProvider: this.state.modelProvider } };
    if (method === 'thread-follower-load-complete-history') { this.changed(); return { revision: this.revision }; }
    if (method === 'thread-follower-update-thread-settings') {
      this.idle(); if (p.activeTurnId) throw Error('Active permission changes are unsupported');
      // Resume the same owned thread to obtain the effective next-turn permissions.
      const result = await this.rpc.request('thread/resume', { threadId: this.state.id, ...p.threadSettings });
      const fresh = conversationState(result.thread, result, this.state.title);
      this.state.currentPermissions = fresh.currentPermissions; this.state.latestThreadSettings = {};
      this.changed(); return { applied: true };
    }
    const turn = this.state.turns.at(-1);
    if (!turn || turn.status !== 'inProgress') throw Error('No active turn');
    if (method === 'thread-follower-steer-turn') return { result: await this.rpc.request('turn/steer', {
      threadId: this.state.id, expectedTurnId: turn.turnId, input: p.input }) };
    if (method === 'thread-follower-interrupt-turn') {
      if (p.expectedTurnId !== turn.turnId) throw Error('Turn changed');
      await this.rpc.request('turn/interrupt', { threadId: this.state.id, turnId: p.expectedTurnId });
      return { ok: true, interruptedTurnId: turn.turnId };
    }
    throw Error('Unsupported command');
  }
}
