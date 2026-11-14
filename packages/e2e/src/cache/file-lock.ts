import { open, unlink } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

/** Serializes short read-modify-write transactions across runner processes. */
export async function withCacheLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const handle = await open(lock, 'wx', 0o600).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === 'EEXIST') return undefined;
      throw cause;
    });
    if (handle === undefined) { await setTimeout(10); continue; }
    try { return await operation(); }
    finally { await handle.close(); await unlink(lock); }
  }
  throw new Error(`cache recording is locked: ${file}; remove its .lock file if a writer crashed`);
}
