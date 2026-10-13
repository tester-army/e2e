/** Private report seam for SDK-owned captures. Public checkpoint API proof awaits the combined branches. */
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { associateDebugCheckpoint, bindDebugEvidenceBytes, createAttemptArtifacts, debugEvidenceProven, debugEvidenceRegistration } from '../../src/run/artifacts.ts';
import type { DebugCheckpointAssociation } from '../../src/run/artifacts.ts';
import { buildDebugBundle, immutableReport } from '../../src/run/host-debug.ts';
import { resolveSecretValue, sessionSecrecy } from '../../src/run/secrecy.ts';
import type { ArtifactRegistration } from '../../src/run/fixtures.ts';
import { secrets } from '../../src/secrets.ts';
import type { TargetSession } from '../../src/engine/surface.ts';
import type { Report1Document } from '../../src/report/build.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);
ajv.addSchema(JSON.parse(readFileSync(new URL('../../schema/report-v1.schema.json', import.meta.url), 'utf8')));
const validate = ajv.compile(JSON.parse(readFileSync(new URL('../../schema/session-debug-v1.schema.json', import.meta.url), 'utf8')));
const owned: DebugCheckpointAssociation = { checkpointId: 'owned-checkpoint', phase: 'before', observationId: 'actual-capture', observationRevision: 'direct-revision' };

/** Creates an actual sink, registered producer and report. No filename or last-step inference. */
function setup(secrecy = sessionSecrecy({} as TargetSession, new Map())) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'checkpoint-export-')); dirs.push(root);
  const report = JSON.parse(readFileSync(new URL('../../schema/fixtures/session-debug-v1.valid.json', import.meta.url), 'utf8')).report as Report1Document;
  const attempt = report.run.results[0]!.attempts[0]!;
  // The wire fixture's steps use a different UUID; these real registrations
  // must model actual SDK attempt-owned steps, not borrow another run's IDs.
  for (const [index, ownedStep] of attempt.steps.entries()) ownedStep.id = `${attempt.id}:${index}`;
  const step = attempt.steps[0]!;
  step.observationRevision = 'last-step-is-not-capture';
  const artifacts = createAttemptArtifacts({ artifactsRoot: root, segments: ['attempt'], attemptId: attempt.id, safePaths: true, secrecy: () => secrecy });
  step.artifacts = [];
  attempt.artifacts = artifacts.records;
  const ticket = (kind: 'pixels' | 'checkpoint-json' = 'checkpoint-json', association = owned) =>
    associateDebugCheckpoint(debugEvidenceRegistration(artifacts.sink, kind), association, { stepId: step.id });
  const register = (registration = ticket(), retained = true, kind: 'log' | 'screenshot' = 'log', name = kind === 'log' ? 'opaque.json' : 'opaque.png') => {
    const bytes = kind === 'log' ? Buffer.from('{"semantics":"final-redacted-text"}') : Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    bindDebugEvidenceBytes(artifacts.sink, registration, bytes);
    if (retained) writeFileSync(path.join(artifacts.dir, name), bytes);
    const id = artifacts.sink.register(kind, name, registration);
    step.artifacts = [...step.artifacts, id];
    return id;
  };
  const exportBundle = async (unresolvedSecrets = false) => {
    await artifacts.settle();
    const redact = secrecy.ledger.redactFragments;
    const bundle = await buildDebugBundle({ report: immutableReport(report, redact, { unresolvedSecrets, artifacts }), artifacts, resultsDir: root, trace: 'written', redact, unresolvedSecrets });
    expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
    return bundle;
  };
  return { root, secrecy, artifacts, report, attempt, step, ticket, register, exportBundle };
}

it('exports explicit owned capture association rather than the last step revision', async () => {
  const f = setup(); f.register();
  const bundle = await f.exportBundle();
  expect(bundle.artifacts[0]).toMatchObject({ checkpoint: { id: 'owned-checkpoint', phase: 'before', observationId: 'actual-capture' }, observationRevision: 'direct-revision', evidence: { status: 'available' }, stepIds: [f.step.id] });
  expect(bundle.evidence[0]!.checkpoints).toBe('recorded');
});

it('reports registered-but-not-retained checkpoint evidence as recorded', async () => {
  const f = setup(); f.register(f.ticket(), false);
  const bundle = await f.exportBundle();
  expect(bundle.evidence[0]!.checkpoints).toBe('recorded');
  expect(bundle.artifacts[0]!.evidence).toEqual({ status: 'missing', reason: 'not-retained' });
});

it('never authorizes a bare marker even without a supplied secrecy callback', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'marker-export-')); dirs.push(root);
  const artifacts = createAttemptArtifacts({ artifactsRoot: root, segments: ['attempt'], attemptId: 'marker', safePaths: true });
  writeFileSync(path.join(artifacts.dir, 'forged.png'), 'unproven');
  const id = artifacts.sink.register('screenshot', 'forged.png', { debugEvidence: true });
  await artifacts.settle();
  expect(artifacts.debugEvidence.has(id)).toBe(false);
  expect(artifacts.debugRedactionProven(id)).toBe(false);
});

describe('owned checkpoint accounting', () => {
  it.each(['before', 'after'] as const)('exports proven semantic JSON and pixels for phase %s from original tickets', async (phase) => {
    const f = setup();
    const association = { ...owned, phase };
    f.register(f.ticket('checkpoint-json', association));
    const pixel = debugEvidenceRegistration(f.artifacts.sink);
    expect(debugEvidenceProven(f.artifacts.sink, pixel)).toBe(true);
    associateDebugCheckpoint(pixel, association, { stepId: f.step.id });
    expect(debugEvidenceProven(f.artifacts.sink, pixel)).toBe(true);
    f.register(pixel, true, 'screenshot');
    expect(debugEvidenceProven(f.artifacts.sink, pixel)).toBe(false);
    const bundle = await f.exportBundle();
    expect(bundle.artifacts).toHaveLength(2);
    for (const artifact of bundle.artifacts) {
      expect(artifact).toMatchObject({ checkpoint: { id: owned.checkpointId, phase, observationId: owned.observationId }, observationRevision: owned.observationRevision, evidence: { status: 'available' } });
    }
    expect(f.artifacts.records.every((record) => record.producer.kind === 'step' && record.producer.stepId === f.step.id)).toBe(true);
    expect(f.artifacts.debugCheckpoints.size).toBe(2);
  });

  it('keeps ordinary screenshot and semantic capture proof while withholding no-ticket files', async () => {
    const f = setup();
    f.register(debugEvidenceRegistration(f.artifacts.sink), true, 'screenshot');
    f.register(debugEvidenceRegistration(f.artifacts.sink, 'text'), true, 'log', 'screen-at-failure.txt');
    f.register({ debugEvidence: true }, true, 'log', 'consumer.json');
    const bundle = await f.exportBundle();
    expect(bundle.artifacts.slice(0, 2).every((a) => a.evidence.status === 'available' && a.checkpoint === undefined && a.observationRevision === null)).toBe(true);
    expect(bundle.artifacts[2]!.evidence.status).toBe('withheld');
    expect(bundle.evidence.every((step) => step.checkpoints === 'not-recorded')).toBe(true);
  });

  it.each(['copy', 'forged', 'cross-sink', 'reused'] as const)('rejects %s checkpoint tickets', async (mode) => {
    const f = setup(); const original = f.ticket();
    let registration: ArtifactRegistration = original;
    if (mode === 'copy') registration = { ...original };
    if (mode === 'forged') registration = { debugEvidence: true, stepId: f.step.id };
    if (mode === 'cross-sink') registration = setup().ticket();
    if (mode === 'reused') f.register(original, false);
    const id = f.register(registration);
    expect(f.artifacts.debugEvidence.has(id)).toBe(false);
    expect(f.artifacts.debugCheckpoints.has(id)).toBe(false);
    expect(f.artifacts.debugRedactionProven(id)).toBe(false);
    const bundle = await f.exportBundle();
    const row = bundle.artifacts.find((a) => a.id === id)!;
    expect(row.checkpoint).toBeUndefined();
    expect(row.observationRevision).toBeNull();
    expect(row.evidence.status).toBe('withheld');
    if (mode !== 'reused') expect(bundle.evidence[0]!.checkpoints).toBe('not-recorded');
  });

  it('consumes an original ticket even when its public marker was removed on first registration', async () => {
    const f = setup(); const registration = f.ticket();
    Object.assign(registration, { debugEvidence: false });
    f.register(registration, false);
    Object.assign(registration, { debugEvidence: true });
    const id = f.register(registration);
    expect(f.artifacts.debugEvidence.has(id)).toBe(false);
    expect(f.artifacts.debugCheckpoints.has(id)).toBe(false);
    expect((await f.exportBundle()).artifacts.every((row) => row.evidence.status !== 'available')).toBe(true);
  });

  it('rejects double association rather than silently replacing the original', async () => {
    const f = setup(); const registration = f.ticket();
    associateDebugCheckpoint(registration, { ...owned, phase: 'after' }, { stepId: f.step.id });
    f.register(registration);
    expect((await f.exportBundle()).evidence[0]!.checkpoints).toBe('not-recorded');
  });

  it.each([
    { checkpointId: '' }, { checkpointId: 'x'.repeat(1025) }, { checkpointId: 'é'.repeat(513) },
    { checkpointId: 'x\n' }, { checkpointId: 'x\u007f' }, { phase: 'during' },
    { observationId: '' }, { observationRevision: '' }, { observationId: undefined },
    { observationRevision: undefined }, { observationId: null }, { observationRevision: null },
    { observationRevision: 'x'.repeat(1025) }, { observationId: 'é'.repeat(513) },
  ])('fails closed for invalid association %j without clipping an ID', async (invalid) => {
    const f = setup();
    const association = { ...owned, ...invalid } as unknown as DebugCheckpointAssociation;
    f.register(f.ticket('checkpoint-json', association));
    const bundle = await f.exportBundle();
    expect(bundle.artifacts[0]!.checkpoint).toBeUndefined();
    expect(bundle.artifacts[0]!.observationRevision).toBeNull();
    expect(bundle.artifacts[0]!.evidence.status).toBe('withheld');
    expect(bundle.evidence[0]!.checkpoints).toBe('not-recorded');
  });

  it('copies and freezes bounded identity while ignoring unknown private metadata', async () => {
    const f = setup();
    const association = { checkpointId: 'x'.repeat(1024), phase: 'after' as const, observationId: 'é'.repeat(512), observationRevision: 'r'.repeat(1024), nativeXml: '<private-tree/>' };
    const registration = f.ticket('checkpoint-json', association);
    association.checkpointId = 'late-mutation';
    const id = f.register(registration);
    const stored = f.artifacts.debugCheckpoints.get(id)!;
    expect(Object.isFrozen(stored)).toBe(true);
    expect(stored.checkpointId).toHaveLength(1024);
    expect(stored).not.toHaveProperty('nativeXml');
    const bundle = await f.exportBundle();
    expect(Object.isFrozen(bundle.artifacts[0]!.checkpoint)).toBe(true);
    expect(JSON.stringify(bundle)).not.toContain('late-mutation');
    expect(JSON.stringify(bundle)).not.toContain('private-tree');
  });

  it('keeps missing observation identity and revision null without guessing', async () => {
    const f = setup(); f.register(f.ticket('checkpoint-json', { ...owned, observationId: null, observationRevision: null }));
    const row = (await f.exportBundle()).artifacts[0]!;
    expect(row.checkpoint?.observationId).toBeNull();
    expect(row.observationRevision).toBeNull();
    expect(row.evidence.status).toBe('available');
  });

  it.each(['observationId', 'observationRevision', 'checkpointId'] as const)('withholds known-secret %s instead of inventing an association', async (key) => {
    const secrecy = sessionSecrecy({} as TargetSession, new Map([['captureSecret', { name: 'captureSecret', purpose: 'generic-secret', value: 'capture-secret-P8j7' }]]));
    const f = setup(secrecy);
    f.register(f.ticket('checkpoint-json', { ...owned, [key]: 'capture-secret-P8j7' }));
    const bundle = await f.exportBundle();
    expect(JSON.stringify(bundle)).not.toContain('capture-secret-P8j7');
    const row = bundle.artifacts[0]!;
    expect(row.evidence).toEqual({ status: 'withheld', reason: 'incomplete-redaction' });
    expect(row.observationRevision).toBeNull();
    if (key === 'checkpointId') expect(row.checkpoint).toBeUndefined();
    else expect(row.checkpoint?.observationId).toBeNull();
    expect(bundle.evidence[0]!.checkpoints).toBe('recorded');
    expect(bundle.report.run.results[0]!.attempts[0]!.artifacts[0]).not.toHaveProperty('path');
  });

  it('preserves before/after only at validated structural paths, not in user prose', async () => {
    const secrecy = sessionSecrecy({} as TargetSession, new Map([['phaseToken', { name: 'phaseToken', purpose: 'generic-secret', value: 'before' }]]));
    const f = setup(secrecy); f.step.label = 'before';
    f.register();
    const bundle = await f.exportBundle();
    expect(bundle.artifacts[0]!.checkpoint?.phase).toBe('before');
    expect(bundle.report.run.results[0]!.attempts[0]!.steps[0]!.label).toBe('<secret:phaseToken>');
  });

  it.each(['stale', 'pending', 'failed', 'tainted'] as const)('keeps registered checkpoint truth but withholds %s pixel proof', async (mode) => {
    const f = setup(); const registration = f.ticket('pixels');
    f.register(registration, true, 'screenshot');
    let release: (() => void) | undefined;
    let pending: Promise<string> | undefined;
    if (mode === 'stale') f.secrecy.ledger.register('late', 'late-secret-H7k9');
    if (mode === 'tainted') f.secrecy.exposure.raise('filled');
    if (mode === 'pending' || mode === 'failed') {
      const wait = new Promise<void>((resolve) => { release = resolve; });
      const config = new Map([['late', { name: 'late', purpose: 'generic-secret' as const, value: async () => { if (mode === 'failed') throw new Error('no value'); await wait; return 'late-secret-H7k9'; } }]]);
      pending = resolveSecretValue(secrets.get('late'), config, f.secrecy.ledger);
      if (mode === 'failed') await expect(pending).rejects.toThrow('no value');
    }
    const bundle = await f.exportBundle(mode === 'pending' || mode === 'failed');
    const before = JSON.stringify(bundle);
    expect(bundle.artifacts[0]).toMatchObject({ observationRevision: null, evidence: { status: 'withheld', reason: 'incomplete-redaction' } });
    if (mode === 'pending' || mode === 'failed') expect(bundle.artifacts[0]!.checkpoint).toBeUndefined();
    else expect(bundle.artifacts[0]!.checkpoint).toMatchObject({ id: owned.checkpointId, observationId: null });
    expect(bundle.evidence[0]!.checkpoints).toBe('recorded');
    if (mode === 'pending') { release!(); await pending; expect(JSON.stringify(bundle)).toBe(before); }
  });

  it('never repairs a capture-start pending proof by resolving before pixel registration', async () => {
    const f = setup(); let release!: () => void;
    const config = new Map([['late', { name: 'late', purpose: 'generic-secret' as const, value: async () => { await new Promise<void>((resolve) => { release = resolve; }); return 'late-secret-H7k9'; } }]]);
    const pending = resolveSecretValue(secrets.get('late'), config, f.secrecy.ledger);
    const registration = f.ticket('pixels');
    expect(debugEvidenceProven(f.artifacts.sink, registration)).toBe(false);
    release(); await pending;
    expect(debugEvidenceProven(f.artifacts.sink, registration)).toBe(false);
    f.register(registration, false, 'screenshot');
    expect((await f.exportBundle()).artifacts[0]!.evidence.status).toBe('withheld');
  });

  it('allows final-redacted semantic JSON after late secrets, without minting new pixel proof', async () => {
    const f = setup(); const pixel = f.ticket('pixels');
    f.secrecy.ledger.register('late', 'late-secret-H7k9');
    expect(debugEvidenceProven(f.artifacts.sink, pixel)).toBe(false);
    const json = debugEvidenceRegistration(f.artifacts.sink, 'checkpoint-json', { association: owned, facts: { stepId: f.step.id } });
    f.register(json);
    f.register(pixel, false, 'screenshot');
    const bundle = await f.exportBundle();
    expect(bundle.artifacts[0]!.evidence.status).toBe('available');
    expect(bundle.artifacts[1]!.evidence.status).toBe('withheld');
  });

  it.each(['changed-file', 'symlink', 'absent'] as const)('keeps recorded checkpoint metadata while refusing %s bytes', async (mode) => {
    const f = setup(); f.register(); await f.artifacts.settle();
    const file = path.join(f.artifacts.dir, 'opaque.json');
    if (mode === 'changed-file') writeFileSync(file, '{"semantics":"new-text-same-size"}');
    else {
      rmSync(file);
      if (mode === 'symlink') { writeFileSync(path.join(f.root, 'external.json'), 'untrusted'); symlinkSync(path.join(f.root, 'external.json'), file); }
    }
    const bundle = await f.exportBundle();
    expect(bundle.evidence[0]!.checkpoints).toBe('recorded');
    expect(bundle.artifacts[0]!.evidence).toEqual(mode === 'absent' ? { status: 'missing', reason: 'not-retained' } : { status: 'withheld', reason: mode === 'symlink' ? 'unsafe-path' : 'changed-file' });
    expect(bundle.artifacts[0]!.checkpoint?.observationId).toBe(owned.observationId);
  });

  it('does not associate unregistered filenames, unknown producers or a borrowed last step', async () => {
    const f = setup();
    writeFileSync(path.join(f.artifacts.dir, 'step-0-before.json'), '{"unregistered":true}');
    f.register();
    f.artifacts.records[0]!.producer = { kind: 'step', stepId: 'unknown-step' };
    f.step.artifacts = [];
    const bundle = await f.exportBundle();
    expect(bundle.artifacts[0]!.checkpoint).toBeUndefined();
    expect(bundle.artifacts[0]!.observationRevision).toBeNull();
    expect(bundle.artifacts[0]!.evidence.status).toBe('withheld');
    expect(bundle.evidence.every((step) => step.checkpoints === 'not-recorded')).toBe(true);
    expect(JSON.stringify(bundle)).not.toContain('step-0-before.json');
  });

  it('marks only the actual registered producer as recorded, preserving ordered steps', async () => {
    const f = setup(); const id = f.register();
    f.attempt.steps[1]!.artifacts = [id];
    const bundle = await f.exportBundle();
    expect(bundle.artifacts[0]!.stepIds).toEqual([f.step.id, f.attempt.steps[1]!.id]);
    expect(bundle.evidence.map((step) => step.checkpoints)).toEqual(['recorded', 'not-recorded']);
  });

  it.each(['log', 'screenshot'] as const)('rejects mismatched ticket/file media for %s', async (kind) => {
    const f = setup();
    f.register(f.ticket(kind === 'log' ? 'checkpoint-json' : 'pixels'), true, kind, 'wrong.txt');
    const bundle = await f.exportBundle();
    expect(bundle.artifacts[0]!.checkpoint).toBeUndefined();
    expect(bundle.artifacts[0]!.evidence.status).toBe('withheld');
  });
});

describe('session-debug-1 association schema', () => {
  function fixture() { return JSON.parse(readFileSync(new URL('../../schema/fixtures/session-debug-v1.valid.json', import.meta.url), 'utf8')); }
  it('accepts the old null/not-recorded fixtures without optional checkpoint metadata', () => {
    const bundle = fixture();
    for (const row of bundle.artifacts) { delete row.checkpoint; row.observationRevision = null; }
    for (const step of bundle.evidence) step.checkpoints = 'not-recorded';
    expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
  });
  it.each([
    { id: '' }, { id: 'x'.repeat(1025) }, { phase: 'during' }, { phase: null },
    { observationId: '' }, { observationId: 42 }, { observationId: 'x\n' }, { observationId: 'x\u007f' },
    { observationId: null }, { observationId: undefined }, { extra: true },
  ])('rejects bad association fields %j', (invalid) => {
    const bundle = fixture(); Object.assign(bundle.artifacts[0].checkpoint, invalid);
    expect(validate(bundle)).toBe(false);
  });
  it.each(['', 'x'.repeat(1025), 1, undefined, null, 'x\n'])('rejects unpaired or invalid revision %s', (revision) => {
    const bundle = fixture(); bundle.artifacts[0].observationRevision = revision;
    expect(validate(bundle)).toBe(false);
  });
  it('rejects associationless nonnull revisions and missing step associations', () => {
    const bundle = fixture(); delete bundle.artifacts[0].checkpoint;
    expect(validate(bundle)).toBe(false);
    bundle.artifacts[0].observationRevision = null;
    expect(validate(bundle)).toBe(true);
    bundle.artifacts[1].stepIds = [];
    expect(validate(bundle)).toBe(false);
  });
});

it('keeps independently registered JSON media truth while masking the same secret in prose', async () => {
  const secrecy = sessionSecrecy({} as TargetSession, new Map([['mime', { name: 'mime', purpose: 'generic-secret', value: 'application/json' }]]));
  const f = setup(secrecy); f.step.label = 'application/json'; f.register();
  const bundle = await f.exportBundle();
  expect(bundle.artifacts[0]!.mediaType).toBe('application/json');
  expect(bundle.report.run.results[0]!.attempts[0]!.artifacts[0]!.mediaType).toBe('application/json');
  expect(bundle.report.run.results[0]!.attempts[0]!.steps[0]!.label).toBe('<secret:mime>');
  expect(bundle.artifacts[0]!.evidence.status).toBe('available');
});

it.each(['no-ticket', 'copied', 'cross-sink', 'invalid-bytes', 'changed-media', 'changed-digest'] as const)('does not mint MIME authority from %s', async (mode) => {
  const secrecy = sessionSecrecy({} as TargetSession, new Map([['mime', { name: 'mime', purpose: 'generic-secret', value: 'application/json' }]]));
  const f = setup(secrecy);
  const ticket = f.ticket();
  const registration = mode === 'no-ticket' ? { debugEvidence: true }
    : mode === 'copied' ? { ...ticket } : mode === 'cross-sink' ? setup().ticket() : ticket;
  const id = f.register(registration);
  if (mode === 'invalid-bytes') writeFileSync(path.join(f.artifacts.dir, 'opaque.json'), 'not JSON');
  await f.artifacts.settle();
  if (mode === 'changed-media') f.artifacts.records[0]!.mediaType = 'image/png';
  if (mode === 'changed-digest') f.artifacts.records[0]!.sha256 = 'a'.repeat(64);
  expect(f.artifacts.debugMediaType(id)).toBeUndefined();
  const bundle = await f.exportBundle();
  if (mode !== 'changed-media') {
    expect(bundle.artifacts).toEqual([]);
    expect(bundle.report.run.results[0]!.attempts[0]!.steps[0]!.artifacts).toEqual([]);
  } else expect(bundle.artifacts[0]!.evidence.status).toBe('withheld');
});
