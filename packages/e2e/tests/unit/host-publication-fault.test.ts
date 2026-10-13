/** Source-only first-byte fault proof. The outcome branch's video restore seam is not present here. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { openHost } from '../../src/runner.ts';
import { secrets } from '../../src/secrets.ts';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';

it.each([false, true])('withholds prospective provider prose before partial trace write, blocked temporary unlink=%s', async (blockedUnlink) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'host-publication-fault-'));
  const plaintext = blockedUnlink ? 'unstarted-secret-S3q9' : 'unstarted-secret-J5q8';
  const handle = secrets.get('unstarted');
  let calls = 0, callsAtTrace = -1, temporary = '', partial = '';
  const fake = createFakeEngine({ secrets: [handle], onDispose: async () => {
    await fake.attempts[0]!.resolveSecret(handle);
  } });
  const host = await openHost({ cwd, env: {}, config: {
    targets: [{ name: 'synthetic', platform: 'synthetic', engine: fake.engine, app: FAKE_APP }],
    secrets: { unstarted: () => { calls++; return plaintext; } },
  } });
  const session = await host.openSession({ name: 'late ' + plaintext });
  const originalWrite = fs.writeFile, originalUnlink = fs.unlink;
  const publication = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    if (String(args[0]).startsWith(session.tracePath + '.')) {
      callsAtTrace = calls; temporary = String(args[0]);
      partial = String(args[1]).slice(0, Math.floor(String(args[1]).length / 2));
      await originalWrite(temporary, partial);
      throw Object.assign(new Error('partial trace publication'), { code: 'ENOSPC' });
    }
    return originalWrite(...args);
  });
  const cleanup = vi.spyOn(fs, 'unlink').mockImplementation(async (file) => {
    if (blockedUnlink && String(file) === temporary) throw new Error('temporary unlink failed');
    return originalUnlink(file);
  });
  syncBuiltinESMExports();
  try {
    const failures = await session.close();
    expect(failures).toHaveLength(1);
    expect(callsAtTrace).toBe(0);
    expect(calls).toBe(0);
    const bundle = session.exportDebugBundle()!;
    const frozen = JSON.stringify(bundle);
    await host.close();
    expect(fake.stats().disposes).toBe(1);
    expect(calls).toBe(1);
    expect(existsSync(temporary)).toBe(blockedUnlink);
    if (blockedUnlink) expect(readFileSync(temporary, 'utf8')).toBe(partial);
    expect(partial).not.toContain(plaintext);
    expect(frozen).not.toContain(plaintext);
    expect(JSON.stringify(session.exportDebugBundle())).toBe(frozen);
    expect(bundle.trace).toBe('failed');
    expect(bundle.report.run.status).toBe('failed');
  } finally {
    publication.mockRestore(); cleanup.mockRestore(); syncBuiltinESMExports();
    await host.close(); rmSync(cwd, { recursive: true, force: true });
  }
});
