#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: claude-codex [--resume UUID] [Claude options]\nStarts Claude with Codex completion notifications. Confirm the development-channel dialog.\nResume using the printed UUID to recover pending notifications.'); process.exit(0);
}
if (args.some(a => ['-p','--print','-c','--continue','--session-id','--fork-session','--mcp-config','--channels','--dangerously-load-development-channels','--bg','--background'].includes(a.split('=')[0]) || a.startsWith('--resume=') || a.startsWith('--session-id='))) throw new Error('Use an interactive session; the launcher manages session identity and channel configuration. Use --resume UUID.');
const index = args.findIndex(a => a === '--resume' || a === '-r');
const id = index < 0 ? randomUUID() : args[index + 1];
if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id ?? '')) throw new Error('--resume requires an exact session UUID.');
const config = { mcpServers: { 'codex-completion': { command: process.execPath,
  args: [fileURLToPath(new URL('./channel.js', import.meta.url))], env: { MAGPIE_CODEX_CHANNEL_ID: id } } } };
console.error(`Codex completion session: ${id}\nResume: claude-codex --resume ${id}`);
if (index >= 0) args.splice(index, 2);
const child = spawn('claude', ['--mcp-config', JSON.stringify(config),
  '--dangerously-load-development-channels', 'server:codex-completion',
  index < 0 ? '--session-id' : '--resume', id, ...args], { stdio: 'inherit' });
child.on('error', () => { console.error('Could not start Claude Code.'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
