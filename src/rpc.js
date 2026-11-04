import net from 'node:net';
import { spawn } from 'node:child_process';
import { access, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { DispatchError } from './desktop.js';
import { pluginVersion } from './version.js';

const MAX_BYTES = 32 * 1024 * 1024;
const ALLOWED = new Set(['initialize', 'project/list', 'project/read', 'thread/start', 'thread/read',
  'thread/list', 'thread/name/set', 'thread/unsubscribe', 'thread/loaded/list']);

export async function resolveBinary(explicit = process.env.MAGPIE_CODEX_BINARY) {
  const paths = explicit ? [explicit] : [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
  ];
  for (const path of paths) {
    if (!isAbsolute(path)) throw new DispatchError('INVALID_BINARY', 'The Codex binary path must be absolute.');
    try { await access(path, 1); return path; } catch { /* Try the next installed app. */ }
  }
  throw new DispatchError('BINARY_UNAVAILABLE', 'Set MAGPIE_CODEX_BINARY to the absolute path of the Codex CLI shipped with the desktop app.');
}

export class AppServer {
  constructor({ signal, timeoutMs = 8000, execution = false, onNotification, onRequest, onFailure } = {}) {
    Object.assign(this, { execution, onNotification, onRequest, onFailure });
    this.signal = signal; this.timeoutMs = timeoutMs; this.pending = new Map(); this.buffer = ''; this.next = 0;
    this.onAbort = () => this.fail(new DispatchError('ABORTED', 'The caller cancelled the operation.'));
  }
  attach(input, output) {
    this.input = input;
    output.setEncoding('utf8');
    output.on('data', chunk => {
      try {
        this.buffer += chunk;
        if (Buffer.byteLength(this.buffer) > MAX_BYTES) throw new Error('Frame limit');
        let index;
        while ((index = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.method) {
            if (message.id !== undefined) this.onRequest?.(message);
            else this.onNotification?.(message);
            continue;
          }
          const waiter = this.pending.get(message.id);
          if (!waiter) continue;
          clearTimeout(waiter.timer); this.pending.delete(message.id);
          if (message.error) {
            // Companion 1.0.6 rejects this exact error before forwarding the RPC.
            // A generic error containing "busy" is not proof of non-delivery.
            const notSubmitted = this.companion && message.error.code === -32001 && message.error.message === 'Shared Codex broker is busy.';
            const error = new DispatchError(notSubmitted ? 'SOURCE_BUSY' : 'RPC_REJECTED',
              notSubmitted ? 'The source broker is busy; no takeover was attempted.' : 'The app-server rejected the request. Check version compatibility and the target thread.');
            if (notSubmitted) error.delivery = 'not-submitted';
            waiter.reject(error);
          } else waiter.resolve(message.result);
        }
      } catch { this.fail(new DispatchError('INVALID_RPC_RESPONSE', 'Invalid or oversized app-server response.')); }
    });
    output.on('end', () => this.fail(new DispatchError('RPC_CLOSED', 'The app-server connection closed.')));
    output.on('error', () => this.fail(new DispatchError('RPC_CLOSED', 'The app-server connection failed.')));
    input.on('error', () => this.fail(new DispatchError('RPC_CLOSED', 'The app-server connection failed.')));
    this.signal?.addEventListener('abort', this.onAbort, { once: true });
    if (this.signal?.aborted) this.onAbort();
  }
  async start({ binary, cwd = homedir() } = {}) {
    binary = await resolveBinary(binary);
    this.child = spawn(binary, ['app-server', '--listen', 'stdio://'], { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    this.exited = new Promise(resolve => {
      this.child.once('exit', (code, signal) => resolve({ code, signal }));
      this.child.once('error', () => { this.fail(new DispatchError('CREATOR_START_FAILED', 'Could not start the temporary app-server.')); resolve({ code: -1 }); });
    });
    this.attach(this.child.stdin, this.child.stdout);
    await this.initialize(true);
    return this;
  }
  async connectCompanion(endpoint) {
    if (typeof endpoint !== 'string' || !endpoint.startsWith('unix:')) throw new DispatchError('INVALID_SOURCE', 'A local companion unix: endpoint is required.');
    const path = endpoint.slice(5);
    if (!isAbsolute(path)) throw new DispatchError('INVALID_SOURCE', 'The source socket path must be absolute.');
    const stat = await lstat(path).catch(() => null);
    if (!stat?.isSocket() || stat.uid !== process.getuid()) throw new DispatchError('INVALID_SOURCE', 'The source socket must belong to the current user.');
    this.socket = net.createConnection(path);
    this.attach(this.socket, this.socket);
    const result = await this.initialize(false);
    if (result?.userAgent !== 'codex-companion-broker') throw new DispatchError('UNSUPPORTED_SOURCE', 'Only the verified Codex Companion broker protocol is supported.');
    this.companion = true;
    return this;
  }
  async initialize(experimentalApi) {
    const result = await this.request('initialize', { clientInfo: { name: 'magpie_codex_dispatch', version: pluginVersion }, capabilities: { experimentalApi } });
    this.input.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    return result;
  }
  request(method, params = {}) {
    if (!ALLOWED.has(method) && !(this.execution && !this.companion && new Set(['thread/archive', 'thread/unarchive', 'thread/resume', 'thread/settings/update', 'turn/start', 'turn/steer', 'turn/interrupt']).has(method))) return Promise.reject(new DispatchError('UNSUPPORTED_METHOD', 'This temporary client cannot execute turns or arbitrary commands.'));
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new DispatchError('RPC_TIMEOUT', 'App-server request timed out.')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.input.write(JSON.stringify({ id, method, params }) + '\n'); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new DispatchError('RPC_CLOSED', 'App-server input is unavailable.')); }
    });
  }
  respond(id, result) {
    if (this.failure) throw this.failure;
    this.input.write(JSON.stringify({ id, result }) + "\n");
  }
  fail(error) {
    const first = !this.failure;
    this.failure ??= error;
    if (first) this.onFailure?.(error);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(this.failure); }
    this.pending.clear();
  }
  async close() {
    this.signal?.removeEventListener('abort', this.onAbort);
    this.fail(new DispatchError('RPC_CLOSED', 'App-server client closed.'));
    this.socket?.destroy();
    if (!this.child) return { exited: true };
    this.child.stdin.end();
    const wait = ms => new Promise(resolve => { const timer = setTimeout(() => resolve(null), ms); this.exited.then(value => { clearTimeout(timer); resolve(value); }); });
    let result = await wait(2000);
    if (!result) { this.child.kill('SIGTERM'); result = await wait(2000); }
    if (!result) { this.child.kill('SIGKILL'); result = await wait(2000); }
    if (!result) throw new DispatchError('CREATOR_STILL_RUNNING', 'The temporary creator has not exited. Desktop takeover was not attempted.');
    return { exited: true, ...result };
  }
}

export async function withServer(options, fn) {
  const client = new AppServer(options);
  try { await client.start(options); return await fn(client); }
  finally { await client.close(); }
}

export const codexHome = () => process.env.CODEX_HOME || join(homedir(), '.codex');
