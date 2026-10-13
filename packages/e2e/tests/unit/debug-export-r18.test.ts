/** Source-private regressions, not native rendering or new public failure capture. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { bindDebugEvidenceFile, bindDebugEvidenceBytes, createAttemptArtifacts, debugEvidenceRegistration, debugEvidenceBytesProven, associateDebugCheckpoint, debugEvidenceProven } from '../../src/run/artifacts.ts';
import { containedArtifactFile } from '../../src/run/artifact-path.ts';
import { buildDebugBundle, immutableReport } from '../../src/run/host-debug.ts';
import { captureFailureEvidence } from '../../src/run/failure-evidence.ts';
import { writeHostTrace, type HostTraceOptions } from '../../src/run/host-trace.ts';
import { E2EError } from '../../src/internal/errors.ts';
import { sessionSecrecy } from '../../src/run/secrecy.ts';
import type { StoredArtifact } from '../../src/types.ts';
import type { TargetSession } from '../../src/engine/surface.ts';
import type { Report1Document } from '../../src/report/build.ts';
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function setup(store = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-r18-')); roots.push(root);
  const secrecy = sessionSecrecy({} as TargetSession, new Map());
  const puts: StoredArtifact[] = [];
  const artifacts = createAttemptArtifacts({ artifactsRoot: root, segments: ['attempt'], attemptId: 'a', safePaths: true, secrecy: () => secrecy,
    ...(store ? { store: { async put(row: StoredArtifact) { puts.push(row); return { ref: row.sha256 }; } } } : {}),
  });
  const report = JSON.parse(fs.readFileSync(new URL('../../schema/fixtures/report-v1.valid.json', import.meta.url), 'utf8')) as Report1Document;
  report.run.results[0]!.attempts[0]!.artifacts = artifacts.records;
  return { root, artifacts, secrecy, report, puts };
}
it.each([true, false])('binds 2MiB original receipt asynchronously with bounded chunks and event-loop progress, store=%s', async (store) => {
  const { artifacts, puts } = setup(store);
  const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
  fs.writeFileSync(path.join(artifacts.dir, 'large.txt'), bytes);
  const ticket = debugEvidenceRegistration(artifacts.sink, 'text');
  const read = fs.readFileSync;
  let syncBytes = 0, chunks = 0, largest = 0, progressed = false, progressedDuringRead = false;
  vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    const result = read(...args); if (typeof args[0] === 'number') syncBytes += result.length; return result;
  }) as typeof fs.readFileSync);
  const stream = fs.createReadStream;
  vi.spyOn(fs, 'createReadStream').mockImplementation((...args) => {
    const value = stream(...args);
    value.on('data', (chunk: Buffer) => { chunks++; largest = Math.max(largest, chunk.length); progressedDuringRead ||= progressed; }); return value;
  });
  syncBuiltinESMExports();
  const progress = new Promise<void>((resolve) => setImmediate(() => { progressed = true; resolve(); }));
  const pending = bindDebugEvidenceFile(artifacts.sink, 'large.txt', ticket);
  expect(pending).toBeInstanceOf(Promise); expect(syncBytes).toBe(0);
  await pending; await progress;
  expect(progressedDuringRead).toBe(true); expect(chunks).toBeGreaterThan(1); expect(largest).toBeLessThanOrEqual(65536);
  expect(debugEvidenceBytesProven(artifacts.sink, ticket, bytes)).toBe(true);
  console.log(JSON.stringify({ store, binderBytes: bytes.length, synchronousReadBytes: syncBytes, chunks, largestChunk: largest, progressedDuringRead }));
  const id = artifacts.sink.register('log', 'large.txt', ticket); await artifacts.settle();
  expect(artifacts.records[0]).toMatchObject({ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  expect(artifacts.debugRedactionProven(id)).toBe(true);
  expect(puts).toHaveLength(store ? 1 : 0);
  if (store) {
    expect(Buffer.from(puts[0]!.bytes)).toEqual(bytes);
    expect(puts[0]!.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  }
});
it.each([true, false])('accepts legitimate artifact-root symlink ancestors, hosted=%s', async (hosted) => {
  const { root, secrecy } = setup();
  fs.mkdirSync(path.join(root, 'physical'));
  fs.symlinkSync(path.join(root, 'physical'), path.join(root, 'alias'), 'dir');
  const artifacts = createAttemptArtifacts({ artifactsRoot: path.join(root, 'alias'), segments: ['attempt'], attemptId: 'a', safePaths: hosted, secrecy: () => secrecy });
  const name = hosted ? 'safe.txt' : 'écran image.txt';
  fs.writeFileSync(path.join(artifacts.dir, name), 'safe');
  expect(containedArtifactFile(path.join(root, 'alias', 'attempt'), name)).toBe(true);
  const ticket = debugEvidenceRegistration(artifacts.sink, 'text');
  await bindDebugEvidenceFile(artifacts.sink, name, ticket);
  const id = artifacts.sink.register('log', name, ticket); await artifacts.settle();
  expect(artifacts.records[0]).toMatchObject({ size: 4, sha256: createHash('sha256').update('safe').digest('hex') });
  expect(artifacts.debugRedactionProven(id)).toBe(true);
  fs.symlinkSync(artifacts.dir, path.join(root, 'root-link'), 'dir');
  expect(containedArtifactFile(path.join(root, 'root-link'), name)).toBe(false);
});
it.each(['ENOENT', 'EACCES', 'EIO'] as const)('classifies export-open %s truthfully', async (code) => {
  const { artifacts, root, report } = setup();
  const ticket = debugEvidenceRegistration(artifacts.sink, 'text');
  bindDebugEvidenceBytes(artifacts.sink, ticket, Buffer.from('safe'));
  fs.writeFileSync(path.join(artifacts.dir, 'safe.txt'), 'safe');
  artifacts.sink.register('log', 'safe.txt', ticket); await artifacts.settle();
  if (code === 'ENOENT') fs.rmSync(path.join(artifacts.dir, 'safe.txt'));
  else expect(fs.existsSync(path.join(artifacts.dir, 'safe.txt'))).toBe(true);
  const open = fsp.open;
  vi.spyOn(fsp, 'open').mockImplementation(async (...args) => { if (code !== 'ENOENT' && String(args[0]).endsWith('/safe.txt')) throw Object.assign(new Error(code), { code }); return open(...args); });
  syncBuiltinESMExports();
  const bundle = await buildDebugBundle({ report: immutableReport(report, (x) => x), artifacts, resultsDir: root, trace: 'written', redact: (x) => x });
  expect(bundle.artifacts[0]!.evidence).toEqual(code === 'ENOENT' ? { status: 'missing', reason: 'not-retained' } : { status: 'withheld', reason: 'read-failed' });
});
it('rejects every C1 control at all repeated wire identity positions, preserving Unicode', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true }); addFormats.default(ajv);
  const read = (name: string) => JSON.parse(fs.readFileSync(new URL('../../schema/' + name, import.meta.url), 'utf8'));
  ajv.addSchema(read('report-v1.schema.json'));
  const validate = ajv.compile(read('session-debug-v1.schema.json'));
  for (const slot of ['id', 'observationId', 'observationRevision', 'conditionalRevision']) {
    for (const position of ['', 'before', 'after']) {
      for (let code = 128; code <= 159; code++) {
        const bundle = read('fixtures/session-debug-v1.valid.json');
        const artifact = bundle.artifacts.find((a: { checkpoint?: unknown }) => a.checkpoint !== undefined);
        const text = position === '' ? String.fromCharCode(code) + 'id' : position === 'before' ? 'i' + String.fromCharCode(code) + 'd' : 'id' + String.fromCharCode(code);
        if (slot === 'id' || slot === 'observationId') artifact.checkpoint[slot] = text;
        else artifact.observationRevision = text;
        if (slot === 'conditionalRevision') artifact.checkpoint.observationId = 'original-observation';
        expect(validate(bundle), slot + ':' + code + ':' + position).toBe(false);
        if (slot === 'conditionalRevision') expect(validate.errors?.some((error) => error.keyword === 'pattern' && error.schemaPath.includes('/allOf/3/'))).toBe(true);
      }
    }
  }
  for (const text of ['é😀', '捕获']) {
    const bundle = read('fixtures/session-debug-v1.valid.json');
    const artifact = bundle.artifacts.find((a: { checkpoint?: unknown }) => a.checkpoint !== undefined);
    artifact.checkpoint.id = text; artifact.checkpoint.observationId = text; artifact.observationRevision = text;
    expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
  }
});

it.each([true, false].flatMap((store) => ['file', 'root', 'ledger', 'taint', 'abort', 'symlink', 'hardlink'].map((change) => [store, change] as const)))('fences original binder/Store custody across async %s/%s', async (store, change) => {
  const { artifacts: base, root, secrecy } = setup();
  const puts: Uint8Array[] = [];
  const artifacts = createAttemptArtifacts({ artifactsRoot: root, segments: ['race'], attemptId: 'race', safePaths: false, secrecy: () => secrecy,
    ...(store ? { store: { async put(row) { puts.push(row.bytes); return { ref: 'must-not-leave' }; } } } : {}),
  });
  void base;
  const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  const absolute = path.join(artifacts.dir, 'original.txt');
  fs.writeFileSync(absolute, bytes);
  const ticket = debugEvidenceRegistration(artifacts.sink, change === 'taint' ? 'pixels' : 'text');
  const controller = new AbortController();
  const pending = bindDebugEvidenceFile(artifacts.sink, 'original.txt', ticket, controller.signal);
  // The original FD is already held here. No delayed path-open can authorize a replacement.
  if (change === 'file') { fs.renameSync(absolute, absolute + '.old'); fs.writeFileSync(absolute, bytes); }
  if (change === 'root') { fs.renameSync(artifacts.dir, artifacts.dir + '.old'); fs.mkdirSync(artifacts.dir); fs.writeFileSync(absolute, bytes); }
  if (change === 'symlink') { fs.renameSync(absolute, absolute + '.old'); fs.symlinkSync(absolute + '.old', absolute, 'file'); }
  if (change === 'hardlink') fs.linkSync(absolute, absolute + '.link');
  if (change === 'ledger') secrecy.ledger.register('late', 'future-literal');
  if (change === 'taint') secrecy.exposure.raise('filled');
  if (change === 'abort') controller.abort();
  await pending;
  const id = artifacts.sink.register(change === 'taint' ? 'screenshot' : 'log', 'original.txt', ticket); await artifacts.settle();
  expect(puts).toEqual([]);
  expect(artifacts.records[0]).not.toHaveProperty('ref');
  expect(artifacts.debugRedactionProven(id)).toBe(false);
  if (['file', 'root', 'abort', 'symlink', 'hardlink'].includes(change)) expect(artifacts.records[0]).not.toHaveProperty('path');
});

it.each(['none', 'mutation', 'ledger'])('guards genuine source failure-renderer bytes, NOT current public host-emitted capture: %s', async (change) => {
  const { root, artifacts, secrecy, report } = setup();
  const sentinel = 'changed-trace-bytes-R18';
  const session = {
    async observe() { return { kind: 'semantic', id: 'original-observation', revision: 'original-revision', viewport: { width: 1, height: 1 },
      tree: { ref: { id: 'screen', revision: 'original-revision' }, role: 'document', name: 'original failure screen' }, truncated: false }; },
    artifacts: { async screenshot() { throw new Error('fixture has no screenshot'); } },
  } as unknown as TargetSession;
  const controller = new AbortController();
  const failure = await captureFailureEvidence({
    session, error: new E2EError('test', 'ASSERTION_FAILED', 'original failure'), secrecy,
    config: { limits: { maxObservationBytes: 20000 } } as HostTraceOptions['config'], appOrigin: undefined,
    artifacts: artifacts.sink, interrupt: controller.signal,
    operation: (signal, timeoutMs) => ({ signal, timeoutMs, runId: 'r', attemptId: 'a', origin: 'test' }),
  });
  expect(failure?.screen).toBeDefined(); await artifacts.settle();
  const record = artifacts.records.find((row) => row.id === failure!.screen)!;
  expect(artifacts.debugRedactionProven(record.id)).toBe(true);
  expect(artifacts.debugMediaType(record.id)).toBe('text/plain');
  report.run.results[0]!.attempts[0]!.failure = failure!;
  const snapshot = immutableReport(report, (x) => x);
  if (change === 'mutation') fs.writeFileSync(path.join(artifacts.dir, 'screen-at-failure.txt'), sentinel);
  if (change === 'ledger') secrecy.ledger.register('late', 'original failure screen');
  const tracePath = path.join(root, 'trace.md');
  await writeHostTrace({ config: { projectRoot: root } as HostTraceOptions['config'], target: {} as HostTraceOptions['target'],
    runId: 'r', testId: 't', title: 'source helper only', agent: 'default', attempt: {} as HostTraceOptions['attempt'],
    resultsDir: root, segments: ['attempt'], tracePath, redact: (x) => x,
    artifacts,
  }, snapshot);
  const trace = fs.readFileSync(tracePath, 'utf8');
  expect(trace).not.toContain(sentinel);
  if (change === 'none') expect(trace).toContain('original failure screen');
  else expect(trace).not.toContain('original failure screen');
});

it('rejects all C1 producer identities at start/middle/end without restricting valid Unicode', () => {
  const { artifacts } = setup();
  for (const key of ['checkpointId', 'observationId', 'observationRevision'] as const) {
    for (let code = 128; code <= 159; code++) {
      for (const text of [String.fromCharCode(code) + 'id', 'i' + String.fromCharCode(code) + 'd', 'id' + String.fromCharCode(code)]) {
        const ticket = debugEvidenceRegistration(artifacts.sink, 'text');
        associateDebugCheckpoint(ticket, { checkpointId: 'cp', phase: 'before', observationId: 'obs', observationRevision: 'rev', [key]: text }, { stepId: 'step' });
        expect(debugEvidenceProven(artifacts.sink, ticket)).toBe(false);
      }
    }
  }
  for (const text of ['é😀', '捕获', 'x'.repeat(1024)]) {
    const ticket = debugEvidenceRegistration(artifacts.sink, 'text');
    associateDebugCheckpoint(ticket, { checkpointId: text, phase: 'before', observationId: text, observationRevision: text }, { stepId: 'step' });
    expect(debugEvidenceProven(artifacts.sink, ticket)).toBe(true);
  }
  for (const text of ['', 'é'.repeat(513)]) {
    const ticket = debugEvidenceRegistration(artifacts.sink, 'text');
    associateDebugCheckpoint(ticket, { checkpointId: text, phase: 'before', observationId: null, observationRevision: null }, { stepId: 'step' });
    expect(debugEvidenceProven(artifacts.sink, ticket)).toBe(false);
  }
});

it.each(['read', 'fstat'])('withholds actual export %s I/O failure without claiming absence', async (stage) => {
  const { artifacts, root, report } = setup();
  const ticket = debugEvidenceRegistration(artifacts.sink, 'text');
  bindDebugEvidenceBytes(artifacts.sink, ticket, Buffer.from('safe'));
  fs.writeFileSync(path.join(artifacts.dir, 'safe.txt'), 'safe');
  artifacts.sink.register('log', 'safe.txt', ticket); await artifacts.settle();
  const open = fsp.open;
  vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
    const file = await open(...args);
    if (stage === 'fstat') vi.spyOn(file, 'stat').mockRejectedValue(Object.assign(new Error('synthetic stat EIO'), { code: 'EIO' }));
    else vi.spyOn(file, 'createReadStream').mockImplementation(() => { throw Object.assign(new Error('synthetic read EIO'), { code: 'EIO' }); });
    return file;
  });
  syncBuiltinESMExports();
  const bundle = await buildDebugBundle({ report: immutableReport(report, (x) => x), artifacts, resultsDir: root, trace: 'written', redact: (x) => x });
  expect(bundle.artifacts[0]!.evidence).toEqual({ status: 'withheld', reason: 'read-failed' });
  expect(bundle.report.run.results[0]!.attempts[0]!.artifacts[0]).not.toHaveProperty('path');
});
it('does not follow retargeted ancestor aliases during asynchronous original binding', async () => {
  const { root, secrecy } = setup();
  for (const name of ['physical', 'other']) fs.mkdirSync(path.join(root, name, 'attempt'), { recursive: true });
  fs.symlinkSync(path.join(root, 'physical'), path.join(root, 'alias'), 'dir');
  const artifacts = createAttemptArtifacts({ artifactsRoot: path.join(root, 'alias'), segments: ['attempt'], attemptId: 'a', safePaths: true, secrecy: () => secrecy });
  expect(artifacts.dir).toBe(path.join(root, 'physical', 'attempt'));
  fs.writeFileSync(path.join(artifacts.dir, 'safe.txt'), 'original');
  fs.writeFileSync(path.join(root, 'other', 'attempt', 'safe.txt'), 'replaced');
  const ticket = debugEvidenceRegistration(artifacts.sink, 'text');
  const pending = bindDebugEvidenceFile(artifacts.sink, 'safe.txt', ticket);
  fs.unlinkSync(path.join(root, 'alias')); fs.symlinkSync(path.join(root, 'other'), path.join(root, 'alias'), 'dir');
  await pending;
  const id = artifacts.sink.register('log', 'safe.txt', ticket); await artifacts.settle();
  expect(artifacts.debugRedactionProven(id)).toBe(true);
  expect(artifacts.records[0]!.sha256).toBe(createHash('sha256').update('original').digest('hex'));
});

it('closes the original binder FD after cancellation and does not start work past its deadline', async () => {
  const { artifacts } = setup();
  fs.writeFileSync(path.join(artifacts.dir, 'cancel.txt'), Buffer.alloc(2 * 1024 * 1024, 7));
  const open = fs.openSync;
  let originalFD: number | undefined, opened = 0;
  vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => { const fd = open(...args); originalFD = fd; opened++; return fd; });
  syncBuiltinESMExports();
  const controller = new AbortController();
  const create = fs.createReadStream;
  let closed!: Promise<void>;
  vi.spyOn(fs, 'createReadStream').mockImplementation((...args) => {
    const stream = create(...args);
    closed = new Promise<void>((resolve) => stream.once('close', resolve));
    return stream;
  });
  syncBuiltinESMExports();
  const ticket = debugEvidenceRegistration(artifacts.sink, 'text');
  const pending = bindDebugEvidenceFile(artifacts.sink, 'cancel.txt', ticket, controller.signal);
  expect(opened).toBe(1); controller.abort(); await pending;
  // Bounded abandonment is not a physical-close SLA; wait for the sole stream owner.
  await closed;
  expect(debugEvidenceProven(artifacts.sink, ticket)).toBe(false);
  expect(() => fs.fstatSync(originalFD!)).toThrow(expect.objectContaining({ code: 'EBADF' }));
  const expired = debugEvidenceRegistration(artifacts.sink, 'text');
  await bindDebugEvidenceFile(artifacts.sink, 'cancel.txt', expired, undefined, Date.now() - 1);
  expect(opened).toBe(1); expect(debugEvidenceProven(artifacts.sink, expired)).toBe(false);
});
