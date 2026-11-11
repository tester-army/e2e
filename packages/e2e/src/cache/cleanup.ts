import { access, readFile, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex } from '../internal/ids.ts';
import { cacheFileKey, encodeTestReplayCode, readTestReplayCode } from './code.ts';
import { MAX_CACHE_WIRE_BYTES } from './store.ts';
import { withCacheLock } from './file-lock.ts';
import { projectIdentity } from './identity.ts';
import { writeFileAtomic } from '../internal/atomic-write.ts';

/** Removes only this project's recordings for tests collection proves no longer exist. */
export async function pruneTestRecordings(options: {
  directory: string; projectRoot: string; projectId: string;
  testIds: ReadonlySet<string>; collectedFiles: ReadonlySet<string>; fullCollection: boolean;
}): Promise<void> {
  const ids = new Set([...options.testIds].map(sha256Hex));
  const names = await readdir(options.directory).catch(() => [] as string[]);
  for (const name of names) {
    if (cacheFileKey(name) === undefined) continue;
    const file = path.join(options.directory, name);
    try {
      await withCacheLock(file, async () => {
        if ((await stat(file)).size > MAX_CACHE_WIRE_BYTES) return;
        const sourceCode = await readFile(file, 'utf8');
        if (Buffer.byteLength(sourceCode) > MAX_CACHE_WIRE_BYTES) return;
        const recording = readTestReplayCode(sourceCode);
        if (recording.id !== cacheFileKey(name) || ids.has(recording.id)) return;
        const source = recording.testId.replace(/^setup::/u, '').split('::')[0]!;
        const relative = path.relative(options.projectRoot, path.resolve(options.projectRoot, source));
        if (relative.startsWith('..') || path.isAbsolute(relative)) return;
        const removedFile = options.fullCollection && await access(path.resolve(options.projectRoot, source)).then(() => false, (cause: NodeJS.ErrnoException) => cause.code === 'ENOENT');
        if (!options.collectedFiles.has(source) && !removedFile) return;
        const project = projectIdentity(options.projectId);
        const steps = recording.steps.filter((step) => step.variant.project !== project);
        if (steps.length === recording.steps.length) return;
        if (steps.length === 0) await unlink(file);
        else await writeFileAtomic(file, encodeTestReplayCode({ ...recording, steps }), { mode: 0o600 });
      });
    } catch { /* An unreadable or busy cache is disposable, never a reason to fail a run. */ }
  }
}
