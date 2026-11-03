import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Operations } from '../src/operations.js';
import { acquireFileLock } from '../src/locks.js';

test('kernel ownership survives helper exit and is released on SIGKILL without recovery files', async t => {
  const directory = await mkdtemp('/tmp/mcd-lock-crash-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const id = 'crash-recovery-0001';
  const source = `import { Operations } from ${JSON.stringify(new URL('../src/operations.js', import.meta.url).href)};
    await new Operations(${JSON.stringify(directory)}).locked(${JSON.stringify(id)}, async () => {
      console.log('LOCKED');
      await new Promise(resolve => { process.stdin.on('end', resolve); process.stdin.resume(); });
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => { child.kill('SIGKILL'); await exited; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Lock worker timed out')), 5000);
    child.stdout.once('data', data => { clearTimeout(timer); assert.equal(data.toString().trim(), 'LOCKED'); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Lock worker exited early')); });
  });
  const store = new Operations(directory);
  const inode = (await stat(`${store.path(id)}.mutex`)).ino;
  await assert.rejects(store.locked(id, async () => assert.fail('concurrent entry')), { code: 'OPERATION_BUSY' });
  child.kill('SIGKILL'); await exited;
  assert.equal(await store.locked(id, async () => 'recovered'), 'recovered');
  assert.equal((await stat(`${store.path(id)}.mutex`)).ino, inode);
  await assert.rejects(store.locked(id, async () => { throw new Error('callback failed'); }), /callback failed/);
  assert.equal(await store.locked(id, async () => 'released after error'), 'released after error');
});

test('cancelled acquisition submits no work and does not poison a later lock', async t => {
  const directory = await mkdtemp('/tmp/mcd-lock-abort-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'operation.mutex');
  await assert.rejects(acquireFileLock(path, { signal: AbortSignal.abort() }), { code: 'ABORTED' });
  const release = await acquireFileLock(path);
  await assert.rejects(acquireFileLock(path), { code: 'BUSY' });
  await release();
  await (await acquireFileLock(path))();
});
