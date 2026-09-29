/**
 * Trace archive redaction: JSON records are rewritten value by value and other
 * text as text, in every encoding a trace spells a value; a fragment of a
 * value the page read raw is rewritten the same way; binary entries are
 * carried byte for byte unless they hold a secret, in which case they are
 * dropped; screencast frames, referenced or not, and their records are
 * dropped whatever they hold, while an app resource that merely looks like a
 * frame record stays; an untouched archive keeps its bytes; every listed
 * segment is covered; an archive that cannot be rewritten takes the whole
 * trace with it; a path outside the attempt directory is refused before
 * anything is touched.
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

const FRAME_WITH_SECRET = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(SECRET), Buffer.from([0x80])]);
const FRAME_CLEAN = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x80]);

/** What a Playwright trace holds after a secret fill, in each of its encodings. */
function traceArchive(secret = SECRET): Buffer {
  const jsonBody = JSON.stringify({ password: secret });
  return writeZip([
    zipEntry(
      'trace.trace',
      Buffer.from(
        [
          JSON.stringify({ type: 'before', method: 'fill', params: { value: secret } }),
          JSON.stringify({ type: 'frame-snapshot', html: ['INPUT', { __playwright_value_: secret }] }),
        ].join('\n'),
      ),
    ),
    zipEntry(
      'trace.network',
      Buffer.from(JSON.stringify({ postData: { text: jsonBody, params: [{ name: 'password', value: secret }] } })),
    ),
    zipEntry('resources/form.dat', Buffer.from(new URLSearchParams({ user: 'ada', password: secret }).toString())),
    zipEntry(
      'resources/page.html',
      Buffer.from(
        `<input value="${secret.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')}">`,
      ),
    ),
    zipEntry('resources/clean.jpeg', FRAME_CLEAN),
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

    await redactTraceArchives(dir, ['trace/trace.zip'], new SecretLedger([['member', SECRET]]));

    const after = entriesOf(file);
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const [name, bytes] of after) {
      if (name === 'resources/clean.jpeg') {
        expect(bytes.equals(before.get(name)!)).toBe(true);
        continue;
      }
      const text = bytes.toString('utf8');
      expect(text, name).not.toContain(SECRET);
      expect(text, name).not.toContain(JSON.stringify(SECRET).slice(1, -1));
      expect(text, name).not.toContain(encodeURIComponent(SECRET));
      expect(text, name).not.toContain('p%40ss+%22word');
    }
    const trace = after.get('trace.trace')!.toString().split('\n').map((line) => JSON.parse(line) as unknown);
    expect(trace).toEqual([
      { type: 'before', method: 'fill', params: { value: '<secret:member>' } },
      { type: 'frame-snapshot', html: ['INPUT', { __playwright_value_: '<secret:member>' }] },
    ]);
    expect(JSON.parse(after.get('trace.network')!.toString())).toEqual({
      postData: { text: '{"password":"<secret:member>"}', params: [{ name: 'password', value: '<secret:member>' }] },
    });
    expect(after.get('resources/form.dat')!.toString()).toBe('user=ada&password=<secret:member>');
    expect(after.get('resources/page.html')!.toString()).toBe('<input value="<secret:member>">');
    expect(after.get('trace.stacks')!.toString()).toBe('{"files":[]}');
  });

  it('rewrites a fragment of a secret the page read raw, cut or selected, and leaves plain text', async () => {
    const secret = 'cut-secret-Kq7ZrT2mWx9pLd4sNv8bHc3jFg6yQa1eUo5iRk0tYw2zXn7uM';
    const dir = attemptDir();
    const file = path.join(dir, 'trace', 'trace.zip');
    const read = { text: `0123456789${secret.slice(0, 59)}`, selection: secret.slice(5, 45), name: 'plain-control-plain' };
    writeFileSync(file, writeZip([zipEntry('trace.trace', Buffer.from(JSON.stringify({ type: 'after', result: { value: read } })))]));

    await redactTraceArchives(dir, ['trace/trace.zip'], new SecretLedger([['member', secret]]));

    expect(JSON.parse(entriesOf(file).get('trace.trace')!.toString())).toEqual({
      type: 'after',
      result: { value: { text: '0123456789<secret:member>', selection: '<secret:member>', name: 'plain-control-plain' } },
    });
  });

  it('keeps JSON records well-formed when the secret is JSON syntax itself', async () => {
    const dir = attemptDir();
    const file = path.join(dir, 'trace', 'trace.zip');
    writeFileSync(file, traceArchive('"'));

    await redactTraceArchives(dir, ['trace/trace.zip'], new SecretLedger([['quote', '"']]));

    const lines = entriesOf(file).get('trace.trace')!.toString().split('\n');
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { type: 'before', method: 'fill', params: { value: '<secret:quote>' } },
      { type: 'frame-snapshot', html: ['INPUT', { __playwright_value_: '<secret:quote>' }] },
    ]);
  });

  it('redacts a value that spans a line break of a resource, written or as whitespace', async () => {
    const dir = attemptDir();
    const file = path.join(dir, 'trace', 'trace.zip');
    const page = '<pre>\nfirst line 4417\nsecond line Qx\n</pre>\n<p>correct horse\nbattery</p>\n';
    writeFileSync(
      file,
      writeZip([
        zipEntry('resources/page.html', Buffer.from(page)),
        zipEntry('resources/data.txt', Buffer.from('{"type":"before"}\nkey-4417\n[1,2,3]\n')),
      ]),
    );

    await redactTraceArchives(
      dir,
      ['trace/trace.zip'],
      new SecretLedger([
        ['note', 'first line 4417\nsecond line Qx'],
        ['phrase', 'correct horse battery'],
        ['seam', 'key-4417\n[1,2,3]'],
      ]),
    );

    const after = entriesOf(file);
    expect(after.get('resources/page.html')!.toString()).toBe('<pre>\n<secret:note>\n</pre>\n<p><secret:phrase></p>\n');
    expect(after.get('resources/data.txt')!.toString()).toBe('{"type":"before"}\n<secret:seam>\n');
  });

  it('re-serializes a changed record without touching its numbers or its line ending', async () => {
    const dir = attemptDir();
    const file = path.join(dir, 'trace', 'trace.zip');
    const lines = [
      `{"type":"before","params":{"value":${JSON.stringify(SECRET)}},"wallTime":1789029024778.5,"big":12345678901234567890,"zero":-0}\r`,
      '{"type":"after","big":98765432109876543210}\r',
      '',
    ];
    writeFileSync(file, writeZip([zipEntry('trace.trace', Buffer.from(lines.join('\n')))]));

    await redactTraceArchives(dir, ['trace/trace.zip'], new SecretLedger([['member', SECRET]]));

    expect(entriesOf(file).get('trace.trace')!.toString()).toBe(
      [
        '{"type":"before","params":{"value":"<secret:member>"},"wallTime":1789029024778.5,"big":12345678901234567890,"zero":-0}\r',
        '{"type":"after","big":98765432109876543210}\r',
        '',
      ].join('\n'),
    );
  });

  it('drops a binary entry that holds a secret and keeps one that does not', async () => {
    const dir = attemptDir();
    const file = path.join(dir, 'trace', 'trace.zip');
    writeFileSync(
      file,
      writeZip([
        zipEntry('trace.trace', Buffer.from('{"type":"before"}')),
        zipEntry('resources/body.bin', FRAME_WITH_SECRET),
        zipEntry('resources/clean.jpeg', FRAME_CLEAN),
      ]),
    );

    await redactTraceArchives(dir, ['trace/trace.zip'], new SecretLedger([['member', SECRET]]));

    const after = entriesOf(file);
    expect([...after.keys()]).toEqual(['trace.trace', 'resources/clean.jpeg']);
    expect(after.get('resources/clean.jpeg')!.equals(FRAME_CLEAN)).toBe(true);
  });

  it('drops every screencast frame and its record, whatever the frame holds, and keeps the other images', async () => {
    const dir = attemptDir();
    const file = path.join(dir, 'trace', 'trace.zip');
    const frame = { type: 'screencast-frame', pageId: 'page@1', width: 1280, height: 720, timestamp: 12.5 };
    const served = JSON.stringify({ ...frame, file: 'resources/logo.jpeg' });
    writeFileSync(
      file,
      writeZip([
        zipEntry('resources/logo.jpeg', FRAME_CLEAN),
        zipEntry('resources/served.json', Buffer.from(served)),
        zipEntry('screencast/page@1-1.jpeg', FRAME_CLEAN),
        zipEntry('screencast/page@1-2.jpeg', FRAME_CLEAN),
        zipEntry(
          'trace.trace',
          Buffer.from(
            [
              JSON.stringify({ type: 'before', method: 'fill', params: { value: 'plain' } }),
              JSON.stringify({ ...frame, file: 'screencast/page@1-1.jpeg' }),
              JSON.stringify({ ...frame, sha1: 'abc.jpeg' }),
              JSON.stringify({ type: 'frame-snapshot', snapshot: { resourceOverrides: [{ sha1: 'logo.jpeg' }] } }),
            ].join('\n'),
          ),
        ),
        zipEntry('resources/abc.jpeg', FRAME_CLEAN),
      ]),
    );

    await redactTraceArchives(dir, ['trace/trace.zip'], new SecretLedger([['member', SECRET]]));

    const after = entriesOf(file);
    expect([...after.keys()]).toEqual(['resources/logo.jpeg', 'resources/served.json', 'trace.trace']);
    expect(after.get('resources/logo.jpeg')!.equals(FRAME_CLEAN)).toBe(true);
    expect(after.get('resources/served.json')!.toString()).toBe(served);
    expect(after.get('trace.trace')!.toString().split('\n').map((line) => JSON.parse(line) as unknown)).toEqual([
      { type: 'before', method: 'fill', params: { value: 'plain' } },
      { type: 'frame-snapshot', snapshot: { resourceOverrides: [{ sha1: 'logo.jpeg' }] } },
    ]);
  });

  it('keeps the screencast frames when asked, as for an engine-held secret, and still rewrites the options a context opened with', async () => {
    const dir = attemptDir();
    const file = path.join(dir, 'trace', 'trace.zip');
    const frame = JSON.stringify({ type: 'screencast-frame', pageId: 'page@1', width: 1280, height: 720, timestamp: 12.5, file: 'screencast/page@1-1.jpeg' });
    const options = { type: 'context-options', options: { httpCredentials: [{ username: 'ada', password: SECRET }] } };
    writeFileSync(
      file,
      writeZip([
        zipEntry('screencast/page@1-1.jpeg', FRAME_CLEAN),
        zipEntry('trace.trace', Buffer.from([JSON.stringify(options), frame].join('\n'))),
      ]),
    );

    await redactTraceArchives(dir, ['trace/trace.zip'], new SecretLedger([['staging', SECRET]]), { keepFrames: true });

    const after = entriesOf(file);
    expect([...after.keys()]).toEqual(['screencast/page@1-1.jpeg', 'trace.trace']);
    expect(after.get('trace.trace')!.toString().split('\n').map((line) => JSON.parse(line) as unknown)).toEqual([
      { type: 'context-options', options: { httpCredentials: [{ username: 'ada', password: '<secret:staging>' }] } },
      JSON.parse(frame),
    ]);
  });

  it('rewrites the basic-auth header the engine sent with every request after the challenge', async () => {
    const dir = attemptDir();
    const file = path.join(dir, 'trace', 'trace.zip');
    const header = { name: 'Authorization', value: `Basic ${Buffer.from(`ada:${SECRET}`).toString('base64')}` };
    writeFileSync(file, writeZip([zipEntry('trace.network', Buffer.from(JSON.stringify({ request: { headers: [header] } })))]));

    await redactTraceArchives(dir, ['trace/trace.zip'], new SecretLedger([['staging', SECRET]]));

    expect(JSON.parse(entriesOf(file).get('trace.network')!.toString())).toEqual({
      request: { headers: [{ name: 'Authorization', value: 'Basic <secret:staging>' }] },
    });
  });

  it('drops the screencast and scrubs a cut fragment in the same event stream', async () => {
    const secret = 'cut-secret-Kq7ZrT2mWx9pLd4sNv8bHc3jFg6yQa1eUo5iRk0tYw2zXn7uM';
    const dir = attemptDir();
    const file = path.join(dir, 'trace', 'trace.zip');
    const frame = { type: 'screencast-frame', pageId: 'page@1', file: 'screencast/page@1-1.jpeg' };
    writeFileSync(
      file,
      writeZip([
        zipEntry('screencast/page@1-1.jpeg', FRAME_CLEAN),
        zipEntry(
          'trace.trace',
          Buffer.from(
            [
              JSON.stringify(frame),
              JSON.stringify({ type: 'after', result: { value: { text: `0123456789${secret.slice(0, 59)}` } } }),
            ].join('\n'),
          ),
        ),
      ]),
    );

    await redactTraceArchives(dir, ['trace/trace.zip'], new SecretLedger([['member', secret]]));

    const after = entriesOf(file);
    expect([...after.keys()]).toEqual(['trace.trace']);
    expect(JSON.parse(after.get('trace.trace')!.toString())).toEqual({
      type: 'after',
      result: { value: { text: '0123456789<secret:member>' } },
    });
  });

  it('leaves an archive with nothing to redact untouched, and rewrites every listed segment', async () => {
    const dir = attemptDir();
    const clean = path.join(dir, 'trace', 'trace.zip');
    writeFileSync(clean, writeZip([zipEntry('trace.trace', Buffer.from('{"type":"before"}'))]));
    const segment = path.join(dir, 'trace', 'trace-part1.zip');
    writeFileSync(segment, traceArchive());
    const cleanBefore = readFileSync(clean);
    const cleanStat = statSync(clean);

    await redactTraceArchives(
      dir,
      ['trace/trace-part1.zip', 'trace/trace.zip'],
      new SecretLedger([['member', SECRET]]),
    );

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
      redactTraceArchives(
        dir,
        ['trace/trace-part1.zip', 'trace/trace.zip'],
        new SecretLedger([['member', SECRET]]),
      ),
    ).rejects.toMatchObject({ code: 'TRACE_WITHHELD', category: 'infrastructure' });
    expect(existsSync(good)).toBe(false);
    expect(existsSync(broken)).toBe(false);
  });

  it('refuses a path outside the attempt directory without touching anything', async () => {
    const dir = attemptDir();
    const outside = path.join(dir, '..', `e2e-outside-${path.basename(dir)}.zip`);
    writeFileSync(outside, traceArchive());
    dirs.push(outside);
    const inside = path.join(dir, 'trace', 'trace.zip');
    writeFileSync(inside, traceArchive());

    await expect(
      redactTraceArchives(dir, ['trace/trace.zip', `../${path.basename(outside)}`], new SecretLedger([['member', SECRET]])),
    ).rejects.toMatchObject({ code: 'TRACE_WITHHELD' });
    expect(existsSync(outside)).toBe(true);
    expect(entriesOf(inside).get('resources/form.dat')!.toString()).toContain('p%40ss+%22word');
  });
});
