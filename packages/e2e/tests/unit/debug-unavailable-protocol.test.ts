/** Source-private SDK-facts byte permission. No CP collector or public ingress claim. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as protocol from '../../src/run/checkpoint-unavailable.ts';
import * as custody from '../../src/run/artifacts.ts';
import { buildDebugBundle, immutableReport } from '../../src/run/host-debug.ts';
import { sessionSecrecy } from '../../src/run/secrecy.ts';
import type { TargetSession } from '../../src/engine/surface.ts';
import type { ArtifactRegistration, ArtifactSink } from '../../src/run/fixtures.ts';
import type { Report1Document } from '../../src/report/build.ts';
import type { StoredArtifact } from '../../src/types.ts';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Missing new helper on 92bd is a compatibility failure, not an isolated old-source exploit. */
function proven(sink: ArtifactSink, registration: ArtifactRegistration, bytes: Uint8Array): boolean {
  const helper = Reflect.get(custody, 'debugEvidenceBytesProven') as ((sink: ArtifactSink, registration: ArtifactRegistration, bytes: Uint8Array) => boolean) | undefined;
  return helper?.(sink, registration, bytes) ?? false;
}

/** Sink attempt is authoritative; JSON and public registration facts cannot supply it. */
function setup(store = true, safePaths = true, opaque = true) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'e2e-unavailable-protocol-')); roots.push(root);
  let providers = 0, getters = 0;
  const observe = vi.fn();
  const definition = { name: 'token', purpose: 'generic-secret' as const, value: () => { providers++; return 'future-secret-A21'; } };
  if (opaque) Object.defineProperty(definition, 'value', { get() { getters++; return () => { providers++; return 'future-secret-A21'; }; } });
  const secrecy = sessionSecrecy({ observe } as unknown as TargetSession, opaque ? new Map([['token', definition]]) : new Map());
  const report = JSON.parse(readFileSync(new URL('../../schema/fixtures/session-debug-v1.valid.json', import.meta.url), 'utf8')).report as Report1Document;
  const attempt = report.run.results[0]!.attempts[0]!;
  for (const [index, step] of attempt.steps.entries()) { step.id = `${attempt.id}:${index}`; step.artifacts = []; }
  const step = attempt.steps[0]!;
  const puts: StoredArtifact[] = [];
  const artifacts = custody.createAttemptArtifacts({ artifactsRoot: root, segments: ['attempt'], attemptId: attempt.id, safePaths, secrecy: () => secrecy,
    ...(store ? { store: { async put(artifact: StoredArtifact) { puts.push({ ...artifact, bytes: Uint8Array.from(artifact.bytes) }); return { ref: artifact.sha256 }; } } } : {}),
  });
  attempt.artifacts = artifacts.records;
  const originalStartedAt = '2026-10-01T00:00:00.000Z';
  const association = { checkpointId: `${step.id}:checkpoint:before`, phase: 'before' as const, observationId: null, observationRevision: null };
  const record = { format: 'debug-checkpoint-1', id: association.checkpointId, attemptId: attempt.id, stepId: step.id, stepIndex: step.index,
    phase: 'before', attemptedAt: originalStartedAt, semantics: { status: 'unavailable', reason: 'CAPTURE_UNAVAILABLE' }, image: { status: 'unavailable', reason: 'CAPTURE_UNAVAILABLE' } };
  const ticket = (kind = 'checkpoint-unavailable') => custody.debugEvidenceRegistration(artifacts.sink, kind as Parameters<typeof custody.debugEvidenceRegistration>[1], { association, facts: { stepId: step.id, startedAt: originalStartedAt } });
  const persist = (bytes: Uint8Array, registration: ArtifactRegistration, guarded = true) => {
    // The guarded write is the FIRST persistence oracle. Direct writes below are explicit sink fault injection.
    if (guarded && !proven(artifacts.sink, registration, bytes)) return undefined;
    mkdirSync(path.join(artifacts.dir, 'debug'), { recursive: true });
    writeFileSync(path.join(artifacts.dir, 'debug/step-0-before.json'), bytes);
    const id = artifacts.sink.register('log', 'debug/step-0-before.json', registration); step.artifacts = [...step.artifacts, id];
    return id;
  };
  const bundle = async () => {
    await artifacts.settle();
    return buildDebugBundle({ report: immutableReport(report, secrecy.ledger.redactFragments, { artifacts, unresolvedSecrets: opaque, prospectiveSecrets: opaque }), artifacts,
      resultsDir: root, trace: 'written', redact: secrecy.ledger.redactFragments, unresolvedSecrets: opaque });
  };
  return { root, report, attempt, step, artifacts, puts, association, record, originalStartedAt, ticket, persist, bundle, counts: () => ({ providers, getters, observations: observe.mock.calls.length }) };
}

const variants = [true, false].flatMap((store) => [true, false].flatMap((safePaths) => [true, false].map((opaque) => ({ store, safePaths, opaque }))));
it.each(variants.flatMap((variant) => ['', '\n'].map((lf) => ({ ...variant, lf }))))('admits genuine canonical fixed bytes BEFORE write with optional LF, store=$store safePaths=$safePaths opaque=$opaque lf=$lf', async ({ store, safePaths, opaque, lf }) => {
  const h = setup(store, safePaths, opaque);
  const registration = h.ticket(); const bytes = Buffer.from(JSON.stringify(h.record) + lf);
  custody.bindDebugEvidenceBytes(h.artifacts.sink, registration, bytes);
  expect(existsSync(path.join(h.artifacts.dir, 'debug/step-0-before.json'))).toBe(false);
  expect(proven(h.artifacts.sink, registration, bytes)).toBe(true);
  // Registration fields are not the private step association.
  Object.assign(registration, { stepId: 'caller-supplied-step' });
  expect(proven(h.artifacts.sink, registration, bytes)).toBe(true);
  const id = h.persist(bytes, registration)!;
  await h.artifacts.settle();
  expect(proven(h.artifacts.sink, registration, bytes)).toBe(false);
  expect(h.artifacts.debugMediaType(id)).toBe('application/json');
  expect(h.artifacts.debugRedactionProven(id)).toBe(true);
  expect(h.puts).toHaveLength(store ? 1 : 0);
  if (store) expect(h.puts[0]).toMatchObject({ redaction: 'complete', bytes: Uint8Array.from(bytes), sha256: createHash('sha256').update(bytes).digest('hex'), stepId: h.step.id });
  const bundle = await h.bundle();
  expect(bundle.artifacts).toHaveLength(1);
  expect(bundle.artifacts[0]).toMatchObject({ evidence: { status: 'available', path: 'debug/step-0-before.json', size: bytes.length },
    checkpoint: { id: h.association.checkpointId, phase: 'before', observationId: null }, observationRevision: null, mediaType: 'application/json', stepIds: [h.step.id] });
  expect(bundle.evidence[0]!.checkpoints).toBe('recorded');
  expect(Object.isFrozen(bundle.artifacts[0])).toBe(true);
  expect(h.counts()).toEqual({ providers: 0, getters: 0, observations: 0 });
});

const malformed = ['unknown-reason', 'semantic-reason', 'prose', 'extra', 'capture', 'wrong-attempt', 'wrong-step', 'wrong-id', 'wrong-phase', 'wrong-index', 'unsafe-index', 'negative-index', 'bad-date', 'normalized-date', 'status', 'nonnull-image', 'duplicate-prose', 'nested-duplicate-prose', 'multiple-lf', 'trailing-space', 'trailing-json', 'leading-space', 'pretty-json', 'bom', 'invalid-utf8'] as const;
/** Matching original hashes do not certify a protocol; malformed bytes are bound deliberately. */
function invalid(h: ReturnType<typeof setup>, mode: typeof malformed[number]): Buffer {
  const record = structuredClone(h.record);
  if (mode === 'unknown-reason') record.image.reason = 'caller-prose';
  if (mode === 'semantic-reason') record.semantics.reason = 'ARTIFACT_UNAVAILABLE';
  if (mode === 'prose') Object.assign(record.semantics, { text: 'private-prose' });
  if (mode === 'extra') Object.assign(record, { extra: 'private-prose' });
  if (mode === 'capture') Object.assign(record, { observationId: 'capture', capturedAt: record.attemptedAt, viewport: { width: 1, height: 1 } });
  if (mode === 'wrong-attempt') record.attemptId = 'other-attempt';
  if (mode === 'wrong-step') record.stepId = `${h.attempt.id}:1`;
  if (mode === 'wrong-id') record.id = 'other-checkpoint';
  if (mode === 'wrong-phase') record.phase = 'after';
  if (mode === 'wrong-index') record.stepIndex = 1;
  if (mode === 'unsafe-index') record.stepIndex = Number.MAX_SAFE_INTEGER + 1;
  if (mode === 'negative-index') record.stepIndex = -1;
  if (mode === 'bad-date') record.attemptedAt = 'not-an-iso-date';
  if (mode === 'normalized-date') record.attemptedAt = '2026-02-30T00:00:00.000Z';
  if (mode === 'status') record.semantics.status = 'available';
  if (mode === 'nonnull-image') Object.assign(record.image, { data: 'pixel-prose' });
  const json = JSON.stringify(record);
  if (mode === 'duplicate-prose') return Buffer.from('{"semantics":{"text":"discarded-private-prose"},' + json.slice(1));
  if (mode === 'nested-duplicate-prose') return Buffer.from(json.replace('"reason":"CAPTURE_UNAVAILABLE"', '"reason":"discarded-private-prose","reason":"CAPTURE_UNAVAILABLE"'));
  if (mode === 'multiple-lf') return Buffer.from(json + '\n\n');
  if (mode === 'trailing-space') return Buffer.from(json + '\n ');
  if (mode === 'trailing-json') return Buffer.from(json + '\n{"prose":"trailing-private-prose"}');
  if (mode === 'leading-space') return Buffer.from(' ' + json);
  if (mode === 'pretty-json') return Buffer.from(JSON.stringify(record, null, 2));
  if (mode === 'bom') return Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(json)]);
  if (mode === 'invalid-utf8') return Buffer.concat([Buffer.from(json), Buffer.from([255])]);
  return Buffer.from(json);
}

it.each(variants.flatMap((variant) => malformed.map((mode) => ({ ...variant, mode }))))('denies $mode matching receipts BEFORE first file and also at sink, store=$store safePaths=$safePaths opaque=$opaque', async ({ store, safePaths, opaque, mode }) => {
  const h = setup(store, safePaths, opaque);
  const registration = h.ticket(); const bytes = invalid(h, mode);
  custody.bindDebugEvidenceBytes(h.artifacts.sink, registration, bytes);
  expect(proven(h.artifacts.sink, registration, bytes)).toBe(false);
  expect(h.persist(bytes, registration)).toBeUndefined();
  expect(existsSync(path.join(h.artifacts.dir, 'debug/step-0-before.json'))).toBe(false);
  expect(h.puts).toEqual([]);
  // Independent post-read sink defense, deliberately bypassing the producer guard.
  const id = h.persist(bytes, registration, false)!; await h.artifacts.settle();
  expect(h.puts).toEqual([]);
  expect(h.artifacts.records[0]).not.toHaveProperty('path');
  expect(h.artifacts.records[0]).not.toHaveProperty('size');
  expect(h.artifacts.records[0]).not.toHaveProperty('sha256');
  expect(h.artifacts.records[0]!.redaction).toBe('incomplete');
  expect(h.artifacts.debugMediaType(id)).toBeUndefined();
  expect(h.artifacts.debugRedactionProven(id)).toBe(false);
  const bundle = await h.bundle();
  if (opaque) {
    expect(bundle.artifacts).toEqual([]);
    expect(bundle.report.run.results[0]!.attempts[0]!.steps[0]!.artifacts).not.toContain(id);
  } else {
    expect(bundle.artifacts[0]!.evidence.status).toBe('withheld');
    expect(bundle.report.run.results[0]!.attempts[0]!.artifacts[0]).not.toHaveProperty('path');
  }
  expect(h.counts()).toEqual({ providers: 0, getters: 0, observations: 0 });
});

it.each(['missing', 'copy', 'spent', 'cross-sink', 'rebind', 'public-facts', 'generic-json', 'generic-text', 'pixels'] as const)('no prewrite SDK-facts authority for %s', async (mode) => {
  const h = setup();
  const kind = mode === 'generic-json' ? 'checkpoint-json' : mode === 'generic-text' ? 'text' : mode === 'pixels' ? 'pixels' : 'checkpoint-unavailable';
  let registration = mode === 'cross-sink' ? setup().ticket() : mode === 'public-facts' ? { debugEvidence: true, stepId: h.step.id } : h.ticket(kind);
  const bytes = Buffer.from(JSON.stringify(h.record));
  if (mode !== 'missing') custody.bindDebugEvidenceBytes(h.artifacts.sink, registration, bytes);
  if (mode === 'copy') registration = { ...registration };
  if (mode === 'spent') h.artifacts.sink.register('log', 'absent.json', registration);
  if (mode === 'rebind') custody.bindDebugEvidenceBytes(h.artifacts.sink, registration, bytes);
  Object.assign(registration, { expected: { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, attemptId: h.attempt.id, association: h.association });
  expect(proven(h.artifacts.sink, registration, bytes)).toBe(false);
  expect(h.persist(bytes, registration)).toBeUndefined();
  await h.artifacts.settle();
  expect(existsSync(path.join(h.artifacts.dir, 'debug/step-0-before.json'))).toBe(false);
  expect(h.puts).toEqual([]);
  expect(h.counts()).toEqual({ providers: 0, getters: 0, observations: 0 });
});

it.each(variants.flatMap((variant) => [true, false].map((sameSize) => ({ ...variant, sameSize }))))('rejects postread changed bytes with original immutable receipt, store=$store safePaths=$safePaths opaque=$opaque sameSize=$sameSize', async ({ store, safePaths, opaque, sameSize }) => {
  const h = setup(store, safePaths, opaque);
  const registration = h.ticket(); const bytes = Buffer.from(JSON.stringify(h.record));
  custody.bindDebugEvidenceBytes(h.artifacts.sink, registration, bytes);
  expect(proven(h.artifacts.sink, registration, bytes)).toBe(true);
  mkdirSync(path.join(h.artifacts.dir, 'debug'), { recursive: true });
  writeFileSync(path.join(h.artifacts.dir, 'debug/step-0-before.json'), bytes);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const open = fsPromises.open, readFile = fsPromises.readFile;
  vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => { await barrier; return open(...args); });
  vi.spyOn(fsPromises, 'readFile').mockImplementation(async (...args: Parameters<typeof readFile>) => { await barrier; return readFile(...args); });
  syncBuiltinESMExports();
  try {
    const id = h.artifacts.sink.register('log', 'debug/step-0-before.json', registration);
    const altered = Buffer.from(bytes); altered[altered.length - 2] = 32;
    writeFileSync(path.join(h.artifacts.dir, 'debug/step-0-before.json'), sameSize ? altered : Buffer.concat([altered, Buffer.from('extra')]));
    release(); await h.artifacts.settle();
    expect(h.puts).toEqual([]);
    expect(h.artifacts.records[0]).not.toHaveProperty('path');
    expect(h.artifacts.debugMediaType(id)).toBeUndefined();
    expect(h.artifacts.debugRedactionProven(id)).toBe(false);
  } finally { release(); }
});

it.each(['missing-file', 'deleted-after-settle'] as const)('keeps original checkpoint recorded independently of %s and omits unsafe MIME references', async (mode) => {
  const h = setup(false);
  const registration = h.ticket(); const bytes = Buffer.from(JSON.stringify(h.record));
  custody.bindDebugEvidenceBytes(h.artifacts.sink, registration, bytes);
  expect(proven(h.artifacts.sink, registration, bytes)).toBe(true);
  if (mode === 'missing-file') {
    const id = h.artifacts.sink.register('log', 'debug/step-0-before.json', registration);
    h.step.artifacts = [...h.step.artifacts, id];
  } else {
    h.persist(bytes, registration); await h.artifacts.settle();
    rmSync(path.join(h.artifacts.dir, 'debug/step-0-before.json'));
  }
  const bundle = await h.bundle();
  expect(bundle.evidence[0]!.checkpoints).toBe('recorded');
  if (mode === 'missing-file') {
    expect(bundle.artifacts).toEqual([]);
    expect(bundle.report.run.results[0]!.attempts[0]!.steps[0]!.artifacts).toEqual([]);
  } else expect(bundle.artifacts[0]!.evidence).toEqual({ status: 'missing', reason: 'not-retained' });
  expect(h.puts).toEqual([]);
});

it('rejects self-consistent alternate attempt/step/association JSON using the actual sink attempt', async () => {
  const h = setup();
  const foreignStep = 'other-attempt:0';
  const association = { ...h.association, checkpointId: foreignStep + ':checkpoint:before' };
  const registration = custody.debugEvidenceRegistration(h.artifacts.sink, 'checkpoint-unavailable', { association, facts: { stepId: foreignStep, startedAt: h.originalStartedAt } });
  const bytes = Buffer.from(JSON.stringify({ ...h.record, id: association.checkpointId, stepId: foreignStep, attemptId: 'other-attempt' }));
  custody.bindDebugEvidenceBytes(h.artifacts.sink, registration, bytes);
  expect(proven(h.artifacts.sink, registration, bytes)).toBe(false);
  expect(h.persist(bytes, registration)).toBeUndefined();
  h.persist(bytes, registration, false); await h.artifacts.settle();
  expect(h.puts).toEqual([]);
  expect(h.artifacts.records[0]).not.toHaveProperty('path');
});

it.each(['before', 'after'] as const)('accepts every closed missing reason at actual %s boundaries with no content privilege', async (phase) => {
  const reasons = ['UNSUPPORTED_CAPABILITY', 'CAPTURE_UNAVAILABLE', 'CAPTURE_TIMEOUT', 'CANCELLED', 'EVIDENCE_LIMIT'];
  for (const reason of reasons) {
    const h = setup();
    const association = { ...h.association, checkpointId: h.step.id + ':checkpoint:' + phase, phase };
    const registration = custody.debugEvidenceRegistration(h.artifacts.sink, 'checkpoint-unavailable', { association, facts: { stepId: h.step.id, startedAt: h.originalStartedAt } });
    const bytes = Buffer.from(JSON.stringify({ ...h.record, id: association.checkpointId, phase,
      semantics: { status: 'unavailable', reason }, image: { status: 'unavailable', reason: reason === 'EVIDENCE_LIMIT' ? 'ARTIFACT_UNAVAILABLE' : reason } }));
    custody.bindDebugEvidenceBytes(h.artifacts.sink, registration, bytes);
    expect(proven(h.artifacts.sink, registration, bytes)).toBe(true);
    h.persist(bytes, registration); await h.artifacts.settle();
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0]!.redaction).toBe('complete');
    expect(h.counts()).toEqual({ providers: 0, getters: 0, observations: 0 });
  }
});


it.each(variants.flatMap((variant) => ['shifted-original-time', 'missing-original-time'].map((mode) => ({ ...variant, mode }))))('requires ORIGINAL boundary time before first write and after read, $mode store=$store safePaths=$safePaths opaque=$opaque', async ({ store, safePaths, opaque, mode }) => {
  const h = setup(store, safePaths, opaque);
  const registration = mode === 'missing-original-time'
    ? custody.debugEvidenceRegistration(h.artifacts.sink, 'checkpoint-unavailable', { association: h.association, facts: { stepId: h.step.id } })
    : h.ticket();
  if (mode === 'shifted-original-time') h.record.attemptedAt = '2026-10-01T00:00:01.000Z';
  // Even a matching public time and original byte receipt cannot replace the source boundary.
  Object.assign(registration, { startedAt: h.record.attemptedAt });
  const bytes = Buffer.from(JSON.stringify(h.record));
  custody.bindDebugEvidenceBytes(h.artifacts.sink, registration, bytes);
  expect(proven(h.artifacts.sink, registration, bytes)).toBe(false);
  expect(h.persist(bytes, registration)).toBeUndefined();
  expect(existsSync(path.join(h.artifacts.dir, 'debug/step-0-before.json'))).toBe(false);
  expect(h.puts).toEqual([]);
  // Deliberate bypass separately tests the post-read sink, not actual CP collector persistence.
  const id = h.persist(bytes, registration, false)!; await h.artifacts.settle();
  expect(h.puts).toEqual([]);
  expect(h.artifacts.records[0]).toMatchObject({ redaction: 'incomplete' });
  for (const key of ['path', 'size', 'sha256', 'ref']) expect(h.artifacts.records[0]).not.toHaveProperty(key);
  expect(h.artifacts.debugMediaType(id)).toBeUndefined();
  expect(h.artifacts.debugUnavailableProven(id)).toBe(false);
  expect(h.artifacts.debugRedactionProven(id)).toBe(false);
  const bundle = await h.bundle();
  expect(bundle.evidence[0]!.checkpoints).toBe('recorded');
  if (opaque) {
    expect(bundle.artifacts).toEqual([]);
    expect(bundle.report.run.results[0]!.attempts[0]!.steps[0]!.artifacts).not.toContain(id);
  } else expect(bundle.artifacts[0]!.evidence.status).toBe('withheld');
  expect(h.counts()).toEqual({ providers: 0, getters: 0, observations: 0 });
});

it.each(variants.flatMap((variant) => ['shifted-original-time', 'missing-original-time'].map((mode) => ({ ...variant, mode }))))('separately denies ORIGINAL boundary mismatch at post-read sink, $mode store=$store safePaths=$safePaths opaque=$opaque', async ({ store, safePaths, opaque, mode }) => {
  const h = setup(store, safePaths, opaque);
  const registration = mode === 'missing-original-time'
    ? custody.debugEvidenceRegistration(h.artifacts.sink, 'checkpoint-unavailable', { association: h.association, facts: { stepId: h.step.id } })
    : h.ticket();
  if (mode === 'shifted-original-time') h.record.attemptedAt = '2026-10-01T00:00:01.000Z';
  // Even a matching public time and original byte receipt cannot replace the source boundary.
  Object.assign(registration, { startedAt: h.record.attemptedAt });
  const bytes = Buffer.from(JSON.stringify(h.record));
  custody.bindDebugEvidenceBytes(h.artifacts.sink, registration, bytes);
  // Direct-write injection isolates the sink guard from first-write failure.
  const id = h.persist(bytes, registration, false)!; await h.artifacts.settle();
  expect(h.puts).toEqual([]);
  expect(h.artifacts.records[0]).toMatchObject({ redaction: 'incomplete' });
  for (const key of ['path', 'size', 'sha256', 'ref']) expect(h.artifacts.records[0]).not.toHaveProperty(key);
  expect(h.artifacts.debugMediaType(id)).toBeUndefined();
  expect(h.artifacts.debugUnavailableProven(id)).toBe(false);
  expect(h.artifacts.debugRedactionProven(id)).toBe(false);
  const bundle = await h.bundle();
  expect(bundle.evidence[0]!.checkpoints).toBe('recorded');
  if (opaque) {
    expect(bundle.artifacts).toEqual([]);
    expect(bundle.report.run.results[0]!.attempts[0]!.steps[0]!.artifacts).not.toContain(id);
  } else expect(bundle.artifacts[0]!.evidence.status).toBe('withheld');
  expect(h.counts()).toEqual({ providers: 0, getters: 0, observations: 0 });
});

it.each(variants.flatMap((variant) => ['shifted', 'deleted'].map((mode) => ({ ...variant, mode }))))('public timestamp $mode mutation cannot alter original proof or reported source time, store=$store safePaths=$safePaths opaque=$opaque', async ({ store, safePaths, opaque, mode }) => {
  const h = setup(store, safePaths, opaque);
  const facts = { stepId: h.step.id, startedAt: h.originalStartedAt };
  const registration = custody.debugEvidenceRegistration(h.artifacts.sink, 'checkpoint-unavailable', { association: h.association, facts });
  facts.startedAt = '2026-10-01T00:00:02.000Z';
  Object.assign(registration, { startedAt: facts.startedAt, stepId: 'mutable-public-step' });
  if (mode === 'deleted') Reflect.deleteProperty(registration, 'startedAt');
  const bytes = Buffer.from(JSON.stringify(h.record));
  custody.bindDebugEvidenceBytes(h.artifacts.sink, registration, bytes);
  expect(proven(h.artifacts.sink, registration, bytes)).toBe(true);
  const id = h.persist(bytes, registration)!; await h.artifacts.settle();
  expect(h.artifacts.records[0]).toMatchObject({ startedAt: h.originalStartedAt, producer: { kind: 'step', stepId: h.step.id }, redaction: 'complete' });
  expect(h.artifacts.debugMediaType(id)).toBe('application/json');
  expect(h.puts).toHaveLength(store ? 1 : 0);
  if (store) expect(h.puts[0]).toMatchObject({ startedAt: h.originalStartedAt, bytes: Uint8Array.from(bytes), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), redaction: 'complete' });
  const bundle = await h.bundle();
  expect(bundle.artifacts[0]).toMatchObject({ mediaType: 'application/json', checkpoint: { id: h.association.checkpointId, phase: 'before', observationId: null }, observationRevision: null, evidence: { status: 'available' } });
  expect(bundle.report.run.results[0]!.attempts[0]!.artifacts[0]!.startedAt).toBe(h.originalStartedAt);
  expect(h.counts()).toEqual({ providers: 0, getters: 0, observations: 0 });
});

it.each(['invalid-phase', 'extended-iso', 'undefined-facts'] as const)('preventive pure canonical contract denies %s, not a new source exploit', (mode) => {
  const h = setup();
  const facts = { attemptId: h.attempt.id, stepId: h.step.id, attemptedAt: h.originalStartedAt, association: h.association };
  if (mode === 'invalid-phase') {
    Object.assign(facts.association, { phase: 'during', checkpointId: h.step.id + ':checkpoint:during' });
    Object.assign(h.record, { phase: 'during', id: facts.association.checkpointId });
  }
  if (mode === 'extended-iso') facts.attemptedAt = h.record.attemptedAt = '+010000-01-01T00:00:00.000Z';
  expect(protocol.checkpointUnavailableBytesProven(Buffer.from(JSON.stringify(h.record)), mode === 'undefined-facts' ? undefined : facts)).toBe(false);
});

it.each([true, false].flatMap((store) => ['text', 'pixels', 'checkpoint-json'].map((kind) => ({ store, kind }))))('ordinary genuine $kind remains complete without an unavailable source time, store=$store', async ({ store, kind }) => {
  const h = setup(store, true, false);
  const registration = kind === 'checkpoint-json'
    ? custody.debugEvidenceRegistration(h.artifacts.sink, kind, { association: h.association, facts: { stepId: h.step.id } })
    : custody.debugEvidenceRegistration(h.artifacts.sink, kind as 'text' | 'pixels');
  const bytes = kind === 'pixels' ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) : Buffer.from(kind === 'text' ? 'ordinary safe text' : '{"semantics":"safe"}');
  const relative = kind === 'pixels' ? 'ordinary.png' : kind === 'text' ? 'ordinary.txt' : 'ordinary.json';
  custody.bindDebugEvidenceBytes(h.artifacts.sink, registration, bytes);
  expect(proven(h.artifacts.sink, registration, bytes)).toBe(true);
  writeFileSync(path.join(h.artifacts.dir, relative), bytes);
  const id = h.artifacts.sink.register(kind === 'pixels' ? 'screenshot' : 'log', relative, registration);
  h.step.artifacts = [...h.step.artifacts, id]; await h.artifacts.settle();
  expect(h.artifacts.records[0]).toMatchObject({ redaction: 'complete', size: bytes.length });
  expect(h.artifacts.records[0]).not.toHaveProperty('startedAt');
  expect(h.puts).toHaveLength(store ? 1 : 0);
  if (store) expect(h.puts[0]).toMatchObject({ bytes: Uint8Array.from(bytes), redaction: 'complete' });
  expect((await h.bundle()).artifacts[0]!.evidence.status).toBe('available');
});
