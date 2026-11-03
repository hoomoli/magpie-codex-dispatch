import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workerSocket, connectSocket, wire } from './channel-wire.js';
import { routeDirectory } from './channel-store.js';

export async function workerRequest(sessionId, method, args = {}, { timeoutMs = 8000 } = {}) {
  const path = await workerSocket(routeDirectory(sessionId));
  let socket;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { socket = await connectSocket(path); break; }
    catch {
      if (attempt === 0) {
        const env = { ...process.env };
        // Hook-exported session credentials are never forwarded or persisted.
        delete env.CLAUDE_CODE_MESSAGING_TOKEN;
        const child = spawn(process.execPath, [fileURLToPath(new URL('./channel-worker.js', import.meta.url)), sessionId], { detached: true, stdio: 'ignore', env });
        child.on('error', () => {}); child.unref();
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  if (!socket) throw new Error('Notification worker unavailable; no notification binding was confirmed.');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Notification worker timed out.')), timeoutMs);
    const send = wire(socket, msg => {
      if (msg.id !== 1) return;
      finish(msg.error ? new Error(msg.error) : null, msg.result);
    });
    socket.on('close', () => finish(new Error('Notification worker disconnected; saved work can be recovered.')));
    send({ id: 1, method, args });
  });
}
