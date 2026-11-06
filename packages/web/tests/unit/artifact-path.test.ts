/** `sanitizeFilename`: a name the engine does not choose becomes one plain file name. */

import { describe, expect, it } from 'vitest';
import { sanitizeFilename } from '../../src/support.ts';

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

describe('sanitizeFilename', () => {
  it('keeps no separator, drive colon, or control character, bounds the length, and names an empty label', () => {
    for (const name of HOSTILE_NAMES) {
      const safe = sanitizeFilename(name);
      expect(safe, name).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    }
    expect(sanitizeFilename('')).toBe('artifact');
  });
});
