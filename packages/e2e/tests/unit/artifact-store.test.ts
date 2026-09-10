/**
 * The ArtifactStore seam at its plug point: every registered artifact is
 * handed to the store as it lands, with its bytes, digest, and identity; the
 * store's reference is recorded; a failing store never surfaces; and without a
 * store the streaming measure path is unchanged.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArtifactStore, StoredArtifact } from '../../src/types.ts';
import { createAttemptArtifacts } from '../../src/run/artifacts.ts';

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
});
