/**
 * The sessions a run holds open, one marker file per session under the
 * system temp directory. Notte sessions carry no tags to find a run's by, but
 * the runner and its workers share one machine: a worker writes a marker when
 * it starts a session and removes it when it stops the session, so the markers
 * left at the end of the run name the sessions of workers that died.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** The run's markers for one target: a path built from ids, never trusted as one. */
function dirFor(runId: string, targetName: string): string {
  const run = runId.replace(/[^A-Za-z0-9_-]/g, '_');
  const target = createHash('sha256').update(targetName).digest('hex').slice(0, 16);
  return path.join(tmpdir(), 'e2e-notte', run, target);
}

/** A session id as a file name; Notte's ids are UUIDs, anything else is never written. */
function markerName(sessionId: string): string | undefined {
  return /^[A-Za-z0-9-]{1,128}$/.test(sessionId) ? sessionId : undefined;
}

/** Records that the run started `sessionId` for `targetName`. Best effort: a failed write only leaves the session to Notte's idle timeout. */
export async function remember(runId: string, targetName: string, sessionId: string): Promise<void> {
  const name = markerName(sessionId);
  if (name === undefined) return;
  const dir = dirFor(runId, targetName);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), '');
  } catch {
    // The idle timeout still ends the session if its worker dies.
  }
}

/** Records that `sessionId` was stopped. */
export async function forget(runId: string, targetName: string, sessionId: string): Promise<void> {
  const name = markerName(sessionId);
  if (name === undefined) return;
  await rm(path.join(dirFor(runId, targetName), name), { force: true }).catch(() => undefined);
}

/** The sessions the run started for `targetName` and never recorded as stopped. */
export async function remembered(runId: string, targetName: string): Promise<string[]> {
  try {
    return (await readdir(dirFor(runId, targetName))).filter((name) => markerName(name) !== undefined);
  } catch {
    return [];
  }
}

/** Removes the run's markers for `targetName`, and the run's directory once no target has any left. */
export async function clear(runId: string, targetName: string): Promise<void> {
  const dir = dirFor(runId, targetName);
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  await rmdir(path.dirname(dir)).catch(() => undefined);
}
