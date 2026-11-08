/** Session receipts shared by a run's parent and workers on the same host. */
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Keeps only session IDs on disk, scoped to an account, run, and target. */
export class LeaseJournal {
  private readonly dir: string;

  constructor(account: string, runId: string, targetName: string) {
    const key = createHash('sha256').update(JSON.stringify([account, runId, targetName])).digest('hex');
    this.dir = path.join(tmpdir(), 'e2e-browser-run', key);
  }

  /** Receipts can never address a path outside this run's directory. */
  private file(id: string): string {
    if (!SESSION_ID.test(id)) throw new Error('Cloudflare Browser Run journal requires a valid session ID');

    return path.join(this.dir, id);
  }

  /** Publishes an empty receipt before the browser is handed to the engine. */
  async remember(id: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.file(id), '', { mode: 0o600 });
  }

  /** Removes a receipt only after remote deletion succeeds. */
  async forget(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }

  /** Reads only well-formed session IDs; never lists the Cloudflare account. */
  async outstanding(): Promise<string[]> {
    const entries = await readdir(this.dir, { withFileTypes: true }).catch((cause: unknown) => {
      if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return [];
      throw cause;
    });

    return entries.flatMap((entry) => entry.isFile() && SESSION_ID.test(entry.name) ? [entry.name] : []);
  }

  /** Removes an empty run directory without racing another receipt writer. */
  async prune(): Promise<void> {
    await rmdir(this.dir).catch((cause: unknown) => {
      if (cause instanceof Error && 'code' in cause &&
          (cause.code === 'ENOENT' || cause.code === 'ENOTEMPTY' || cause.code === 'EEXIST')) return;
      throw cause;
    });
  }
}
