/**
 * Artifact paths built from names the engine does not choose: a caller's
 * screenshot label, or the filename a server suggests for a download. Every
 * name lands as one plain file inside the attempt's folder for that kind.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PlaywrightSurface } from '../../src/surface.ts';
import { sanitizeFilename } from '../../src/support.ts';
import { ignoreAppLog, noSecrets } from '../helpers/secrets.ts';

const HOSTILE_NAMES = [
  '../../etc/passwd',
  '..',
  '/etc/cron.d/job',
  '..\\..\\Windows\\win.ini',
  'C:\\Windows\\System32\\drivers\\etc\\hosts',
  'report.pdf:hidden-stream',
  'a\u0000b.txt',
  'CON',
  'nul.txt',
  'LPT1',
  `${'x'.repeat(300)}.zip`,
];

let directory: string | undefined;

afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('sanitizeFilename', () => {
  it('keeps no separator, drive colon, or control character, bounds the length, and names an empty label', () => {
    for (const name of HOSTILE_NAMES) {
      const safe = sanitizeFilename(name);
      expect(safe, name).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    }
    expect(sanitizeFilename('')).toBe('artifact');
  });
});

describe('artifact paths', () => {
  it('writes a server-chosen download name as one counted file inside the attempt downloads folder', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'e2e-artifact-path-'));
    const surface = new PlaywrightSurface({});
    await surface.startAttempt({ attemptId: 'a1', artifactsDir: directory, signal: new AbortController().signal, resolveSecret: noSecrets, appLog: ignoreAppLog });
    const folder = path.join(directory, 'downloads');
    try {
      for (const [index, name] of HOSTILE_NAMES.entries()) {
        const { relative, absolute } = surface.artifactPath('downloads', name, '');
        const file = path.basename(absolute);
        expect(relative, name).toBe(`downloads/${file}`);
        expect(path.dirname(absolute), name).toBe(folder);
        expect(file, name).toMatch(new RegExp(`^${String(index + 1).padStart(3, '0')}-[A-Za-z0-9._-]{1,64}$`));
      }
    } finally {
      await surface.endAttempt({ signal: new AbortController().signal, timeoutMs: 1_000 });
    }
  });
});
