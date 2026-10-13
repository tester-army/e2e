/** Source-private sink tests keep ordinary completeness separate from hosted admission. */
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { bindDebugEvidenceFile, createAttemptArtifacts, debugEvidenceRegistration } from '../../src/run/artifacts.ts';
import { resolveSecretValue, sessionSecrecy } from '../../src/run/secrecy.ts';
import { secrets } from '../../src/secrets.ts';
import type { TargetSession } from '../../src/engine/surface.ts';
import type { StoredArtifact } from '../../src/types.ts';

const roots: string[] = [];
const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 11]);
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function setup(store: boolean, safePaths = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-legacy-proof-')); roots.push(root);
  const session = {} as TargetSession;
  const secrecy = sessionSecrecy(session, new Map());
  const puts: StoredArtifact[] = [];
  const artifacts = createAttemptArtifacts({ artifactsRoot: root, segments: ['attempt'], attemptId: 'attempt', safePaths, secrecy: () => secrecy,
    ...(store ? { store: { async put(artifact: StoredArtifact) { puts.push({ ...artifact, bytes: new Uint8Array(artifact.bytes) }); return { ref: artifact.sha256 }; } } } : {}),
  });
  return { artifacts, puts, secrecy, session };
}

it.each([true, false].flatMap((safePaths) => [true, false].flatMap((store) => ['none', 'ledger', 'pending', 'failed', 'opaque', 'taint'].map((change) => [safePaths, store, change] as const))))('rechecks legacy live proof after async I/O, hosted=%s store=%s change=%s', async (safePaths, store, change) => {
  const { artifacts, puts, secrecy, session } = setup(store, safePaths);
  fs.writeFileSync(path.join(artifacts.dir, 'custom.png'), bytes);
  let release!: () => void, resolveProvider!: (value: string) => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const open = fsPromises.open, read = fsPromises.readFile, stat = fsPromises.stat;
  vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => { await barrier; return open(...args); });
  vi.spyOn(fsPromises, 'readFile').mockImplementation(async (...args) => { await barrier; return read(...args); });
  vi.spyOn(fsPromises, 'stat').mockImplementation(async (...args) => { await barrier; return stat(...args); });
  syncBuiltinESMExports();
  const id = artifacts.sink.register('screenshot', 'custom.png', { debugEvidence: true });
  expect(artifacts.records[0]!.redaction).toBe('complete');
  let resolution: Promise<unknown> | undefined;
  if (change === 'ledger') secrecy.ledger.register('late', 'late-literal-R9');
  if (change === 'taint') secrecy.exposure.raise('filled');
  if (change === 'failed') await resolveSecretValue(secrets.get('missing'), new Map(), secrecy.ledger).catch(() => undefined);
  if (change === 'opaque') sessionSecrecy(session, new Map([['late', { name: 'late', purpose: 'generic-secret', value: () => { throw new Error('must not resolve'); } }]]));
  if (change === 'pending') resolution = resolveSecretValue(secrets.get('late'), new Map([['late', { name: 'late', purpose: 'generic-secret', value: () => new Promise<string>((resolve) => { resolveProvider = resolve; }) }]]), secrecy.ledger);
  try {
    release(); await artifacts.settle();
    expect(artifacts.records[0]!.redaction).toBe(change === 'none' ? 'complete' : 'incomplete');
    expect(puts).toHaveLength(store && change === 'none' ? 1 : 0);
    if (puts.length > 0) {
      expect(puts[0]!.redaction).toBe('complete');
      expect(Buffer.from(puts[0]!.bytes)).toEqual(bytes);
    }
    expect(artifacts.debugRedactionProven(id)).toBe(false);
    expect(artifacts.debugEvidence.has(id)).toBe(false);
  } finally { release(); resolveProvider?.('late-resolved-R9'); await resolution; }
});

it.each([true, false])('keeps original ticket late-taint ordinary metadata truthful, store=%s', async (store) => {
  const { artifacts, puts, secrecy } = setup(store);
  const ticket = debugEvidenceRegistration(artifacts.sink);
  fs.writeFileSync(path.join(artifacts.dir, 'sdk.png'), bytes);
  await bindDebugEvidenceFile(artifacts.sink, 'sdk.png', ticket);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const open = fsPromises.open;
  vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => { await barrier; return open(...args); });
  syncBuiltinESMExports();
  const id = artifacts.sink.register('screenshot', 'sdk.png', ticket);
  secrecy.exposure.raise('filled');
  release(); await artifacts.settle();
  expect(puts).toEqual([]);
  expect(artifacts.records[0]!.redaction).toBe('incomplete');
  expect(artifacts.debugRedactionProven(id)).toBe(false);
  expect(artifacts.debugMediaType(id)).toBe('image/png');
});

it.each([true, false].flatMap((store) => ['capture.png', 'capture image.png', 'écran.png', 'nested/capture image.png'].map((name) => [store, name] as const)))('binds contained original engine bytes independently of hosted filename grammar, store=%s name=%s', async (store, name) => {
  const { artifacts, puts } = setup(store, false);
  fs.mkdirSync(path.dirname(path.join(artifacts.dir, name)), { recursive: true });
  fs.writeFileSync(path.join(artifacts.dir, name), bytes);
  const ticket = debugEvidenceRegistration(artifacts.sink);
  expect(await bindDebugEvidenceFile(artifacts.sink, name, ticket)).toBe(name);
  const id = artifacts.sink.register('screenshot', name, ticket);
  await artifacts.settle();
  expect(artifacts.records[0]).toMatchObject({ path: 'attempt/' + name, redaction: 'complete', size: bytes.length });
  expect(artifacts.debugRedactionProven(id)).toBe(true);
  if (store) { expect(puts).toHaveLength(1); expect(Buffer.from(puts[0]!.bytes)).toEqual(bytes); }
});

it.each(['../outside.png', 'nested/../source.png', './source.png', '/absolute.png', 'C:\\outside.png', 'parent-link/source.png', 'final-link.png', 'hardlink.png', 'directory', 'deleted.png'])('never binds unsafe engine files even for ordinary stores: %s', async (name) => {
  const { artifacts, puts } = setup(true, false);
  const source = path.join(artifacts.dir, 'source.png');
  if (['nested/../source.png', './source.png', 'parent-link/source.png', 'final-link.png', 'hardlink.png'].includes(name)) fs.writeFileSync(source, bytes);
  if (name === '../outside.png') fs.writeFileSync(path.join(artifacts.dir, '..', 'outside.png'), bytes);
  if (name === 'nested/../source.png') fs.mkdirSync(path.join(artifacts.dir, 'nested'));
  if (name === 'directory') fs.mkdirSync(path.join(artifacts.dir, 'directory'));
  if (name === 'parent-link/source.png') fs.symlinkSync(artifacts.dir, path.join(artifacts.dir, 'parent-link'), process.platform === 'win32' ? 'junction' : 'dir');
  if (name === 'final-link.png') fs.symlinkSync(source, path.join(artifacts.dir, 'final-link.png'), 'file');
  if (name === 'hardlink.png') fs.linkSync(source, path.join(artifacts.dir, name));
  const ticket = debugEvidenceRegistration(artifacts.sink);
  await bindDebugEvidenceFile(artifacts.sink, name, ticket);
  const id = artifacts.sink.register('screenshot', name, ticket);
  await artifacts.settle();
  expect(puts).toEqual([]);
  expect(artifacts.records[0]).not.toHaveProperty('path');
  expect(artifacts.debugMediaType(id)).toBeUndefined();
});

it.each(['capture image.png', 'écran.png'])('keeps hosted manifest portability strict: %s', async (name) => {
  const { artifacts, puts } = setup(true);
  fs.writeFileSync(path.join(artifacts.dir, name), bytes);
  const ticket = debugEvidenceRegistration(artifacts.sink);
  await bindDebugEvidenceFile(artifacts.sink, name, ticket);
  const id = artifacts.sink.register('screenshot', name, ticket);
  await artifacts.settle();
  expect(puts).toEqual([]);
  expect(artifacts.records[0]).not.toHaveProperty('path');
  expect(artifacts.records[0]!.redaction).toBe('incomplete');
  expect(artifacts.debugMediaType(id)).toBeUndefined();
});

it.each([true, false].flatMap((safePaths) => [true, false].map((store) => [safePaths, store] as const)))('keeps late unsafe metadata incomplete even when the async read fails, hosted=%s store=%s', async (safePaths, store) => {
  const { artifacts, puts, secrecy } = setup(store, safePaths);
  const absolute = path.join(artifacts.dir, 'custom.png');
  fs.writeFileSync(absolute, bytes);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const open = fsPromises.open, read = fsPromises.readFile, stat = fsPromises.stat;
  vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => { await barrier; return open(...args); });
  vi.spyOn(fsPromises, 'readFile').mockImplementation(async (...args) => { await barrier; return read(...args); });
  vi.spyOn(fsPromises, 'stat').mockImplementation(async (...args) => { await barrier; return stat(...args); });
  syncBuiltinESMExports();
  artifacts.sink.register('screenshot', 'custom.png', { debugEvidence: true });
  secrecy.exposure.raise('filled');
  fs.rmSync(absolute);
  release(); await artifacts.settle();
  expect(puts).toEqual([]);
  expect(artifacts.records[0]).toMatchObject({ redaction: 'incomplete' });
  expect(artifacts.records[0]).not.toHaveProperty('path');
});
