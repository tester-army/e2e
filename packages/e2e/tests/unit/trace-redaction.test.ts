/**
 * Trace archive redaction: every text entry is rewritten through the redactor
 * in every encoding a trace spells a value, binary entries and untouched
 * archives are carried byte for byte, sibling segments are covered, and an
 * archive that cannot be rewritten takes the whole trace with it.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SecretLedger } from '../../src/internal/redact.ts';
import { inflateEntry, readZip, writeZip, zipEntry } from '../../src/internal/zip.ts';
import { redactTraceArchives } from '../../src/run/trace-redaction.ts';

const SECRET = 'p@ss "word" & <more>';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function attemptDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-trace-redaction-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, 'trace'));
  return dir;
}

/** What a Playwright trace holds after a secret fill, in each of its encodings. */
function traceArchive(): Buffer {
  const jsonBody = JSON.stringify({ password: SECRET });
  return writeZip([
    zipEntry(
      'trace.trace',
      Buffer.from(
        [
          JSON.stringify({ type: 'before', method: 'fill', params: { value: SECRET } }),
          JSON.stringify({ type: 'frame-snapshot', html: ['INPUT', { __playwright_value_: SECRET }] }),
        ].join('\n'),
      ),
    ),
    zipEntry(
      'trace.network',
      Buffer.from(JSON.stringify({ postData: { text: jsonBody, params: [{ name: 'password', value: SECRET }] } })),
    ),
    zipEntry('resources/form.dat', Buffer.from(new URLSearchParams({ user: 'ada', password: SECRET }).toString())),
    zipEntry(
      'resources/page.html',
      Buffer.from(
        `<input value="${SECRET.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')}">`,
      ),
    ),
    // A screencast frame: not UTF-8, so never text, even with the secret's bytes inside.
    zipEntry('screencast/frame.jpeg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(SECRET), Buffer.from([0x80])])),
    zipEntry('trace.stacks', Buffer.from('{"files":[]}')),
  ]);
}

function entriesOf(file: string): Map<string, Buffer> {
  return new Map(readZip(readFileSync(file)).map((entry) => [entry.name, inflateEntry(entry)]));
}

describe('redactTraceArchives', () => {
  it('rewrites every text entry in every encoding and carries binary entries as they were', async () => {
    const dir = attemptDir();
    const file = path.join(dir, 'trace', 'trace.zip');
    writeFileSync(file, traceArchive());
    const before = entriesOf(file);

    await redactTraceArchives(dir, 'trace/trace.zip', new SecretLedger([['member', SECRET]]).redact);

    const after = entriesOf(file);
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const [name, bytes] of after) {
      if (name === 'screencast/frame.jpeg') {
        expect(bytes.equals(before.get(name)!)).toBe(true);
        continue;
      }
      const text = bytes.toString('utf8');
      expect(text, name).not.toContain(SECRET);
      expect(text, name).not.toContain(JSON.stringify(SECRET).slice(1, -1));
      expect(text, name).not.toContain(encodeURIComponent(SECRET));
      expect(text, name).not.toContain('p%40ss+%22word');
    }
    expect(after.get('trace.trace')!.toString()).toContain('"value":"<secret:member>"');
    expect(after.get('trace.trace')!.toString()).toContain('"__playwright_value_":"<secret:member>"');
    expect(after.get('trace.network')!.toString()).toContain('<secret:member>');
    expect(after.get('resources/form.dat')!.toString()).toBe('user=ada&password=<secret:member>');
    expect(after.get('resources/page.html')!.toString()).toBe('<input value="<secret:member>">');
    // The redacted archive is still a well-formed trace with the same members.
    expect(after.get('trace.stacks')!.toString()).toBe('{"files":[]}');
  });

  it('leaves an archive with nothing to redact untouched, and rewrites sibling segments too', async () => {
    const dir = attemptDir();
    const clean = path.join(dir, 'trace', 'trace.zip');
    writeFileSync(clean, writeZip([zipEntry('trace.trace', Buffer.from('{"type":"before"}'))]));
    const segment = path.join(dir, 'trace', 'trace-part1.zip');
    writeFileSync(segment, traceArchive());
    const cleanBefore = readFileSync(clean);
    const cleanStat = statSync(clean);

    await redactTraceArchives(dir, 'trace/trace.zip', new SecretLedger([['member', SECRET]]).redact);

    expect(readFileSync(clean).equals(cleanBefore)).toBe(true);
    expect(statSync(clean).mtimeMs).toBe(cleanStat.mtimeMs);
    expect(entriesOf(segment).get('trace.trace')!.toString()).not.toContain(SECRET);
  });

  it('deletes the whole trace and throws TRACE_WITHHELD when an archive cannot be rewritten', async () => {
    const dir = attemptDir();
    const good = path.join(dir, 'trace', 'trace.zip');
    writeFileSync(good, traceArchive());
    const broken = path.join(dir, 'trace', 'trace-part1.zip');
    writeFileSync(broken, Buffer.from('this is not an archive'));

    await expect(
      redactTraceArchives(dir, 'trace/trace.zip', new SecretLedger([['member', SECRET]]).redact),
    ).rejects.toMatchObject({ code: 'TRACE_WITHHELD', category: 'infrastructure' });
    expect(existsSync(good)).toBe(false);
    expect(existsSync(broken)).toBe(false);
  });
});
