/** The debug allowlist refuses unsafe or changed registered evidence without searching the filesystem. */
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { buildDebugBundle, immutableReport } from '../../src/run/host-debug.ts';
import { bindDebugEvidenceBytes, createAttemptArtifacts, debugEvidenceRegistration } from '../../src/run/artifacts.ts';
import { sessionSecrecy, resolveSecretValue } from '../../src/run/secrecy.ts';
import { secrets } from '../../src/secrets.ts';
import type { SessionSecrecy } from '../../src/run/secrecy.ts';
import type { TargetSession } from '../../src/engine/surface.ts';
import type { Report1Document } from '../../src/report/build.ts';

/** Fixture authority mirrors the producer: known bytes bound before writing, never file-derived. */
function byteTicket(sink: Parameters<typeof debugEvidenceRegistration>[0], kind: 'pixels' | 'text' = 'pixels', bytes?: Buffer) {
  const registration = debugEvidenceRegistration(sink, kind);
  bindDebugEvidenceBytes(sink, registration, bytes ?? (kind === 'pixels' ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) : Buffer.from('safe')));
  return registration;
}

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A real sink and the report fixture isolate file-policy tests from engine behavior. */
async function setup(secrecy: SessionSecrecy = sessionSecrecy({} as TargetSession, new Map())) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'e2e-debug-'));
  dirs.push(root);
  const artifacts = createAttemptArtifacts({ artifactsRoot: root, segments: ['attempt'], attemptId: 'a', safePaths: true, ...(secrecy === undefined ? {} : { secrecy: () => secrecy }) });
  const report = JSON.parse(readFileSync(new URL('../../schema/fixtures/report-v1.valid.json', import.meta.url), 'utf8')) as Report1Document;
  const attempt = report.run.results[0]!.attempts[0]!;
  attempt.artifacts = artifacts.records;
  const exportBundle = async () => {
    await artifacts.settle();
    return buildDebugBundle({ report: immutableReport(report, (text) => text), artifacts, resultsDir: root, trace: 'written', redact: (text) => text });
  };
  return { root, artifacts, report, exportBundle };
}

it('pins runner.name in both the public runtime and shipped report schema', async () => {
  const { report } = await setup();
  delete report.run.carried;
  const snapshot = immutableReport(report, () => '<secret:all>', { prospectiveSecrets: true });
  const literal: 'e2e' = snapshot.run.runner.name;
  expect(literal).toBe('e2e');
  const validate = reportValidator();
  expect(validate(snapshot), JSON.stringify(validate.errors)).toBe(true);
  const invalid = JSON.parse(JSON.stringify(report)) as Report1Document;
  (invalid.run.runner as { name: string }).name = 'not-the-sdk';
  expect(reportValidator()(invalid)).toBe(false);
  expect(immutableReport(invalid, (text) => text, { prospectiveSecrets: true }).run.runner.name).toBe('[text withheld: secret resolution unproven]');
});

describe('host debug file allowlist', () => {
  it('keeps manifest step associations unique without deduplicating ordered steps', async () => {
    const { artifacts, report, exportBundle } = await setup();
    writeFileSync(path.join(artifacts.dir, 'evidence.txt'), 'safe');
    const artifact = artifacts.sink.register('log', 'evidence.txt', byteTicket(artifacts.sink, 'text'));
    const attempt = report.run.results[0]!.attempts[0]!;
    const step = attempt.steps[0]!;
    step.artifacts = [artifact];
    attempt.steps = [step, { ...step }];
    const bundle = await exportBundle();
    expect(bundle.artifacts[0]!.stepIds).toEqual([step.id]);
    expect(bundle.report.run.results[0]!.attempts[0]!.steps).toHaveLength(2);
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats.default(ajv);
    ajv.addSchema(JSON.parse(readFileSync(new URL('../../schema/report-v1.schema.json', import.meta.url), 'utf8')));
    const validate = ajv.compile(JSON.parse(readFileSync(new URL('../../schema/session-debug-v1.schema.json', import.meta.url), 'utf8')));
    expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each(['../private.txt', '/tmp/private.txt', 'folder/../../private.txt', 'folder\\private.txt', 'C:/private.txt', './private.txt', 'folder//private.txt'])('refuses the recorded path %s without exporting it', async (name) => {
    const { artifacts, exportBundle } = await setup();
    artifacts.sink.register('log', name, byteTicket(artifacts.sink, 'text'));
    const bundle = await exportBundle();
    expect(bundle.artifacts[0]!.evidence).toEqual({ status: 'withheld', reason: 'unsafe-path' });
    expect(bundle.report.run.results[0]!.attempts[0]!.artifacts[0]).not.toHaveProperty('path');
  });

  it.each(['file symlink', 'directory symlink', 'hard link'] as const)('refuses a %s even when it resolves to a readable file', async (kind) => {
    const { root, artifacts, exportBundle } = await setup();
    writeFileSync(path.join(root, 'external.xml'), '<raw-native-tree/>');
    let name = 'evidence.txt';
    if (kind === 'file symlink') symlinkSync(path.join(root, 'external.xml'), path.join(artifacts.dir, name));
    else if (kind === 'hard link') linkSync(path.join(root, 'external.xml'), path.join(artifacts.dir, name));
    else {
      symlinkSync(root, path.join(artifacts.dir, 'folder'));
      name = 'folder/external.xml';
    }
    artifacts.sink.register('log', name, byteTicket(artifacts.sink, 'text'));
    const bundle = await exportBundle();
    expect(bundle.artifacts[0]!.evidence).toEqual({ status: 'withheld', reason: 'unsafe-path' });
    expect(JSON.stringify(bundle)).not.toContain('raw-native-tree');
  });

  it('marks recorded-but-absent evidence missing', async () => {
    const { artifacts, exportBundle } = await setup();
    artifacts.sink.register('screenshot', 'absent.png', byteTicket(artifacts.sink));
    expect((await exportBundle()).artifacts[0]!.evidence).toEqual({ status: 'missing', reason: 'not-retained' });
  });

  it('withholds a file changed after registration, including same-size replacement', async () => {
    const { artifacts, exportBundle } = await setup();
    writeFileSync(path.join(artifacts.dir, 'screen.txt'), 'safe');
    artifacts.sink.register('log', 'screen.txt', byteTicket(artifacts.sink, 'text'));
    await artifacts.settle();
    writeFileSync(path.join(artifacts.dir, 'screen.txt'), 'evil');
    expect((await exportBundle()).artifacts[0]!.evidence).toEqual({ status: 'withheld', reason: 'changed-file' });
  });

  it('refuses an ancestor swapped to a symlink after registration', async () => {
    const { root, artifacts, exportBundle } = await setup();
    mkdirSync(path.join(artifacts.dir, 'nested'));
    writeFileSync(path.join(artifacts.dir, 'nested/screen.txt'), 'safe');
    artifacts.sink.register('log', 'nested/screen.txt', byteTicket(artifacts.sink, 'text'));
    await artifacts.settle();
    rmSync(path.join(artifacts.dir, 'nested'), { recursive: true });
    writeFileSync(path.join(root, 'screen.txt'), 'evil');
    symlinkSync(root, path.join(artifacts.dir, 'nested'));
    expect((await exportBundle()).artifacts[0]!.evidence).toEqual({ status: 'withheld', reason: 'unsafe-path' });
  });

  it.each(['screenshot', 'log'] as const)('withholds %s bytes captured while a provider was pending even if it resolves before registration', async (kind) => {
    let release!: () => void;
    const wait = new Promise<void>((done) => { release = done; });
    const config = new Map([['captureToken', { name: 'captureToken', purpose: 'generic-secret' as const, value: async () => { await wait; return 'capture-token-Z6u4'; } }]]);
    const secrecy = sessionSecrecy({} as TargetSession, config);
    const { artifacts, exportBundle } = await setup(secrecy);
    const pending = resolveSecretValue(secrets.get('captureToken'), config, secrecy.ledger);
    const png = new PNG({ width: 1, height: 1 }); png.data.set([67, 84, 90, 255]);
    const bytes = kind === 'log' ? Buffer.from('capture-token-Z6u4') : PNG.sync.write(png);
    const name = kind === 'log' ? 'evidence.txt' : 'evidence.png';
    const registration = byteTicket(artifacts.sink, kind === 'log' ? 'text' : 'pixels', bytes);
    writeFileSync(path.join(artifacts.dir, name), bytes);
    release();
    await pending;
    const id = artifacts.sink.register(kind, name, registration);
    await artifacts.settle();
    expect(artifacts.records[0]).toMatchObject({ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    expect(artifacts.debugMediaType(id)).toBe(kind === 'log' ? 'text/plain' : 'image/png');
    expect(artifacts.debugRedactionProven(id)).toBe(false);
    // The very same private fixture bytes are eligible with an empty, proven ledger.
    const control = await setup();
    const controlTicket = byteTicket(control.artifacts.sink, kind === 'log' ? 'text' : 'pixels', bytes);
    writeFileSync(path.join(control.artifacts.dir, name), bytes);
    control.artifacts.sink.register(kind, name, controlTicket);
    expect((await control.exportBundle()).artifacts[0]!.evidence.status).toBe('available');
    const bundle = await exportBundle();
    expect(bundle.artifacts[0]!.evidence).toEqual({ status: 'withheld', reason: 'incomplete-redaction' });
    expect(bundle.report.run.results[0]!.attempts[0]!.artifacts[0]).toMatchObject({ redaction: 'incomplete' });
    expect(bundle.report.run.results[0]!.attempts[0]!.artifacts[0]).not.toHaveProperty('path');
    expect(JSON.stringify(bundle)).not.toContain('capture-token-Z6u4');
  });

  it.each(['screenshot', 'log'] as const)('keeps %s evidence whose capture and final ledger agree', async (kind) => {
    const secrecy = sessionSecrecy({} as TargetSession, new Map());
    const { artifacts, exportBundle } = await setup(secrecy);
    const registration = byteTicket(artifacts.sink, kind === 'log' ? 'text' : 'pixels');
    const name = kind === 'screenshot' ? 'evidence.png' : 'evidence.txt';
    writeFileSync(path.join(artifacts.dir, name), kind === 'screenshot' ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) : 'safe');
    artifacts.sink.register(kind, name, registration);
    expect((await exportBundle()).artifacts[0]!.evidence.status).toBe('available');
  });

  it('does not infer a capture proof for opaque registered evidence', async () => {
    const secrecy = sessionSecrecy({} as TargetSession, new Map());
    const { artifacts, exportBundle } = await setup(secrecy);
    writeFileSync(path.join(artifacts.dir, 'evidence.txt'), 'safe');
    artifacts.sink.register('log', 'evidence.txt', { debugEvidence: true });
    expect(artifacts.records[0]!.redaction).toBe('complete');
    expect((await exportBundle()).artifacts[0]!.evidence).toEqual({ status: 'withheld', reason: 'non-sdk-evidence' });
  });

  it('uses registration and step attachment associations, never the step last observation as artifact provenance', async () => {
    const { artifacts, exportBundle } = await setup();
    writeFileSync(path.join(artifacts.dir, '0.txt'), 'safe');
    artifacts.sink.register('log', '0.txt', byteTicket(artifacts.sink, 'text'));
    const bundle = await exportBundle();
    expect(bundle.artifacts[0]!.observationRevision).toBeNull();
    expect(bundle.artifacts[0]!.stepIds).toEqual([]);
    expect(bundle.artifacts[0]!.evidence.status).toBe('available');
  });
});


/** Closed forward report declarations from outcomes 2904b0c8 and pixels 7eeb33bf; no sibling runtime or public-type dependency. */
function forwardReportValidator() {
  const schema = JSON.parse(readFileSync(new URL('../../schema/report-v1.schema.json', import.meta.url), 'utf8'));
  const status = { enum: ['passed', 'failed', 'timed-out', 'skipped', 'interrupted'] };
  schema.$defs.attempt.properties.hostedOutcome = {
    type: 'object', additionalProperties: false, required: ['status', 'unexpected', 'sdkStatus'],
    properties: {
      status, unexpected: { type: 'boolean' }, sdkStatus: status,
      external: {
        type: 'object', additionalProperties: false, required: ['actual'],
        properties: {
          actual: status, expected: status,
          retryIndex: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          testId: { type: 'string', minLength: 1, maxLength: 256 },
        },
      },
    },
  };
  schema.$defs.stepMetrics.properties.modelImageBytes = { type: 'integer', minimum: 0 };
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats.default(ajv);
  return ajv.compile(schema);
}

/** Validates shipped contracts with formats, without coercion, defaults, or removal of invalid fields. */
function reportValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats.default(ajv);
  return ajv.compile(JSON.parse(readFileSync(new URL('../../schema/report-v1.schema.json', import.meta.url), 'utf8')));
}

/** A fresh fixture prevents frozen projections from affecting subsequent cases. */
function reportFixture(): Report1Document {
  return JSON.parse(readFileSync(new URL('../../schema/fixtures/report-v1.valid.json', import.meta.url), 'utf8'));
}

describe('host report sanitization', () => {
  it('never lets unknown JSON keys spoof exact protocol paths', () => {
    const report = reportFixture();
    const key = 'run.results[0].attempts[0].status';
    Object.assign(report, { [key]: 'passed', 'run.id': report.run.id });
    const snapshot = immutableReport(report, (text) => text.replaceAll('passed', '<secret:status>').replaceAll(report.run.id, '<secret:identity>'));
    expect(snapshot).toHaveProperty([key], '<secret:status>');
    expect(snapshot).toHaveProperty(['run.id'], '<secret:identity>');
    expect(snapshot.run.results[0]!.attempts[0]!.status).toBe('passed');
    expect(snapshot.run.id).toBe(report.run.id);
  });

  it('retains declared SDK failure codes but not matching message or details prose', () => {
    const report = reportFixture();
    const attempt = report.run.results[0]!.attempts[0]!;
    attempt.error = { category: 'infrastructure', code: 'ENGINE_FAILURE', message: 'ENGINE_FAILURE', retryable: false, details: { observed: 'ENGINE_FAILURE' } };
    const snapshot = immutableReport(report, (text) => text.replaceAll('ENGINE_FAILURE', '<secret:code>'));
    expect(snapshot.run.results[0]!.attempts[0]!.error).toMatchObject({ code: 'ENGINE_FAILURE', message: '<secret:code>', details: { observed: '<secret:code>' } });
  });

  it('preserves actual SDK UUID/digest/join sites under secret collisions without exempting user copies', () => {
    const report = reportFixture();
    delete report.run.carried;
    const result = report.run.results[0]!;
    const attempt = result.attempts[0]!;
    result.testId = `host:${attempt.id}`;
    const step = attempt.steps[0]!;
    step.id = `${attempt.id}:${step.index}`;
    const artifact = attempt.artifacts[0]!;
    artifact.id = `${attempt.id}:artifact:0`;
    artifact.producer = { kind: 'step', stepId: step.id };
    step.artifacts = [artifact.id];
    attempt.failure = { screen: artifact.id, screenshot: artifact.id };
    for (const secret of [report.run.id, result.id, result.testId, attempt.id, step.id, artifact.id, artifact.sha256!]) {
      step.label = secret;
      step.error = { category: 'test', code: 'FAILED', message: secret, retryable: false, details: { testId: secret } };
      const snapshot = immutableReport(report, (text) => text.replaceAll(secret, '<secret:copy>'));
      expect(snapshot.run.id).toBe(report.run.id);
      expect(snapshot.run.results[0]!.id).toBe(result.id);
      expect(snapshot.run.results[0]!.testId).toBe(result.testId);
      const output = snapshot.run.results[0]!.attempts[0]!;
      expect(output.id).toBe(attempt.id);
      expect(output.steps[0]!.id).toBe(step.id);
      expect(output.artifacts[0]!.id).toBe(artifact.id);
      expect(output.artifacts[0]!.sha256).toBe(artifact.sha256);
      expect(output.artifacts[0]!.producer).toEqual(artifact.producer);
      expect(output.steps[0]!.artifacts).toEqual([artifact.id]);
      expect(output.failure).toEqual(attempt.failure);
      expect(output.steps[0]!.label).toBe('<secret:copy>');
      expect(output.steps[0]!.error!.details!.testId).toBe('<secret:copy>');
      const validate = reportValidator();
      expect(validate(snapshot), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it('does not treat a borrowed step UUID as SDK-owned identity', () => {
    const report = reportFixture();
    const step = report.run.results[0]!.attempts[0]!.steps[0]!;
    const borrowed = report.run.id + ':0';
    step.id = borrowed;
    expect(immutableReport(report, (text) => text.replaceAll(borrowed, '<secret:borrowed>')).run.results[0]!.attempts[0]!.steps[0]!.id).toBe('<secret:borrowed>');
  });

  it.each(['image/png', 'application/json'])('removes unsafe unproven MIME %s with its references instead of fabricating a media type', (secret) => {
    const report = reportFixture();
    const attempt = report.run.results[0]!.attempts[0]!;
    const artifact = attempt.artifacts[0]!;
    attempt.artifacts = [artifact]; artifact.mediaType = secret;
    attempt.steps[0]!.artifacts = [artifact.id];
    attempt.failure = { screen: artifact.id, screenshot: artifact.id };
    const snapshot = immutableReport(report, (text) => text.replaceAll(secret, '<secret:mime>'));
    const output = snapshot.run.results[0]!.attempts[0]!;
    expect(output.artifacts).toEqual([]);
    expect(output.steps[0]!.artifacts).toEqual([]);
    expect(output.failure).toEqual({});
    const validate = reportValidator();
    expect(validate(snapshot), JSON.stringify(validate.errors)).toBe(true);
  });

  it('redacts UUID/digest-shaped user IDs in carried test and group declarations', () => {
    const report = reportFixture();
    const secret = 'a'.repeat(64);
    const carried = report.run.carried!;
    carried.results[0]!.testId = secret;
    Object.assign(carried, { notes: { id: secret, testId: secret, mime: 'image/png' } });
    carried.serialGroups = [{
      id: secret, serialId: secret, declarationIndex: 0, file: 'test.ts', source: { file: 'test.ts', line: 1, column: 1 },
      titlePath: [secret], targetId: secret, platform: 'web', agent: 'default', repeat: 0, memberTestIds: [secret], status: 'skipped',
      skip: { cause: 'explicit', reason: secret }, attempts: [],
    }];
    const snapshot = immutableReport(report, (text) => text.replaceAll(secret, '<secret:identity>').replaceAll('image/png', '<secret:mime>'));
    const output = snapshot.run.carried!;
    expect(output.results[0]!.testId).toBe('<secret:identity>');
    expect(output.serialGroups[0]).toMatchObject({ id: '<secret:identity>', serialId: '<secret:identity>', targetId: '<secret:identity>', memberTestIds: ['<secret:identity>'] });
    expect(output).toHaveProperty('notes', { id: '<secret:identity>', testId: '<secret:identity>', mime: '<secret:mime>' });
  });

  it.each(['a'.repeat(64), '018f0f5c-7b2a-7abc-8abc-0123456789ab'])('redacts user identity %s without breaking target joins or exempting nested prose', (secret) => {
    const report = reportFixture();
    report.run.targets[0]!.id = secret;
    const result = report.run.results[0]!;
    result.targetId = secret;
    Object.assign(result.attempts[0]!, { hostedOutcome: { status: 'passed', unexpected: false, sdkStatus: 'passed', external: { actual: 'passed', testId: secret } } });
    result.attempts[0]!.error = { category: 'test', code: 'FAILED', message: secret, retryable: false, details: { testId: secret } };
    Object.assign(report.run, { notes: { id: secret, testId: secret, artifacts: [secret] } });
    const snapshot = immutableReport(report, (text) => text.replaceAll(secret, '<secret:identity>'));
    expect(snapshot.run.targets[0]!.id).toBe('<secret:identity>');
    expect(snapshot.run.results[0]!.targetId).toBe(snapshot.run.targets[0]!.id);
    expect(snapshot.run.results[0]!.attempts[0]).toHaveProperty('hostedOutcome.external.testId', '<secret:identity>');
    expect(snapshot.run.results[0]!.attempts[0]!.error!.details!.testId).toBe('<secret:identity>');
    expect(snapshot.run).toHaveProperty('notes', { id: '<secret:identity>', testId: '<secret:identity>', artifacts: ['<secret:identity>'] });
  });

  it.each([
    ['https://example.test/v1', 'example', true],
    ['https://safe.test/example', 'example', true],
    ['urn:example:model', 'example', true],
    ['file:///tmp/example', 'example', true],
    ['https://safe.test/v1', 'example', false],
    ['local', 'local', false],
    ['provider-default', 'provider-default', false],
  ] as const)('handles schema model endpoint %s without fabricating a replacement', (endpoint, token, omitted) => {
    const report = reportFixture();
    const step = report.run.results[0]!.attempts[0]!.steps[0]!;
    const model = { provider: token, model: token, endpoint, adapterVersion: '1', policyVersion: '1', calls: 1, tokenAccounting: 'provider' as const, peakTokensPerCall: 1, inputTokens: 1, outputTokens: 1 };
    step.model = model;
    const redact = (text: string) => text.replaceAll(token, '<secret:token>');
    const snapshot = immutableReport(report, redact);
    const validate = reportValidator();
    expect(validate(snapshot), JSON.stringify(validate.errors)).toBe(true);
    const output = snapshot.run.results[0]!.attempts[0]!.steps[0]!;
    if (omitted) expect(output).not.toHaveProperty('model');
    else expect(output.model).toEqual({ ...model, provider: '<secret:token>', model: '<secret:token>' });
    expect(step.model).toEqual(model);
  });

  it.each(['local', 'provider-default'] as const)('retains declared endpoint %s while unresolved prose is withheld', (endpoint) => {
    const report = reportFixture();
    delete report.run.carried;
    for (const result of report.run.results) for (const attempt of result.attempts) attempt.artifacts = [];
    const step = report.run.results[0]!.attempts[0]!.steps[0]!;
    step.model = { provider: 'custom', model: 'custom', endpoint, adapterVersion: '1', policyVersion: '1', calls: 1, tokenAccounting: 'provider', peakTokensPerCall: 1, inputTokens: 1, outputTokens: 1 };
    const snapshot = immutableReport(report, (text) => text, { unresolvedSecrets: true });
    const validate = reportValidator();
    expect(validate(snapshot), JSON.stringify(validate.errors)).toBe(true);
    expect(snapshot.run.results[0]!.attempts[0]!.steps[0]!.model).toMatchObject({ endpoint, provider: '[text withheld: secret resolution unproven]' });
  });

  it('keeps absent optional URI/model fields absent and leaves the unmasked fixture unchanged', () => {
    const report = reportFixture();
    expect(immutableReport(report, (text) => text)).toEqual(report);
    delete report.run.targets[0]!.baseOrigin;
    const snapshot = immutableReport(report, (text) => text.replaceAll('example', '<secret:token>'));
    expect(snapshot.run.targets[0]).not.toHaveProperty('baseOrigin');
    expect(snapshot.run.results[0]!.attempts[0]!.steps[0]).not.toHaveProperty('model');
    const validate = reportValidator();
    expect(validate(snapshot), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([false, true])('deduplicates only schema-unique arrays after masking with unresolved=%s', (unresolvedSecrets) => {
    const report = reportFixture();
    delete report.run.carried;
    const result = report.run.results[0]!;
    const step = result.attempts[0]!.steps[0]!;
    result.tags = ['foobar', 'fooBar'];
    result.testId = 'foobar';
    report.run.results[1]!.testId = 'fooBar';
    report.run.targets[0]!.capabilities = ['observation', 'foobar', 'fooBar'];
    report.run.targets[0]!.artifactCapabilities = ['screenshot', 'video'];
    report.run.serialGroups = [{
      id: result.id, serialId: 'serial', declarationIndex: 0, file: result.file, source: result.source,
      titlePath: ['serial'], targetId: result.targetId, platform: result.platform, agent: 'default', repeat: 0,
      memberTestIds: ['foobar', 'fooBar'], status: 'skipped', skip: { cause: 'explicit', reason: 'skip' }, attempts: [],
    }];
    step.events = [step.events[0]!, { ...step.events[0]! }];
    step.turns = [{ index: 1, calls: ['foobar', 'fooBar'], outcome: 'foobar' }, { index: 2, calls: ['foobar'], outcome: 'fooBar' }];
    if (unresolvedSecrets) {
      report.run.serialGroups = [];
      for (const candidate of report.run.results) for (const attempt of candidate.attempts) attempt.artifacts = [];
    }
    const snapshot = immutableReport(report, (text) => text.replace(/foobar/gi, '<secret:token>'), { unresolvedSecrets });
    const validate = reportValidator();
    expect(validate(snapshot), JSON.stringify(validate.errors)).toBe(true);
    expect(snapshot.run.results[0]!.tags).toHaveLength(1);
    if (!unresolvedSecrets) expect(snapshot.run.serialGroups[0]!.memberTestIds).toEqual([snapshot.run.results[0]!.testId]);
    expect(snapshot.run.targets[0]!.capabilities).toHaveLength(2);
    expect(snapshot.run.targets[0]!.artifactCapabilities).toEqual(['screenshot', 'video']);
    expect(snapshot.run.results[0]!.attempts[0]!.steps[0]!.events).toHaveLength(2);
    expect(snapshot.run.results[0]!.attempts[0]!.steps[0]!.turns).toHaveLength(2);
    expect(snapshot.run.results[0]!.attempts[0]!.steps[0]!.turns![0]!.calls).toHaveLength(2);
  });

  it('covers carried schema-unique tags and serial-group member IDs without changing generated identities', () => {
    const report = reportFixture();
    const carried = report.run.carried!;
    carried.results[0]!.tags = ['foobar', 'fooBar'];
    carried.serialGroups = [{
      id: report.run.results[0]!.id, serialId: 'serial', declarationIndex: 0, file: 'test.ts', source: { file: 'test.ts', line: 1, column: 1 },
      titlePath: ['serial'], targetId: 'web', platform: 'web', agent: 'default', repeat: 0, memberTestIds: ['foobar', 'fooBar'], status: 'skipped',
      skip: { cause: 'explicit', reason: 'skip' }, attempts: [],
    }];
    const snapshot = immutableReport(report, (text) => text.replace(/foobar/gi, '<secret:token>'));
    const validate = reportValidator();
    expect(validate(snapshot), JSON.stringify(validate.errors)).toBe(true);
    expect(snapshot.run.carried!.results[0]!.tags).toEqual(['<secret:token>']);
    expect(snapshot.run.carried!.serialGroups[0]!.memberTestIds).toEqual(['<secret:token>']);
    expect(snapshot.run.carried!.results[0]!.id).toBe(carried.results[0]!.id);
  });

  it.each([false, true])('omits a masked optional schema URI with providerSecrets=%s', (providerSecrets) => {
    const report = reportFixture();
    const validate = reportValidator();
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    const snapshot = immutableReport(report, (text) => text.replace(/example/gi, '<secret:token>'), { providerSecrets });
    expect(validate(snapshot), JSON.stringify(validate.errors)).toBe(true);
    expect(snapshot.run.targets[0]).not.toHaveProperty('baseOrigin');
    expect(JSON.stringify(snapshot)).not.toContain('https://example.test');
    expect(report.run.targets[0]!.baseOrigin).toBe('https://example.test');
  });

  it.each([false, true])('deduplicates schema-unique capability collisions after known redaction with providerSecrets=%s', (providerSecrets) => {
    const report = reportFixture();
    report.run.targets[0]!.capabilities = ['observation', 'foobar', 'fooBar'];
    const validate = reportValidator();
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    const snapshot = immutableReport(report, (text) => text.replace(/foobar/gi, '<secret:token>'), { providerSecrets });
    expect(validate(snapshot), JSON.stringify(validate.errors)).toBe(true);
    expect(snapshot.run.targets[0]!.capabilities).toEqual(['observation', '<secret:token>']);
    expect(report.run.targets[0]!.capabilities).toEqual(['observation', 'foobar', 'fooBar']);
  });

  it.each(['passed', 'failed', 'timed-out', 'skipped', 'interrupted'])('preserves the closed hosted outcome token %s without exempting freeform metadata', (token) => {
    const report = JSON.parse(readFileSync(new URL('../../schema/fixtures/report-v1.valid.json', import.meta.url), 'utf8')) as Report1Document;
    const result = report.run.results[0]!;
    const attempt = result.attempts[0]!;
    delete report.run.carried;
    const hostedOutcome = { status: token, unexpected: false, sdkStatus: token, external: { actual: token, expected: token, retryIndex: 2, testId: token.repeat(43).slice(0, 256) } };
    Object.assign(attempt, { hostedOutcome });
    result.titlePath = [token];
    const step = attempt.steps[0]!;
    step.label = token;
    step.explanation = token;
    step.source.file = token;
    step.events = [{ kind: 'model', status: 'passed', startedAt: step.startedAt, durationMs: 1, name: token, detail: token, reasoning: token }];
    attempt.appLog = [{ source: 'console', level: 'info', at: step.startedAt, text: token }];
    const redact = (text: string) => text.replaceAll(token, '<secret:outcome>');
    const snapshot = immutableReport(report, redact);
    const serialized = JSON.stringify(snapshot);
    const validate = forwardReportValidator();
    expect(validate(JSON.parse(serialized)), JSON.stringify(validate.errors)).toBe(true);
    const output = snapshot.run.results[0]!.attempts[0]!;
    const safeTestId = redact(hostedOutcome.external.testId);
    expect(output).toHaveProperty('hostedOutcome', {
      ...hostedOutcome, external: { ...hostedOutcome.external, testId: safeTestId.length > 256 ? safeTestId.slice(0, 255) + '…' : safeTestId },
    });
    expect(snapshot.run.results[0]!.titlePath).toEqual(['<secret:outcome>']);
    expect(output.steps[0]).toMatchObject({ label: '<secret:outcome>', explanation: '<secret:outcome>', source: { file: '<secret:outcome>' }, events: [{ name: '<secret:outcome>', detail: '<secret:outcome>', reasoning: '<secret:outcome>' }] });
    expect(output.appLog![0]!.text).toBe('<secret:outcome>');
    expect(Object.isFrozen(output)).toBe(true);
    expect(attempt).toHaveProperty('hostedOutcome.external.testId', hostedOutcome.external.testId);
  });

  it('does not exempt undeclared hosted outcome tokens or similarly named freeform fields', () => {
    const report = JSON.parse(readFileSync(new URL('../../schema/fixtures/report-v1.valid.json', import.meta.url), 'utf8')) as Report1Document;
    Object.assign(report.run.results[0]!.attempts[0]!, { hostedOutcome: { status: 'custom-status', sdkStatus: 'custom-status', external: { actual: 'custom-status', expected: 'custom-status', testId: 'passed' } } });
    const snapshot = immutableReport(report, (text) => text.replace(/custom-status|passed/g, '<secret:outcome>'));
    expect(snapshot.run.results[0]!.attempts[0]).toHaveProperty('hostedOutcome', { status: '<secret:outcome>', sdkStatus: '<secret:outcome>', external: { actual: '<secret:outcome>', expected: '<secret:outcome>', testId: '<secret:outcome>' } });
  });

  it.each([0, 512, 1536, Number.MAX_SAFE_INTEGER])('retains accepted model image total %s independently of peak pixel bytes', (modelImageBytes) => {
    const report = JSON.parse(readFileSync(new URL('../../schema/fixtures/report-v1.valid.json', import.meta.url), 'utf8')) as Report1Document;
    const metrics = { modelCalls: 3, actionSteps: 2, observationBytes: 256, contextBytes: 128, ledgerBytes: 64, pixelBytes: 512 };
    report.run.results[0]!.attempts[0]!.steps[0]!.metrics = Object.assign({ ...metrics }, { modelImageBytes, privatePixelBuffer: 'never-export' });
    const snapshot = immutableReport(report, (text) => text);
    expect(snapshot.run.results[0]!.attempts[0]!.steps[0]!.metrics).toEqual({ ...metrics, modelImageBytes });
    const validate = forwardReportValidator();
    expect(validate(JSON.parse(JSON.stringify(snapshot))), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([undefined, null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '512', {}, [512]])('omits an absent or invalid accepted model image total %s', (modelImageBytes) => {
    const report = JSON.parse(readFileSync(new URL('../../schema/fixtures/report-v1.valid.json', import.meta.url), 'utf8')) as Report1Document;
    const step = report.run.results[0]!.attempts[0]!.steps[0]!;
    const metrics = { ...step.metrics! };
    Object.assign(step.metrics!, { modelImageBytes });
    const snapshot = immutableReport(report, (text) => text);
    expect(snapshot.run.results[0]!.attempts[0]!.steps[0]!.metrics).toEqual(metrics);
  });

  it('does not invent metrics when the step has none', () => {
    const report = JSON.parse(readFileSync(new URL('../../schema/fixtures/report-v1.valid.json', import.meta.url), 'utf8')) as Report1Document;
    delete report.run.results[0]!.attempts[0]!.steps[0]!.metrics;
    expect(immutableReport(report, (text) => text).run.results[0]!.attempts[0]!.steps[0]).not.toHaveProperty('metrics');
  });
  it('preserves tokens by declared schema location, while redacting the same text in prose', () => {
    const report = JSON.parse(readFileSync(new URL('../../schema/fixtures/report-v1.valid.json', import.meta.url), 'utf8')) as Report1Document;
    const attempt = report.run.results[0]!.attempts[0]!;
    report.run.targets[0]!.environment = 'staging';
    report.run.targets[0]!.artifactCapabilities = ['screenshot'];
    attempt.appLog = [{ at: report.run.startedAt, source: 'console', level: 'warning', text: 'staging screenshot console warning' }];
    const snapshot = immutableReport(report, (text) => text.replace(/staging|screenshot|console|warning/g, '<secret:wire>'));
    expect(snapshot.run.targets[0]!.environment).toBe('staging');
    expect(snapshot.run.targets[0]!.artifactCapabilities).toEqual(['screenshot']);
    expect(snapshot.run.results[0]!.attempts[0]!.appLog![0]).toMatchObject({ source: 'console', level: 'warning', text: '<secret:wire> <secret:wire> <secret:wire> <secret:wire>' });
  });

  it('keeps timestamps and derived digests schema-shaped when a secret collides with a fact', () => {
    const report = JSON.parse(readFileSync(new URL('../../schema/fixtures/report-v1.valid.json', import.meta.url), 'utf8')) as Report1Document;
    const snapshot = immutableReport(report, (text) => text.replace(/[a-z0-9]/g, '<secret:fact>'));
    expect(snapshot.run.startedAt).toBe(report.run.startedAt);
    expect(snapshot.run.finishedAt).toBe(report.run.finishedAt);
    expect(snapshot.run.results[0]!.attempts[0]!.steps[0]!.startedAt).toBe(report.run.results[0]!.attempts[0]!.steps[0]!.startedAt);
    expect(snapshot.run.project.configDigest).toBe(report.run.project.configDigest);
  });

  it('enforces each recorded prose bound after final redaction, not before masking', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats.default(ajv);
    const validate = ajv.compile(JSON.parse(readFileSync(new URL('../../schema/report-v1.schema.json', import.meta.url), 'utf8')));
    const report = JSON.parse(readFileSync(new URL('../../schema/fixtures/report-v1.valid.json', import.meta.url), 'utf8')) as Report1Document;
    const attempt = report.run.results[0]!.attempts[0]!;
    const step = attempt.steps[0]!;
    const plaintext = 'Q7m2Z9';
    const atBound = (max: number) => 'x'.repeat(max - plaintext.length) + plaintext;
    step.label = atBound(8192);
    step.explanation = atBound(8192);
    step.observationRevision = atBound(256);
    step.events = [{ kind: 'model', status: 'passed', startedAt: step.startedAt, durationMs: 1, name: atBound(256), code: atBound(128), detail: atBound(300), reasoning: atBound(600) }];
    step.screen = { nodes: 1, changes: [atBound(200)] };
    step.turns = [{ index: 1, calls: [atBound(512)], outcome: atBound(2048) }];
    step.error = { category: 'test', code: atBound(128), message: atBound(8192), retryable: false, details: { observed: atBound(2048) } };
    attempt.error = step.error;
    attempt.secondaryErrors = [step.error];
    attempt.appLog = [{ source: 'console', level: 'info', at: step.startedAt, text: atBound(300) }];
    const snapshot = immutableReport(report, (text) => text.replaceAll(plaintext, '<secret:lateToken>'));
    expect(validate(snapshot), JSON.stringify(validate.errors)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain(plaintext);
    const output = snapshot.run.results[0]!.attempts[0]!.steps[0]!;
    expect(output.label).toHaveLength(8192);
    expect(output.events[0]!.detail).toHaveLength(300);
    expect(output.events[0]!.reasoning).toHaveLength(600);
    expect(output.screen!.changes[0]).toHaveLength(200);
    expect(output.turns![0]!.calls[0]).toHaveLength(512);
    expect(output.turns![0]!.outcome).toHaveLength(2048);
    expect(output.error!.message).toHaveLength(8192);
    expect(output.error!.details!.observed).toHaveLength(2048);
    expect(report.run.results[0]!.attempts[0]!.steps[0]!.label).toContain(plaintext);
    expect(Object.isFrozen(output.turns![0])).toBe(true);
  });

  it.each([8192, 8191, 8190, 8189])('withholds unmarked UTF-8 error cuts at %i bytes with provider secrets', (bytes) => {
    const report = JSON.parse(readFileSync(new URL('../../schema/fixtures/report-v1.valid.json', import.meta.url), 'utf8')) as Report1Document;
    const attempt = report.run.results[0]!.attempts[0]!;
    attempt.error = { category: 'test', code: 'ASSERTION_FAILED', message: 'é'.repeat(Math.floor((bytes - 1) / 2)) + (bytes % 2 === 0 ? 'x' : '') + 'P', retryable: false };
    expect(Buffer.byteLength(attempt.error.message, 'utf8')).toBe(bytes);
    const snapshot = immutableReport(report, (text) => text, { providerSecrets: true });
    expect(snapshot.run.results[0]!.attempts[0]!.error!.message).toBe('[text withheld: truncated before final redaction]');
  });

  it('withholds unknown prose without changing enum tokens, generated facts, or wire validity', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats.default(ajv);
    const validate = ajv.compile(JSON.parse(readFileSync(new URL('../../schema/report-v1.schema.json', import.meta.url), 'utf8')));
    const report = JSON.parse(readFileSync(new URL('../../schema/fixtures/report-v1.valid.json', import.meta.url), 'utf8')) as Report1Document;
    const attempt = report.run.results[0]!.attempts[0]!;
    attempt.artifacts = [];
    // A hosted attempt has no carried rerun state.
    delete report.run.carried;
    report.run.targets[0]!.baseOrigin = 'https://unknown-secret.example';
    report.run.targets[0]!.capabilities = ['observation', 'custom-secret-one', 'custom-secret-two'];
    report.run.vcs = { commit: 'a'.repeat(40), branch: 'unknown-secret-branch' };
    const step = attempt.steps[0]!;
    step.model = { provider: 'unknown-provider', model: 'unknown-model', endpoint: 'https://unknown-secret.example', adapterVersion: '1', policyVersion: '1', calls: 1, tokenAccounting: 'provider', peakTokensPerCall: 1, inputTokens: 1, outputTokens: 1 };
    step.explanation = 'unknown-secret';
    const snapshot = immutableReport(report, (text) => text, { providerSecrets: true, unresolvedSecrets: true });
    expect(validate(snapshot), JSON.stringify(validate.errors)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('unknown-secret');
    expect(snapshot.run.targets[0]!.capabilities).toEqual(['observation', '[text withheld: secret resolution unproven]']);
    expect(snapshot.run.targets[0]).not.toHaveProperty('baseOrigin');
    expect(snapshot.run.results[0]!.attempts[0]!.steps[0]).not.toHaveProperty('model');
    expect(snapshot.run.vcs!.commit).toBe('a'.repeat(40));
    expect(snapshot.run.status).toBe(report.run.status);
    expect(snapshot.run.startedAt).toBe(report.run.startedAt);
  });

  it('keeps ordinary cut prose when there are no provider-valued secrets', () => {
    const report = JSON.parse(readFileSync(new URL('../../schema/fixtures/report-v1.valid.json', import.meta.url), 'utf8')) as Report1Document;
    report.run.results[0]!.attempts[0]!.steps[0]!.label = 'label…';
    expect(immutableReport(report, (text) => text).run.results[0]!.attempts[0]!.steps[0]!.label).toBe('label…');
  });

  it('drops unknown nested recorder/error/source/scope fields, even cyclic external causes', () => {
    const report = JSON.parse(readFileSync(new URL('../../schema/fixtures/report-v1.valid.json', import.meta.url), 'utf8')) as Report1Document;
    const attempt = report.run.results[0]!.attempts[0]!;
    const step = attempt.steps[0]!;
    const privateData: Record<string, unknown> = { pixelBuffer: Buffer.from('private-pixels'), nativeXml: '<private-native-tree/>' };
    privateData['externalCause'] = privateData;
    Object.assign(step.source, privateData);
    Object.assign(step, { viewport: { width: 10, height: 10, scale: 1, ...privateData } });
    const error = attempt.error!;
    Object.assign(error, { details: { observed: 'safe', ...privateData } });
    Object.assign(error, { source: { file: 'host', line: 1, column: 1, ...privateData }, scope: { file: 'host', targetId: 'web', titlePath: ['scope'], ...privateData } });
    step.error = error;

    const snapshot = immutableReport(report, (text) => text);
    expect(JSON.stringify(snapshot)).not.toContain('pixelBuffer');
    expect(JSON.stringify(snapshot)).not.toContain('private-native-tree');
    expect(JSON.stringify(snapshot)).not.toContain('externalCause');
  });
});
