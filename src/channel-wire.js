import net from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hash, privateDirectory } from './channel-store.js';

export async function workerSocket(directory) {
  const parent = join(tmpdir(), `mcd-channel-${process.getuid()}`);
  await privateDirectory(parent);
  return join(parent, `${hash(directory).slice(0,24)}.sock`);
}
export function wire(socket, receive) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('error', () => {});
  socket.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 1024 * 1024) { socket.destroy(); return; }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try { receive(JSON.parse(line)); } catch { socket.destroy(); return; }
    }
  });
  return message => {
    if (socket.destroyed || socket.writableLength > 1024 * 1024) { socket.destroy(); return; }
    socket.write(JSON.stringify(message) + '\n');
  };
}
export function connectSocket(path) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    socket.once('error', reject); socket.once('connect', () => { socket.removeListener('error', reject); resolve(socket); });
    socket.setTimeout(2000, () => socket.destroy(new Error('Connection timed out.')));
    socket.once('connect', () => socket.setTimeout(0));
  });
}
