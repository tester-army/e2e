/** Private sink receipts bind producer bytes before async measurement, not consumer assertions. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as custody from '../../src/run/artifacts.ts';
import { sessionSecrecy } from '../../src/run/secrecy.ts';
import type { TargetSession } from '../../src/engine/surface.ts';
import type { ArtifactRegistration, ArtifactSink } from '../../src/run/fixtures.ts';
import type { StoredArtifact } from '../../src/types.ts';

const roots: string[] = [];
const original = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 11]);
const altered = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 22]);
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Allows the exact same counterexample to exercise the pre-receipt source without adding test authority. */
function bind(sink: ArtifactSink, registration: ArtifactRegistration, bytes: Uint8Array) {
  const helper = Reflect.get(custody, 'bindDebugEvidenceBytes') as typeof custody.bindDebugEvidenceBytes | undefined;
  helper?.(sink, registration, bytes);
}

function setup(store = true) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'e2e-byte-custody-')); roots.push(root);
  const puts: StoredArtifact[] = [];
  const secrecy = sessionSecrecy({} as TargetSession, new Map());
  const artifacts = custody.createAttemptArtifacts({ artifactsRoot: root, segments: ['attempt'], attemptId: 'attempt', safePaths: true, secrecy: () => secrecy,
    ...(store ? { store: { async put(artifact: StoredArtifact) { puts.push(artifact); return { ref: artifact.sha256 }; } } } : {}),
  });
  return { artifacts, puts, secrecy };
}

it.each([true, false].flatMap((store) => [true, false].map((sameSize) => [store, sameSize] as const)))('rejects altered persisted bytes before store/export admission (store=%s, same-size=%s)', async (store, sameSize) => {
  const { artifacts, puts } = setup(store);
  const ticket = custody.debugEvidenceRegistration(artifacts.sink);
  bind(artifacts.sink, ticket, original);
  const absolute = path.join(artifacts.dir, 'shared.png');
  writeFileSync(absolute, original);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const open = fsPromises.open;
  const spy = vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => { await barrier; return open(...args); });
  syncBuiltinESMExports();
  try {
    const id = artifacts.sink.register('screenshot', 'shared.png', ticket);
    writeFileSync(absolute, sameSize ? altered : Buffer.concat([altered, altered]));
    release(); await artifacts.settle();
    expect(puts).toEqual([]);
    expect(artifacts.records[0]!.redaction).toBe('incomplete');
    expect(artifacts.records[0]).not.toHaveProperty('path');
    expect(artifacts.debugMediaType(id)).toBeUndefined();
    expect(artifacts.debugRedactionProven(id)).toBe(false);
  } finally { release(); spy.mockRestore(); syncBuiltinESMExports(); }
});

it('does not retain mutable producer buffers or public expected-digest assertions', async () => {
  const { artifacts, puts } = setup();
  const bytes = new Uint8Array(original);
  const ticket = custody.debugEvidenceRegistration(artifacts.sink);
  bind(artifacts.sink, ticket, bytes);
  bytes[8] = 22;
  Object.assign(ticket, { expected: { size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') } });
  writeFileSync(path.join(artifacts.dir, 'changed.png'), bytes);
  artifacts.sink.register('screenshot', 'changed.png', ticket);
  await artifacts.settle();
  expect(puts).toEqual([]);
  expect(artifacts.records[0]).not.toHaveProperty('path');
});

it.each(['rebind', 'cross-sink', 'reuse'] as const)('rejects %s original byte receipts before store put', async (mode) => {
  const { artifacts, puts } = setup();
  const ticket = custody.debugEvidenceRegistration(mode === 'cross-sink' ? setup().artifacts.sink : artifacts.sink);
  bind(artifacts.sink, ticket, original);
  writeFileSync(path.join(artifacts.dir, 'source.png'), original);
  if (mode === 'rebind') bind(artifacts.sink, ticket, altered);
  if (mode === 'reuse') { artifacts.sink.register('screenshot', 'source.png', ticket); await artifacts.settle(); puts.splice(0); }
  const id = artifacts.sink.register('screenshot', 'source.png', ticket);
  await artifacts.settle();
  expect(puts).toEqual([]);
  expect(artifacts.debugRedactionProven(id)).toBe(false);
  expect(artifacts.records.at(-1)).not.toHaveProperty('path');
});

it('rechecks live pixel taint after async measurement and before store publication', async () => {
  const { artifacts, puts, secrecy } = setup();
  const ticket = custody.debugEvidenceRegistration(artifacts.sink);
  bind(artifacts.sink, ticket, original);
  writeFileSync(path.join(artifacts.dir, 'source.png'), original);
  const id = artifacts.sink.register('screenshot', 'source.png', ticket);
  secrecy.exposure.raise('filled');
  await artifacts.settle();
  expect(puts).toEqual([]);
  expect(artifacts.records[0]!.redaction).toBe('incomplete');
  expect(artifacts.debugRedactionProven(id)).toBe(false);
  expect(artifacts.debugMediaType(id)).toBe('image/png');
});

it('requires a private byte expectation, never an expected hash on the registration object', async () => {
  const { artifacts, puts } = setup();
  const ticket = custody.debugEvidenceRegistration(artifacts.sink);
  Object.assign(ticket, { expected: { size: original.length, sha256: createHash('sha256').update(original).digest('hex') } });
  writeFileSync(path.join(artifacts.dir, 'source.png'), original);
  const id = artifacts.sink.register('screenshot', 'source.png', ticket);
  await artifacts.settle();
  expect(puts).toEqual([]);
  expect(artifacts.debugRedactionProven(id)).toBe(false);
  expect(artifacts.debugMediaType(id)).toBeUndefined();
});

it.each(['copy', 'marker'] as const)('never grants SDK evidence authority to %s public fields', async (mode) => {
  const { artifacts } = setup();
  const ticket = custody.debugEvidenceRegistration(artifacts.sink);
  bind(artifacts.sink, ticket, original);
  const unsupported = mode === 'copy' ? { ...ticket } : { debugEvidence: true };
  Object.assign(unsupported, { expected: { size: original.length, sha256: createHash('sha256').update(original).digest('hex') } });
  writeFileSync(path.join(artifacts.dir, 'source.png'), original);
  const id = artifacts.sink.register('screenshot', 'source.png', unsupported);
  await artifacts.settle();
  expect(artifacts.debugEvidence.has(id)).toBe(false);
  expect(artifacts.debugRedactionProven(id)).toBe(false);
  expect(artifacts.debugMediaType(id)).toBeUndefined();
});

it('rejects a pixel ticket used for a text sink even with matching bytes', async () => {
  const { artifacts, puts } = setup();
  const ticket = custody.debugEvidenceRegistration(artifacts.sink);
  bind(artifacts.sink, ticket, original);
  writeFileSync(path.join(artifacts.dir, 'wrong.txt'), original);
  const id = artifacts.sink.register('log', 'wrong.txt', ticket);
  await artifacts.settle();
  expect(puts).toEqual([]);
  expect(artifacts.debugRedactionProven(id)).toBe(false);
  expect(artifacts.debugMediaType(id)).toBeUndefined();
});

it('does not copy or store an opaque engine file while preserving original byte-verified MIME truth', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'e2e-opaque-custody-')); roots.push(root);
  let calls = 0;
  const secrecy = sessionSecrecy({} as TargetSession, new Map([['future', { name: 'future', purpose: 'generic-secret', value: () => { calls++; return 'future-value-R8'; } }]]));
  const puts: StoredArtifact[] = [];
  const artifacts = custody.createAttemptArtifacts({ artifactsRoot: root, segments: ['attempt'], attemptId: 'attempt', safePaths: true, secrecy: () => secrecy,
    store: { async put(artifact) { puts.push(artifact); return { ref: artifact.sha256 }; } },
  });
  const ticket = custody.debugEvidenceRegistration(artifacts.sink);
  writeFileSync(path.join(artifacts.dir, 'engine.png'), original);
  const writing = vi.spyOn(fs, 'writeFileSync');
  syncBuiltinESMExports();
  const relative = await custody.bindDebugEvidenceFile(artifacts.sink, 'engine.png', ticket);
  const id = artifacts.sink.register('screenshot', relative, ticket);
  await artifacts.settle();
  expect(relative).toBe('engine.png');
  expect(writing).not.toHaveBeenCalled();
  expect(puts).toEqual([]);
  expect(calls).toBe(0);
  expect(artifacts.debugMediaType(id)).toBe('image/png');
  expect(artifacts.debugRedactionProven(id)).toBe(false);
});

it('keeps proven engine retention authoritative and never restores or copies a deleted source', async () => {
  const { artifacts, puts } = setup();
  const ticket = custody.debugEvidenceRegistration(artifacts.sink);
  const absolute = path.join(artifacts.dir, 'engine.png');
  writeFileSync(absolute, original);
  const writing = vi.spyOn(fs, 'writeFileSync');
  syncBuiltinESMExports();
  const relative = await custody.bindDebugEvidenceFile(artifacts.sink, 'engine.png', ticket);
  expect(relative).toBe('engine.png');
  expect(writing).not.toHaveBeenCalled();
  rmSync(absolute);
  const id = artifacts.sink.register('screenshot', relative, ticket);
  await artifacts.settle();
  expect(puts).toEqual([]);
  expect(artifacts.records[0]).not.toHaveProperty('path');
  expect(artifacts.debugMediaType(id)).toBeUndefined();
});
