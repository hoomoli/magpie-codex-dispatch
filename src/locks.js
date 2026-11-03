import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { DispatchError } from './errors.js';

// Keep the inode: unlinking a lock file lets another caller lock a different inode.
// macOS flock locks belong to the shared open-file description. lockf locks fd 3,
// inherited from this process, then exits; our descriptor retains the lock until
// close (including process death). No helper or recovery directory owns the lock.
export async function acquireFileLock(path, { signal, busyCode = 'BUSY' } = {}) {
  const cancelled = () => new DispatchError('ABORTED', 'Cancelled before acquiring the operation lock.');
  if (signal?.aborted) throw cancelled();
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.nlink !== 1) {
      throw new DispatchError('UNSAFE_LOCK_FILE', 'The plugin lock must be a private regular file owned by the current user.');
    }
    if (signal?.aborted) throw cancelled();
    await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/lockf', ['-s', '-t', '0', '3'], { stdio: ['ignore', 'ignore', 'ignore', file.fd] });
      let failure;
      const stop = error => { failure ??= error; child.kill('SIGKILL'); };
      const onAbort = () => stop(cancelled());
      const timer = setTimeout(() => stop(new DispatchError('LOCK_TIMEOUT', 'Timed out acquiring the plugin lock. No command was submitted.')), 3000);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      child.once('error', () => { failure ??= new DispatchError('LOCK_UNAVAILABLE', 'The macOS lockf utility could not be started. No command was submitted.'); });
      // Wait for close even after cancellation: the helper must not acquire a lock
      // after its parent has already returned a failure and released the descriptor.
      child.once('close', code => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (failure) reject(failure);
        else if (code === 0) resolve();
        else if (code === 75) reject(new DispatchError(busyCode, 'Another plugin operation holds this lock. Retry the same requestId later.'));
        else reject(new DispatchError('LOCK_UNAVAILABLE', 'The macOS file lock could not be acquired. No command was submitted.'));
      });
    });
    if (signal?.aborted) throw cancelled();
    return () => file.close();
  } catch (error) {
    await file.close();
    throw error;
  }
}
