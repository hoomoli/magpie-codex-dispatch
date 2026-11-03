#!/usr/bin/env node
import { readFile, lstat, mkdir, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { pluginVersion } from './version.js';

export function configuration(settings, config, directory, node = process.execPath) {
  const next = structuredClone(settings), mcp = structuredClone(config);
  const hook = join(directory, 'desktop-hook.js');
  const matcher = '^mcp__.*(?:magpie|codex-dispatch).*codex_(dispatch|create_task|followup)$';
  next.hooks ??= {};
  for (const event of ['PreToolUse', 'PostToolUse', 'SessionStart']) {
    const groups = next.hooks[event] ?? [];
    next.hooks[event] = groups.map(group => ({ ...group, hooks: group.hooks.filter(h => !h.args?.some(a => a === hook)) })).filter(group => group.hooks.length);
    next.hooks[event].push({ ...(event === 'SessionStart' ? {} : { matcher: event === 'PostToolUse' ? `${matcher}|^mcp__codex-notifications__codex_review_complete$` : matcher }), hooks: [{ type: 'command', command: node, args: [hook], timeout: event === 'PreToolUse' ? 15 : 86400, ...(event === 'PreToolUse' ? { onFailure: 'block' } : { asyncRewake: true }) }] });
  }
  mcp.mcpServers ??= {};
  const previous = mcp.mcpServers['codex-notifications'];
  const server = join(directory, 'notifications.js');
  if (previous && !previous.args?.includes(server)) throw new Error('An unrelated codex-notifications server already exists.');
  mcp.mcpServers['codex-notifications'] = { type: 'stdio', command: node, args: [server] };
  return { settings: next, config: mcp };
}
async function read(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error('Unsafe configuration file.');
    const text = await readFile(path, 'utf8');
    return { text, value: JSON.parse(text) };
  } catch (error) { if (error.code === 'ENOENT') return { text: null, value: {} }; throw error; }
}
export async function install(home = homedir(), directory = dirname(fileURLToPath(import.meta.url))) {
  const paths = [join(home, '.claude', 'settings.json'), join(home, '.claude.json')];
  const original = await Promise.all(paths.map(read));
  const next = configuration(original[0].value, original[1].value, directory);
  const texts = [next.settings, next.config].map(v => JSON.stringify(v, null, 2) + '\n');
  const backups = [];
  for (let i = 0; i < paths.length; i++) {
    if (texts[i] === original[i].text) continue;
    await mkdir(dirname(paths[i]), { recursive: true, mode: 0o700 });
    if (original[i].text !== null) {
      const backup = `${paths[i]}.codex-notifications-${randomUUID()}.bak`;
      await writeFile(backup, original[i].text, { flag: 'wx', mode: 0o600 }); backups.push(backup);
    }
    // Refuse to overwrite edits made while configuration was being prepared.
    if ((await read(paths[i])).text !== original[i].text) throw new Error('Configuration changed during installation. Retry.');
    const temp = `${paths[i]}.${randomUUID()}.tmp`;
    await writeFile(temp, texts[i], { flag: 'wx', mode: 0o600 });
    await rename(temp, paths[i]);
  }
  return { pluginVersion, paths, backups };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  install().then(result => console.log(JSON.stringify(result, null, 2))).catch(() => { console.error('Desktop hook installation failed; existing configuration was preserved where possible.'); process.exitCode = 1; });
}
