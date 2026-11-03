import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const launcher = new URL('../src/claude-channel.js', import.meta.url).pathname;

test('launcher pins channel to new/resumed session, preserves prompt arguments and rejects detached/print overrides', async t => {
  const dir = await mkdtemp('/tmp/mcd-launch-'); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'claude'), `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)))\n`, { mode: 0o700 });
  const run = args => exec(process.execPath, [launcher, ...args], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  const output = JSON.parse((await run(['a task with spaces'])).stdout);
  const id = output[output.indexOf('--session-id') + 1];
  const config = JSON.parse(output[output.indexOf('--mcp-config') + 1]);
  assert.equal(config.mcpServers['codex-completion'].env.MAGPIE_CODEX_CHANNEL_ID, id);
  assert.equal(output.at(-1), 'a task with spaces');
  assert.equal(output.at(-2), id); // A non-variadic session flag ends generated options.
  const resumed = JSON.parse((await run(['--resume', id, '--', 'next task'])).stdout);
  assert.equal(resumed.filter(x => x === '--resume').length, 1);
  assert.equal(resumed[resumed.indexOf('--resume') + 1], id);
  assert.equal(JSON.parse(resumed[resumed.indexOf('--mcp-config') + 1]).mcpServers['codex-completion'].env.MAGPIE_CODEX_CHANNEL_ID, id);
  for (const bad of [['--print'], ['--print=true'], ['--background'], ['--session-id=x'], ['--resume','not-a-uuid']]) await assert.rejects(run(bad));
});
