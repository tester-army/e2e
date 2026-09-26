/**
 * The ArtifactStore seam at its plug point: every registered artifact is
 * handed to the store as it lands, with its bytes, digest, and identity; the
 * store's reference is recorded; a failing store never surfaces; and without a
 * store the streaming measure path is unchanged.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArtifactStore, StoredArtifact } from '../../src/types.ts';
import { SecretLedger } from '../../src/internal/redact.ts';
import { createAttemptArtifacts } from '../../src/run/artifacts.ts';
import type { SessionSecrecy } from '../../src/run/secrecy.ts';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-artifact-store-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function capturing(): ArtifactStore & { puts: StoredArtifact[] } {
  const puts: StoredArtifact[] = [];
  return {
    puts,
    async put(artifact) {
      puts.push(artifact);
      return { ref: `r2://bucket/${artifact.sha256.slice(0, 8)}` };
    },
  };
}

describe('createAttemptArtifacts with an ArtifactStore', () => {
  it('hands each artifact to the store as produced, with bytes, digest, and identity, and records the ref', async () => {
    const store = capturing();
    const artifacts = createAttemptArtifacts({
      artifactsRoot: root(),
      segments: ['web', 'test-1', 'attempt-0'],
      attemptId: 'att-1',
      currentStepId: () => 'step-3',
      store,
      identity: { runId: 'run-9', testId: 'test-1' },
    });
    const png = Buffer.from('not really a png');
    writeFileSync(path.join(artifacts.dir, 'shot.png'), png);
    const id = artifacts.sink.register('screenshot', 'shot.png');
    await artifacts.settle();

    expect(store.puts).toHaveLength(1);
    const put = store.puts[0]!;
    expect(put.kind).toBe('screenshot');
    expect(put.mediaType).toBe('image/png');
    expect(Buffer.from(put.bytes).equals(png)).toBe(true);
    expect(put.size).toBe(png.byteLength);
    expect(put.sha256).toBe(createHash('sha256').update(png).digest('hex'));
    expect(put.path).toBe('web/test-1/attempt-0/shot.png');
    expect(put).toMatchObject({ runId: 'run-9', testId: 'test-1', attemptId: 'att-1', stepId: 'step-3' });

    const record = artifacts.records[0]!;
    expect(record.id).toBe(id);
    expect(record.ref).toBe(`r2://bucket/${put.sha256.slice(0, 8)}`);
    expect(record.path).toBe('web/test-1/attempt-0/shot.png');
    expect(record.size).toBe(png.byteLength);
    expect(record.sha256).toBe(put.sha256);
  });

  it('carries a video segment start time to the record and the store, and marks it unredacted', async () => {
    const store = capturing();
    const artifacts = createAttemptArtifacts({
      artifactsRoot: root(),
      segments: ['web', 'test-1', 'attempt-0'],
      attemptId: 'att-1',
      store,
      identity: { runId: 'run-9', testId: 'test-1' },
    });
    mkdirSync(path.join(artifacts.dir, 'video'));
    writeFileSync(path.join(artifacts.dir, 'video', 'video.webm'), Buffer.from('not really webm'));
    const startedAt = '2026-09-09T10:00:00.000Z';
    artifacts.sink.register('video', 'video/video.webm', { startedAt });
    await artifacts.settle();

    expect(store.puts).toHaveLength(1);
    expect(store.puts[0]).toMatchObject({ kind: 'video', mediaType: 'video/webm', startedAt });
    expect(artifacts.records[0]).toMatchObject({
      kind: 'video',
      mediaType: 'video/webm',
      startedAt,
      redaction: 'incomplete',
      path: 'web/test-1/attempt-0/video/video.webm',
    });
    // Other kinds carry no start time and stay vouched for.
    writeFileSync(path.join(artifacts.dir, 'shot.png'), 'x');
    artifacts.sink.register('screenshot', 'shot.png');
    await artifacts.settle();
    expect(artifacts.records[1]).toMatchObject({ redaction: 'complete' });
    expect(artifacts.records[1]!.startedAt).toBeUndefined();
    expect(store.puts[1]!.startedAt).toBeUndefined();
  });

  it('hands the store the report-owning attempt id while artifact ids still mint from the member', async () => {
    const store = capturing();
    const artifacts = createAttemptArtifacts({
      artifactsRoot: root(),
      segments: ['web', 'group', 'attempt-0'],
      attemptId: 'member-private',
      store,
      identity: { runId: 'run', testId: 'group', attemptId: 'group-attempt' },
    });
    writeFileSync(path.join(artifacts.dir, 'shot.png'), 'x');
    artifacts.sink.register('screenshot', 'shot.png');
    await artifacts.settle();
    // The report files a serial member's artifacts under the group attempt: a
    // store correlating by attempt must see that id, not a private one absent
    // from the report.
    expect(store.puts[0]!.attemptId).toBe('group-attempt');
    expect(artifacts.records[0]!.id).toBe('member-private:artifact:0');
  });

  it('keeps the local record and omits ref when the store fails, without throwing', async () => {
    const artifacts = createAttemptArtifacts({
      artifactsRoot: root(),
      segments: ['web', 't', 'attempt-0'],
      attemptId: 'a',
      store: {
        put: async () => {
          throw new Error('bucket unreachable');
        },
      },
    });
    writeFileSync(path.join(artifacts.dir, 'trace.zip'), 'zip');
    artifacts.sink.register('trace', 'trace.zip');
    await expect(artifacts.settle()).resolves.toBeUndefined();
    const record = artifacts.records[0]!;
    expect(record.ref).toBeUndefined();
    expect(record.path).toBe('web/t/attempt-0/trace.zip');
    expect(record.sha256).toBeDefined();
  });

  it('ignores an empty ref and never records a missing file', async () => {
    const artifacts = createAttemptArtifacts({
      artifactsRoot: root(),
      segments: ['web', 't', 'attempt-0'],
      attemptId: 'a',
      store: { put: async () => ({ ref: '' }) },
    });
    writeFileSync(path.join(artifacts.dir, 'a.png'), 'x');
    artifacts.sink.register('screenshot', 'a.png');
    artifacts.sink.register('screenshot', 'never-written.png');
    await artifacts.settle();
    expect(artifacts.records[0]!.ref).toBeUndefined();
    expect(artifacts.records[0]!.path).toBeDefined();
    expect(artifacts.records[1]!.path).toBeUndefined();
    expect(artifacts.records[1]!.ref).toBeUndefined();
  });

  it('without a store measures by streaming and records no ref', async () => {
    const artifacts = createAttemptArtifacts({
      artifactsRoot: root(),
      segments: ['web', 't', 'attempt-0'],
      attemptId: 'a',
    });
    const body = Buffer.from('hello');
    writeFileSync(path.join(artifacts.dir, 'log.txt'), body);
    artifacts.sink.register('log', 'log.txt');
    await artifacts.settle();
    const record = artifacts.records[0]!;
    expect(record.ref).toBeUndefined();
    expect(record.size).toBe(5);
    expect(record.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(record.mediaType).toBe('text/plain');
  });
});

describe('artifact redaction labels', () => {
  it('marks a trace registered without a verdict as incomplete, and takes the verdict when given', async () => {
    const artifacts = createAttemptArtifacts({
      artifactsRoot: root(),
      segments: ['web', 'test-1', 'attempt-0'],
      attemptId: 'att-1',
    });
    mkdirSync(path.join(artifacts.dir, 'trace'));
    writeFileSync(path.join(artifacts.dir, 'trace', 'trace.zip'), 'zip bytes');
    artifacts.sink.register('trace', 'trace/trace.zip');
    artifacts.sink.register('trace', 'trace/trace.zip', { redaction: 'not-required' });
    artifacts.sink.register('trace', 'trace/trace.zip', { redaction: 'complete' });
    await artifacts.settle();
    expect(artifacts.records.map((record) => record.redaction)).toEqual(['incomplete', 'not-required', 'complete']);
    // A labelled trace still carries its file.
    expect(artifacts.records[2]).toMatchObject({ path: 'web/test-1/attempt-0/trace/trace.zip', size: 9 });
  });

  it('hands the store the redaction the record carries', async () => {
    const store = capturing();
    const artifacts = createAttemptArtifacts({
      artifactsRoot: root(),
      segments: ['web', 'test-1', 'attempt-0'],
      attemptId: 'att-1',
      store,
    });
    writeFileSync(path.join(artifacts.dir, 'shot.png'), 'x');
    writeFileSync(path.join(artifacts.dir, 'trace.zip'), 'zip');
    artifacts.sink.register('screenshot', 'shot.png');
    artifacts.sink.register('trace', 'trace.zip', { redaction: 'not-required' });
    await artifacts.settle();
    // Puts land as each file's read finishes, in no fixed order.
    expect(store.puts.find((put) => put.kind === 'screenshot')).toMatchObject({ redaction: 'complete' });
    expect(store.puts.find((put) => put.kind === 'trace')).toMatchObject({ redaction: 'not-required' });
  });
});

describe('download redaction', () => {
  const SECRET = 'download-secret-Qx7-2718';

  function secrecy(filled: boolean): SessionSecrecy {
    return { ledger: new SecretLedger([['api-key', SECRET]]), taint: { value: filled } };
  }

  function downloads(filled: boolean | undefined, store?: ArtifactStore) {
    const artifacts = createAttemptArtifacts({
      artifactsRoot: root(),
      segments: ['web', 'test-1', 'attempt-0'],
      attemptId: 'att-1',
      ...(store === undefined ? {} : { store }),
      ...(filled === undefined ? {} : { secrecy: () => secrecy(filled) }),
    });
    mkdirSync(path.join(artifacts.dir, 'downloads'));
    return artifacts;
  }

  it('labels a download incomplete by default: bytes the app served, not rewritten', async () => {
    const store = capturing();
    const artifacts = downloads(undefined, store);
    const body = `id,key\n1,${SECRET}\n`;
    writeFileSync(path.join(artifacts.dir, 'downloads', 'export.csv'), body);
    artifacts.sink.register('download', 'downloads/export.csv');
    await artifacts.settle();
    expect(artifacts.records[0]).toMatchObject({ kind: 'download', mediaType: 'text/csv', redaction: 'incomplete' });
    expect(store.puts[0]).toMatchObject({ kind: 'download', redaction: 'incomplete' });
    expect(Buffer.from(store.puts[0]!.bytes).toString('utf8')).toBe(body);
  });

  it('rewrites a text download through the ledger once a secret was filled, and labels it complete', async () => {
    const store = capturing();
    const artifacts = downloads(true, store);
    writeFileSync(path.join(artifacts.dir, 'downloads', 'export.json'), JSON.stringify({ key: SECRET }));
    artifacts.sink.register('download', 'downloads/export.json');
    await artifacts.settle();
    const redacted = JSON.stringify({ key: '<secret:api-key>' });
    expect(artifacts.records[0]).toMatchObject({ mediaType: 'application/json', redaction: 'complete' });
    expect(readFileSync(path.join(artifacts.dir, 'downloads', 'export.json'), 'utf8')).toBe(redacted);
    expect(store.puts[0]).toMatchObject({ redaction: 'complete', size: Buffer.byteLength(redacted) });
    expect(Buffer.from(store.puts[0]!.bytes).toString('utf8')).toBe(redacted);
    expect(store.puts[0]!.sha256).toBe(createHash('sha256').update(redacted).digest('hex'));
  });

  it('rewrites a value CSV quoted, its double quotes doubled', async () => {
    const artifacts = createAttemptArtifacts({
      artifactsRoot: root(),
      segments: ['web', 'test-1', 'attempt-0'],
      attemptId: 'att-1',
      secrecy: () => ({ ledger: new SecretLedger([['api-key', 'pa"ss,word']]), taint: { value: true } }),
    });
    mkdirSync(path.join(artifacts.dir, 'downloads'));
    writeFileSync(path.join(artifacts.dir, 'downloads', 'export.csv'), 'id,key\n1,"pa""ss,word"\n');
    artifacts.sink.register('download', 'downloads/export.csv');
    await artifacts.settle();
    expect(artifacts.records[0]).toMatchObject({ redaction: 'complete' });
    expect(readFileSync(path.join(artifacts.dir, 'downloads', 'export.csv'), 'utf8')).toBe('id,key\n1,"<secret:api-key>"\n');
  });

  it('keeps a byte order mark on a rewritten download', async () => {
    const store = capturing();
    const artifacts = downloads(true, store);
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    writeFileSync(path.join(artifacts.dir, 'downloads', 'export.csv'), Buffer.concat([bom, Buffer.from(`key\n${SECRET}\n`)]));
    artifacts.sink.register('download', 'downloads/export.csv');
    await artifacts.settle();
    const rewritten = readFileSync(path.join(artifacts.dir, 'downloads', 'export.csv'));
    expect(rewritten.subarray(0, 3).equals(bom)).toBe(true);
    expect(rewritten.subarray(3).toString('utf8')).toBe('key\n<secret:api-key>\n');
    expect(artifacts.records[0]).toMatchObject({ redaction: 'complete', size: rewritten.byteLength });
    expect(store.puts[0]!.sha256).toBe(createHash('sha256').update(rewritten).digest('hex'));
    expect(Buffer.from(store.puts[0]!.bytes).equals(rewritten)).toBe(true);
  });

  it('labels a scanned text download complete when it held nothing to redact', async () => {
    const artifacts = downloads(true);
    writeFileSync(path.join(artifacts.dir, 'downloads', 'notes.txt'), 'nothing secret here');
    artifacts.sink.register('download', 'downloads/notes.txt');
    await artifacts.settle();
    expect(artifacts.records[0]).toMatchObject({ redaction: 'complete', size: 19 });
  });

  it('leaves a download as served without a fill, and a binary one with a fill, both incomplete', async () => {
    const untainted = downloads(false);
    const body = `key=${SECRET}`;
    writeFileSync(path.join(untainted.dir, 'downloads', 'env.txt'), body);
    untainted.sink.register('download', 'downloads/env.txt');
    await untainted.settle();
    expect(untainted.records[0]).toMatchObject({ redaction: 'incomplete' });
    expect(readFileSync(path.join(untainted.dir, 'downloads', 'env.txt'), 'utf8')).toBe(body);

    const tainted = downloads(true);
    const binary = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00]), Buffer.from(SECRET)]);
    writeFileSync(path.join(tainted.dir, 'downloads', 'blob.bin'), binary);
    writeFileSync(path.join(tainted.dir, 'downloads', 'broken.txt'), binary);
    tainted.sink.register('download', 'downloads/blob.bin');
    tainted.sink.register('download', 'downloads/broken.txt');
    await tainted.settle();
    expect(tainted.records.map((record) => record.redaction)).toEqual(['incomplete', 'incomplete']);
    expect(readFileSync(path.join(tainted.dir, 'downloads', 'blob.bin')).equals(binary)).toBe(true);
    expect(readFileSync(path.join(tainted.dir, 'downloads', 'broken.txt')).equals(binary)).toBe(true);
  });

  it('keeps a redaction the registration decided, whatever the session filled', async () => {
    const artifacts = downloads(true);
    writeFileSync(path.join(artifacts.dir, 'downloads', 'export.csv'), SECRET);
    artifacts.sink.register('download', 'downloads/export.csv', { redaction: 'not-required' });
    await artifacts.settle();
    expect(artifacts.records[0]).toMatchObject({ redaction: 'not-required' });
    expect(readFileSync(path.join(artifacts.dir, 'downloads', 'export.csv'), 'utf8')).toBe(SECRET);
  });
});
