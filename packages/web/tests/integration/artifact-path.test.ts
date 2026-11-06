/**
 * Artifact paths built from names the engine does not choose, here a
 * caller's screenshot label. Every name lands as one plain counted file
 * inside the attempt's folder for that kind.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

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

let page: WebSession;

beforeAll(async () => {
  page = await startWebSession();
});

afterAll(async () => {
  await page.close();
});

describe('artifact paths', () => {
  it('writes a hostile screenshot label as one counted file inside the attempt screenshots folder', async () => {
    await page.setContent('<h1>Artifacts</h1>');
    const folder = path.join(page.artifactsDir, 'screenshots');
    for (const [index, name] of HOSTILE_NAMES.entries()) {
      const relative = await page.engine.artifacts!.screenshot!(name, page.op());
      const file = path.basename(relative);
      expect(relative, name).toBe(`screenshots/${file}`);
      expect(existsSync(path.join(folder, file)), name).toBe(true);
      expect(file, name).toMatch(new RegExp(`^${String(index + 1).padStart(3, '0')}-[A-Za-z0-9._-]{1,64}\\.png$`));
    }
  });
});
