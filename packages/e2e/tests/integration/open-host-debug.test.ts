/** Public hosted debug snapshots use built SDK runtime objects, never private consumer imports. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it, vi } from 'vitest';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { gate, hostHarness, sdkExpect, secrets } from '../helpers/open-host.ts';

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);
ajv.addSchema(JSON.parse(readFileSync(new URL('../../schema/report-v1.schema.json', import.meta.url), 'utf8')));
const validate = ajv.compile(JSON.parse(readFileSync(new URL('../../schema/session-debug-v1.schema.json', import.meta.url), 'utf8')));

describe('openHost: public debug bundle', { timeout: 60_000 }, () => {
  const { host, config, heldGate } = hostHarness();

  it.each(['a'.repeat(64), '018f0f5c-7b2a-7abc-8abc-0123456789ab'].flatMap((secret) => (['static', 'cleanup'] as const).map((resolution) => [secret, resolution] as const)))('masks declared target identity %s at the first publication (%s)', async (secret, resolution) => {
    const handle = secrets.get('identity');
    const fake = createFakeEngine({ secrets: [handle], onEndAttempt: async () => {
      if (resolution === 'cleanup') await fake.attempts[0]!.resolveSecret(handle);
    } });
    const opened = await host(fake.engine, { config: config(fake.engine, {
      targets: [{ ...config(fake.engine).targets![0]!, name: secret }],
      secrets: { identity: resolution === 'static' ? secret : () => secret },
    }) });
    const session = await opened.openSession({ name: 'identity test' });
    const writes: string[] = [];
    const original = fsPromises.writeFile;
    const spy = vi.spyOn(fsPromises, 'writeFile').mockImplementation(async (...args) => {
      if (String(args[0]).startsWith(session.tracePath + '.')) writes.push(String(args[1]));
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      expect(await session.close()).toEqual([]);
      const bundle = session.exportDebugBundle()!;
      expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
      expect(bundle.report.run.targets[0]!.id).toBe(resolution === 'static' ? '<secret:identity>' : '[text withheld: secret resolution unproven]');
      expect(bundle.report.run.results[0]!.targetId).toBe(bundle.report.run.targets[0]!.id);
      expect(JSON.stringify(bundle)).not.toContain(secret);
      expect(writes).toHaveLength(1);
      expect(writes[0]).not.toContain(secret);
      expect(readFileSync(session.tracePath, 'utf8')).toBe(writes[0]);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  });

  it('preserves the SDK runner literal, never a freeform name with the same value', async () => {
    let calls = 0;
    const fake = createFakeEngine();
    const opened = await host(fake.engine, { config: config(fake.engine, {
      secrets: { unused: () => { calls++; return 'unused-secret-A7h2'; } },
      targets: [{ ...config(fake.engine).targets![0]!, name: 'e2e' }],
    }) });
    const session = await opened.openSession({ name: 'e2e' });
    expect(await session.close()).toEqual([]);
    const bundle = session.exportDebugBundle()!;
    const literal: 'e2e' = bundle.report.run.runner.name;
    expect(literal).toBe('e2e');
    expect(bundle.report.run.targets[0]!.id).toBe('[text withheld: secret resolution unproven]');
    expect(bundle.report.run.results[0]!.titlePath).toEqual(['[text withheld: secret resolution unproven]']);
    expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
    expect(calls).toBe(0);
  });

  it.each(['literal', 'effective-env'] as const)('keeps real screenshot MIME facts without exempting matching user prose (%s)', async (definition) => {
    let calls = 0;
    const fake = createFakeEngine({ artifacts: true });
    const opened = await host(fake.engine, {
      env: definition === 'effective-env' ? { E2E_SECRET_MIME: 'image/png' } : {},
      config: config(fake.engine, { secrets: { mime: definition === 'literal' ? 'image/png' : () => { calls++; return 'unused-provider-value'; } } }),
    });
    const session = await opened.openSession({ name: 'image/png' });
    await session.fixtures.app.screenshot('image/png');
    expect(await session.close()).toEqual([]);
    const bundle = session.exportDebugBundle()!;
    expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
    const row = bundle.artifacts[0]!;
    expect(row.mediaType).toBe('image/png');
    expect(row.evidence.status).toBe('available');
    const attempt = bundle.report.run.results[0]!.attempts[0]!;
    expect(attempt.artifacts[0]!.mediaType).toBe(row.mediaType);
    expect(attempt.steps[0]!.label).toBe('<secret:mime>');
    expect(bundle.report.run.results[0]!.titlePath).toEqual(['<secret:mime>']);
    expect(calls).toBe(0);
  });


  it.each(([
    ['https://example.test/v1', 'example', true],
    ['https://safe.test/example', 'example', true],
    ['urn:example:model', 'example', true],
    ['file:///tmp/example', 'example', true],
    ['https://safe.test/v1', 'example', false],
    ['local', 'example', false],
    ['provider-default', 'provider-default', false],
    [undefined, 'example', false],
  ] as const).flatMap(([endpoint, token, omitted]) => (['static', 'cleanup'] as const).map((resolution) => [endpoint, token, omitted, resolution] as const)))('projects optional model endpoint %s with token %s (omitted=%s, resolution=%s) in the built SDK', async (endpoint, token, omitted, resolution) => {
    const handle = secrets.get('token');
    const fake = createFakeEngine({ secrets: [handle], onEndAttempt: async () => {
      if (resolution === 'cleanup') await fake.attempts[0]!.resolveSecret(handle);
    } });
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { token: resolution === 'static' ? token : () => token } }) });
    const session = await opened.openSession({ name: 'model URI' });
    await session.fixtures.app.open('/');
    if (endpoint !== undefined) session.steps()[0]!.model = {
      provider: token, model: token, endpoint, adapterVersion: '1', policyVersion: '1', calls: 1,
      tokenAccounting: 'provider', peakTokensPerCall: 1, inputTokens: 1, outputTokens: 1,
    };
    expect(await session.close()).toEqual([]);
    const bundle = session.exportDebugBundle()!;
    expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
    const step = bundle.report.run.results[0]!.attempts[0]!.steps[0]!;
    if (omitted || endpoint === undefined || resolution === 'cleanup' && endpoint !== 'local' && endpoint !== 'provider-default') expect(step).not.toHaveProperty('model');
    else expect(step.model).toMatchObject({ endpoint, provider: resolution === 'static' ? '<secret:token>' : '[text withheld: secret resolution unproven]', model: resolution === 'static' ? '<secret:token>' : '[text withheld: secret resolution unproven]' });
    if (omitted) {
      expect(JSON.stringify(bundle)).not.toContain(endpoint);
      expect(readFileSync(session.tracePath, 'utf8')).not.toContain(endpoint);
    }
  });

  it.each(['static', 'cleanup'] as const)('omits a schema URI masked by a %s secret before the first trace write', async (resolution) => {
    const handle = secrets.get('token');
    const fake = createFakeEngine({ secrets: [handle], onEndAttempt: async () => {
      if (resolution === 'cleanup') await fake.attempts[0]!.resolveSecret(handle);
    } });
    const opened = await host(fake.engine, { config: config(fake.engine, {
      targets: [{ ...config(fake.engine).targets![0]!, app: { url: 'https://example.test' } }],
      secrets: { token: resolution === 'static' ? 'example' : () => 'example' },
    }) });
    const session = await opened.openSession({ name: 'URI contract' });
    const writes: string[] = [];
    const original = fsPromises.writeFile;
    const spy = vi.spyOn(fsPromises, 'writeFile').mockImplementation(async (...args) => {
      if (String(args[0]).startsWith(session.tracePath + '.')) writes.push(String(args[1]));
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      expect(await session.close()).toEqual([]);
      const bundle = session.exportDebugBundle()!;
      expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
      expect(bundle.report.run.targets[0]).not.toHaveProperty('baseOrigin');
      expect(JSON.stringify(bundle)).not.toContain('https://example.test');
      expect(writes).toHaveLength(1);
      expect(writes[0]).not.toContain('https://example.test');
      expect(readFileSync(session.tracePath, 'utf8')).toBe(writes[0]);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  });

  it.each(['static', 'cleanup'] as const)('deduplicates schema-unique capability collisions from a %s secret in the built SDK', async (resolution) => {
    const handle = secrets.get('token');
    const fake = createFakeEngine({ secrets: [handle], onEndAttempt: async () => {
      if (resolution === 'cleanup') await fake.attempts[0]!.resolveSecret(handle);
    } });
    const engine = { ...fake.engine, capabilities: new Set([...fake.engine.capabilities, 'foobar', 'fooBar']) };
    const opened = await host(engine, { config: config(engine, { secrets: { token: resolution === 'static' ? 'foobar' : () => 'foobar' } }) });
    const session = await opened.openSession({ name: 'capability contract' });
    expect(await session.close()).toEqual([]);
    const bundle = session.exportDebugBundle()!;
    expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
    const capabilities = bundle.report.run.targets[0]!.capabilities;
    expect(capabilities.filter((item) => item === (resolution === 'static' ? '<secret:token>' : '[text withheld: secret resolution unproven]'))).toHaveLength(1);
    expect(capabilities).toContain('observation');
    expect(JSON.stringify(bundle)).not.toMatch(/foobar/i);
  });

  it('runs a separate consumer process importing only the built public SDK', () => {
    const output = execFileSync(process.execPath, [fileURLToPath(new URL('../helpers/host-debug-consumer.mjs', import.meta.url))], { encoding: 'utf8', timeout: 30_000 });
    const results = output.trim().split('\n').map((line) => JSON.parse(line) as { status: string });
    expect(results.map((result) => result.status)).toEqual(['passed', 'failed', 'timed-out']);
  });

  it('exports SDK identity, associated retained screenshot and explicit absent evidence; ignores arbitrary consumer files', async () => {
    const fake = createFakeEngine({ fixtures: true, artifacts: true, video: true });
    const opened = await host(fake.engine, { config: config(fake.engine, { video: 'on' }) });
    const session = await opened.openSession({ name: 'public export' });
    expect(session.exportDebugBundle()).toBeUndefined();
    await session.fixtures.app.screenshot('home');
    await session.fixtures.gadget.dropFile();
    writeFileSync(path.join(session.artifactsDir, 'consumer.xml'), '<raw-native-tree/>');
    expect(await session.close()).toEqual([]);
    const bundle = session.exportDebugBundle()!;
    expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
    const result = bundle.report.run.results[0]!;
    expect(bundle.report.run).toMatchObject({ id: session.runId, status: 'passed', exitCode: 0 });
    expect(result).toMatchObject({ targetId: session.target, status: 'passed', attempts: [{ id: session.attemptId, cleanup: 'complete' }] });
    const screenshot = bundle.artifacts.find((artifact) => artifact.kind === 'screenshot')!;
    expect(screenshot).toMatchObject({ stepIds: [session.steps()[0]!.id], observationRevision: null, evidence: { status: 'available' } });
    if (screenshot.evidence.status !== 'available') throw new Error('missing screenshot');
    expect(readFileSync(path.join(session.artifactsDir, screenshot.evidence.path))).toBeDefined();
    expect(bundle.artifacts.find((artifact) => artifact.kind === 'log')!.evidence).toEqual({ status: 'withheld', reason: 'non-sdk-evidence' });
    expect(bundle.artifacts.find((artifact) => artifact.kind === 'video')!.evidence).toEqual({ status: 'withheld', reason: 'incomplete-redaction' });
    expect(JSON.stringify(bundle)).not.toContain('consumer.xml');
    expect(JSON.stringify(bundle)).not.toContain('raw-native-tree');
    expect(bundle.evidence[0]).toEqual({ stepId: session.steps()[0]!.id, semantic: 'not-recorded', reasoning: 'not-recorded', turns: 'not-recorded', checkpoints: 'not-recorded' });
    expect(readFileSync(session.tracePath, 'utf8')).toContain('app.screenshot');
    const before = JSON.stringify(bundle);
    expect(() => { (bundle.report.run as { status: string }).status = 'failed'; }).toThrow(TypeError);
    expect(() => { (bundle.artifacts as unknown[]).push({}); }).toThrow(TypeError);
    session.steps()[0]!.events.push({ kind: 'engine', startedAt: new Date().toISOString(), durationMs: 0, status: 'passed', detail: 'late mutation' });
    expect(await session.close()).toEqual([]);
    expect(session.exportDebugBundle()).toBe(bundle);
    expect(JSON.stringify(session.exportDebugBundle())).toBe(before);
  });

  it('exports redacted events, reasoning and tool turns, with no raw external causes or retained pixel buffers', async () => {
    const plaintext = 'debug-secret-9Xq-61';
    const handle = secrets.get('debugToken');
    const fake = createFakeEngine({ secrets: [handle], onStartAttempt: async (context) => { await context.resolveSecret(handle); } });
    const opened = await host(fake.engine, { config: config(fake.engine, {
      secrets: { debugToken: () => plaintext }, cache: 'off', agents: { default: { executor: {
        name: 'synthetic-debug',
        async runStep(context) {
          context.budgets.recordModelCall({ reasoning: 'reason ' + plaintext });
          context.attachTurns([{ index: 1, calls: ['tap(' + plaintext + ')'], outcome: 'done ' + plaintext }]);
          return { status: 'passed' as const, summary: 'summary ' + plaintext };
        },
      } } },
    }) });
    const session = await opened.openSession({ name: 'redacted ' + plaintext });
    await session.fixtures.agent.act('act ' + plaintext);
    const step = session.steps()[0]!;
    Object.assign(step, { source: { file: 'host', line: 1, column: 1, pixelBuffer: Buffer.from('nested raw pixel bytes'), externalCause: { nativeXml: '<private-native-tree/>' } } });
    Object.assign(step, { viewport: { width: 10, height: 10, scale: 1, pixelBuffer: Buffer.from('viewport pixel bytes') } });
    Object.assign(step, { pixelBuffer: Buffer.from('raw pixel bytes'), externalCause: { nativeXml: '<private-native-tree/>' } });
    Object.assign(step.events[0]!, { rawProviderResponse: { bytes: Buffer.from('provider-private') } });

    sdkExpect.soft(plaintext, 'expected ' + plaintext).toBe('different');
    await session.close();
    const bundle = session.exportDebugBundle()!;
    expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
    expect(JSON.stringify(bundle)).not.toContain(plaintext);
    expect(JSON.stringify(bundle)).toContain('[text withheld: secret resolution unproven]');
    expect(JSON.stringify(bundle)).not.toContain('pixelBuffer');
    expect(JSON.stringify(bundle)).not.toContain('private-native-tree');
    expect(JSON.stringify(bundle)).not.toContain('rawProviderResponse');
    expect(bundle.report.run.status).toBe('failed');
    expect(bundle.evidence[0]).toMatchObject({ reasoning: 'recorded', turns: 'recorded' });
    expect(bundle.report.run.results[0]!.attempts[0]!.error).not.toHaveProperty('stack');
    expect(readFileSync(session.tracePath, 'utf8')).not.toContain(plaintext);
  });

  it('does not publish any trace before retiring cleanup drains pending secret resolution', async () => {
    const plaintext = 'retirement-secret-K9v2';
    const handle = secrets.get('retirementToken');
    const entered = gate();
    const release = heldGate();
    let resolving: Promise<string> | undefined;
    let tracePath = '';
    let traceAtDispose: string | undefined;
    const fake = createFakeEngine({
      video: true, secrets: [handle],
      onStartAttempt: (context) => {
        resolving = context.resolveSecret(handle);
        context.appLog({ source: 'console', level: 'info', text: plaintext });
      },
      onDispose: async () => {
        traceAtDispose = existsSync(tracePath) ? readFileSync(tracePath, 'utf8') : undefined;
        entered.resolve();
        await release.promise;
        await resolving;
      },
    });
    const engine = { ...fake.engine, artifacts: { ...fake.engine.artifacts!, stopVideo: async () => {
      await release.promise;
      await resolving;
      return [];
    } } };
    const opened = await host(engine, { config: config(engine, {
      video: 'on', cleanupTimeout: 100,
      secrets: { retirementToken: async () => { await release.promise; return plaintext; } },
    }) });
    const session = await opened.openSession({ name: 'retiring ' + plaintext });
    tracePath = session.tracePath;
    const closing = session.close();
    await entered.promise;
    const publishedBeforeDispose = existsSync(tracePath);
    expect(session.exportDebugBundle()).toBeUndefined();
    release.resolve();
    const failures = await closing;
    expect(failures).toEqual([expect.objectContaining({ code: 'CLEANUP_TIMEOUT' })]);
    expect(publishedBeforeDispose, traceAtDispose).toBe(false);
    const bundle = session.exportDebugBundle()!;
    expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
    expect(JSON.stringify(bundle)).not.toContain(plaintext);
    expect(readFileSync(tracePath, 'utf8')).not.toContain(plaintext);
    expect(fake.stats().disposes).toBe(1);
    expect(await session.close()).toBe(failures);
    expect(session.exportDebugBundle()).toBe(bundle);
  });

  it('fails closed at the first trace write and bundle freeze when retirement exhausts its deadline with a provider pending', async () => {
    const plaintext = 'pending-deadline-secret-H8q3';
    const handle = secrets.get('pendingDeadlineToken');
    const release = heldGate();
    let resolving: Promise<string> | undefined;
    let returned = false;
    const fake = createFakeEngine({
      artifacts: true, video: true, secrets: [handle],
      onStartAttempt: (context) => {
        resolving = context.resolveSecret(handle);
        context.appLog({ source: 'console', level: 'info', text: plaintext });
      },
      onDispose: async () => { await resolving; },
    });
    const engine = { ...fake.engine, artifacts: { ...fake.engine.artifacts!, stopVideo: async () => {
      await release.promise; await resolving; return [];
    } } };
    const opened = await host(engine, { config: config(engine, {
      video: 'on', cleanupTimeout: 30, cache: 'off',
      secrets: { pendingDeadlineToken: async () => { await release.promise; returned = true; return plaintext; } },
      agents: { default: { executor: { name: 'pending-prose', async runStep(context) {
        context.budgets.recordModelCall({ reasoning: plaintext });
        context.attachTurns([{ index: 1, calls: [plaintext], outcome: plaintext }]);
        return { status: 'passed' as const, summary: plaintext };
      } } } },
    }) });
    const session = await opened.openSession({ name: plaintext });
    await session.fixtures.agent.act(plaintext);
    await session.fixtures.app.screenshot(plaintext);
    const step = session.steps()[0]!;
    step.error = { category: 'test', code: 'ASSERTION_FAILED', message: plaintext, retryable: false, details: { observed: plaintext } };
    const writes: string[] = [];
    const original = fsPromises.writeFile;
    const spy = vi.spyOn(fsPromises, 'writeFile').mockImplementation(async (...args) => {
      if (String(args[0]).startsWith(session.tracePath + '.')) writes.push(String(args[1]));
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      const started = Date.now();
      await session.close();
      expect(Date.now() - started).toBeLessThan(1000);
      expect(returned).toBe(false);
      const bundle = session.exportDebugBundle()!;
      expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
      expect(writes).toHaveLength(1);
      expect(writes[0]).not.toContain(plaintext);
      const before = JSON.stringify(bundle);
      expect(before).not.toContain(plaintext);
      const attempt = bundle.report.run.results[0]!.attempts[0]!;
      expect(attempt.status).toBe('failed');
      expect(attempt.steps[0]!.error!.category).toBe('test');
      expect(attempt.appLog![0]!.source).toBe('console');
      expect(bundle.artifacts.every((a) => a.evidence.status !== 'available')).toBe(true);
      expect(attempt.artifacts.every((a) => a.redaction === 'incomplete' && a.path === undefined)).toBe(true);
      const assertFrozen = (value: unknown): void => {
        if (value !== null && typeof value === 'object') {
          expect(Object.isFrozen(value)).toBe(true);
          for (const child of Object.values(value)) assertFrozen(child);
        }
      };
      assertFrozen(bundle);
      release.resolve();
      await resolving;
      expect(session.exportDebugBundle()).toBe(bundle);
      expect(JSON.stringify(bundle)).toBe(before);
      expect(writes).toHaveLength(1);
      expect(readFileSync(session.tracePath, 'utf8')).toBe(writes[0]);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  });

  it.each(['act', 'assert'] as const)('withholds a silently clipped 2000-character %s verdict when its provider resolves during successful cleanup', async (api) => {
    const plaintext = 'PQ7rs9Uv4wx2';
    const handle = secrets.get('summaryCutToken');
    const fake = createFakeEngine({ secrets: [handle], onEndAttempt: async () => {
      await fake.attempts[0]!.resolveSecret(handle);
    } });
    const opened = await host(fake.engine, { config: config(fake.engine, {
      cache: 'off', secrets: { summaryCutToken: () => plaintext },
      agents: { default: { executor: { name: 'summary-cut', async runStep(context) {
        await context.observe();
        return { status: 'passed' as const, summary: 'x'.repeat(1997) + plaintext };
      } } } },
    }) });
    const session = await opened.openSession({ name: 'summary cut' });
    await session.fixtures.agent[api]('early summary');
    const writes: string[] = [];
    const original = fsPromises.writeFile;
    const spy = vi.spyOn(fsPromises, 'writeFile').mockImplementation(async (...args) => {
      if (String(args[0]).startsWith(session.tracePath + '.')) writes.push(String(args[1]));
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      await session.close();
      const bundle = session.exportDebugBundle()!;
      expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
      expect(bundle.report.run.results[0]!.attempts[0]!.steps[0]!.explanation).toBe('[text withheld: truncated before final redaction]');
      expect(JSON.stringify(bundle)).not.toContain('PQ7');
      expect(writes).toHaveLength(1);
      expect(writes[0]).not.toContain('PQ7');
      expect(readFileSync(session.tracePath, 'utf8')).toBe(writes[0]);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  });

  it('bounds actual pending settlement after successful cleanup without invoking unused providers', async () => {
    const plaintext = 'successful-pending-secret-T6q8';
    const release = heldGate();
    const handle = secrets.get('successfulPending');
    let resolving: Promise<string> | undefined;
    let unused = 0;
    const fake = createFakeEngine({ secrets: [handle], onStartAttempt: (context) => {
      resolving = context.resolveSecret(handle);
      context.appLog({ source: 'console', level: 'info', text: plaintext });
    } });
    const opened = await host(fake.engine, { config: config(fake.engine, {
      cleanupTimeout: 30,
      secrets: {
        successfulPending: async () => { await release.promise; return plaintext; },
        unusedProvider: () => { unused++; return 'never-used-secret-T6q8'; },
      },
    }) });
    const session = await opened.openSession({ name: plaintext });
    const started = Date.now();
    expect(await session.close()).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
    const bundle = session.exportDebugBundle()!;
    expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
    expect(bundle.report.run.status).toBe('passed');
    expect(bundle.report.run.results[0]!.attempts[0]!.appLog![0]!.text).toBe('[text withheld: secret resolution unproven]');
    expect(JSON.stringify(bundle)).not.toContain(plaintext);
    expect(readFileSync(session.tracePath, 'utf8')).not.toContain(plaintext);
    expect(unused).toBe(0);
    release.resolve();
    await resolving;
    expect(session.exportDebugBundle()).toBe(bundle);
    expect(bundle.report.run.results[0]!.attempts[0]!.appLog![0]!.text).toBe('[text withheld: secret resolution unproven]');
  });

  it('withholds pixel evidence when cleanup adds values to the ledger, even after successful resolution', async () => {
    const handle = secrets.get('artifactLateToken');
    const fake = createFakeEngine({ artifacts: true, secrets: [handle], onEndAttempt: async () => {
      await fake.attempts[0]!.resolveSecret(handle);
    } });
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { artifactLateToken: () => 'artifact-late-secret-Y8k2' }, cache: 'off',
    }) });
    const session = await opened.openSession({ name: 'capture proof' });
    await session.fixtures.app.screenshot();
    await session.close();
    const bundle = session.exportDebugBundle()!;
    expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
    expect(bundle.artifacts.map((a) => a.kind)).toEqual(['screenshot']);
    for (const artifact of bundle.artifacts) expect(artifact.evidence).toEqual({ status: 'withheld', reason: 'incomplete-redaction' });
    expect(bundle.report.run.results[0]!.attempts[0]!.artifacts.every((a) => a.redaction === 'incomplete' && a.path === undefined)).toBe(true);
    const trace = readFileSync(session.tracePath, 'utf8');
    expect(trace).not.toContain('artifact-late-secret-Y8k2');
    expect(trace).not.toContain('screenshots/fake.png');
  });

  it.each(['act', 'assert'] as const)('redacts known values before the actual %s producer clips its verdict', async (api) => {
    const plaintext = 'known-summary-secret-D4f8';
    const handle = secrets.get('knownSummary');
    const fake = createFakeEngine({ secrets: [handle], onStartAttempt: async (context) => { await context.resolveSecret(handle); } });
    const opened = await host(fake.engine, { config: config(fake.engine, {
      secrets: { knownSummary: () => plaintext }, cache: 'off',
      agents: { default: { executor: { name: 'known-summary', async runStep(context) {
        await context.observe();
        return { status: 'passed' as const, summary: 'x'.repeat(1997) + plaintext };
      } } } },
    }) });
    const session = await opened.openSession({ name: 'known summary' });
    const result = await session.fixtures.agent[api]('summary');
    if (api === 'act') expect(JSON.stringify(result)).not.toContain('kn');
    expect(session.steps()[0]!.explanation).toHaveLength(2000);
    expect(session.steps()[0]!.explanation).not.toContain('kn');
    await session.close();
    expect(validate(session.exportDebugBundle()!), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([1, 3, 8])('withholds a late secret cut to a %i-character prefix, including incoming cut markers', async (prefixLength) => {
    const plaintext = 'PQ7rs9Uv4wx2';
    const prefix = plaintext.slice(0, prefixLength);
    const handle = secrets.get('cutToken');
    const fake = createFakeEngine({ secrets: [handle], onStartAttempt: (context) => {
      context.appLog({ source: 'console', level: 'info', text: 'x'.repeat(299 - prefixLength) + plaintext });
      for (const cut of ['…', '...', '…[truncated]', '[observation truncated: engine limit]']) {
        context.appLog({ source: 'console', level: 'warning', text: 'early ' + prefix + cut });
      }
    }, onEndAttempt: async () => { await fake.attempts[0]!.resolveSecret(handle); } });
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { cutToken: () => plaintext } }) });
    const session = await opened.openSession({ name: 'late cut' });
    await session.fixtures.app.open('/');
    const step = session.steps()[0]!;
    step.events.push({ kind: 'model', startedAt: step.startedAt, durationMs: 1, status: 'passed', reasoning: 'reason ' + prefix + '…' });
    step.turns = [{ index: 1, calls: ['tap(' + prefix + '…[truncated])'], outcome: 'outcome ' + prefix + '...' }];
    step.error = { category: 'test', code: 'ASSERTION_FAILED', message: 'x'.repeat(8192 - prefixLength) + prefix, retryable: false };
    await session.close();
    const bundle = session.exportDebugBundle()!;
    expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
    const attempt = bundle.report.run.results[0]!.attempts[0]!;
    for (const line of attempt.appLog!) expect(line.text).toBe('[text withheld: truncated before final redaction]');
    expect(attempt.steps[0]!.events.at(-1)!.reasoning).toBe('[text withheld: truncated before final redaction]');
    expect(attempt.steps[0]!.turns![0]!.calls[0]).toBe('[text withheld: truncated before final redaction]');
    expect(attempt.steps[0]!.turns![0]!.outcome).toBe('[text withheld: truncated before final redaction]');
    expect(attempt.steps[0]!.error!.message).toBe('[text withheld: truncated before final redaction]');
    expect(readFileSync(session.tracePath, 'utf8')).not.toContain('early ' + prefix);
  });

  it('withholds cuts produced by actual step error and model-turn recording before provider resolution', async () => {
    const plaintext = 'runtime-cut-secret-R5e8';
    const handle = secrets.get('runtimeCutToken');
    const fake = createFakeEngine({ secrets: [handle],
      onNavigate: () => { throw new Error('x'.repeat(8189) + plaintext); },
      onEndAttempt: async () => { await fake.attempts[0]!.resolveSecret(handle); },
    });
    const opened = await host(fake.engine, { config: config(fake.engine, {
      secrets: { runtimeCutToken: () => plaintext }, cache: 'off',
      agents: { default: { executor: { name: 'synthetic-cut', async runStep(context) {
        context.budgets.recordModelCall({ reasoning: 'x'.repeat(596) + plaintext });
        context.attachTurns([{ index: 1, calls: ['tap(' + plaintext.slice(0, 1) + '…[truncated])'], outcome: plaintext.slice(0, 3) + '...' }]);
        return { status: 'passed' as const, summary: 'summary ' + plaintext };
      } } } },
    }) });
    const session = await opened.openSession({ name: 'runtime cuts' });
    await session.fixtures.agent.act('early label ' + plaintext);
    await expect(session.fixtures.app.open('/')).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(session.steps()[1]!.error!.message).toHaveLength(8192);
    await session.close();
    const bundle = session.exportDebugBundle()!;
    expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
    const attempt = bundle.report.run.results[0]!.attempts[0]!;
    expect(attempt.status).toBe('failed');
    expect(attempt.steps[0]!.label).toBe('[text withheld: secret resolution unproven]');
    expect(attempt.steps[0]!.explanation).toBe('[text withheld: secret resolution unproven]');
    expect(attempt.steps[0]!.events.find((event) => event.kind === 'model')!.reasoning).toBe('[text withheld: truncated before final redaction]');
    expect(attempt.steps[0]!.turns![0]).toMatchObject({ calls: ['[text withheld: truncated before final redaction]'], outcome: '[text withheld: truncated before final redaction]' });
    expect(attempt.steps[1]!.error!.message).toBe('[text withheld: truncated before final redaction]');
    expect(attempt.error!.message).toBe('[text withheld: truncated before final redaction]');
    expect(JSON.stringify(bundle)).not.toContain(plaintext);
    expect(readFileSync(session.tracePath, 'utf8')).not.toContain(plaintext);
  });

  it('bounds a 300-character app log after late full-value redaction expands it', async () => {
    const plaintext = 'Q7m2Z9';
    const handle = secrets.get('lateToken');
    const fake = createFakeEngine({ secrets: [handle], onStartAttempt: (context) => {
      context.appLog({ source: 'console', level: 'info', text: 'x'.repeat(294) + plaintext });
    }, onEndAttempt: async () => { await fake.attempts[0]!.resolveSecret(handle); } });
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { lateToken: () => plaintext } }) });
    const session = await opened.openSession({ name: 'late expansion' });
    await session.close();
    const bundle = session.exportDebugBundle()!;
    expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
    const text = bundle.report.run.results[0]!.attempts[0]!.appLog![0]!.text;
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text).toBe('[text withheld: secret resolution unproven]');
    expect(text).not.toContain(plaintext);
    expect(readFileSync(session.tracePath, 'utf8')).not.toContain(plaintext);
  });

  it('is available after a failed trace write, including the finalization error, and stays identical', async () => {
    const fake = createFakeEngine();
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: 'trace blocked' });
    mkdirSync(session.tracePath);
    const failures = await session.close();
    expect(failures.length).toBeGreaterThan(0);
    const bundle = session.exportDebugBundle()!;
    expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
    expect(bundle.trace).toBe('failed');
    expect(bundle.report.run.status).toBe('failed');
    expect(bundle.report.run.results[0]!.attempts[0]!.error).toMatchObject({ phase: 'cleanup' });
    expect(await session.close()).toBe(failures);
    expect(session.exportDebugBundle()).toBe(bundle);
  });

  it('stays unpublished through an asynchronous failed engine close and records cleanup once', async () => {
    const entered = gate();
    const release = heldGate();
    const fake = createFakeEngine({ onEndAttempt: async () => {
      entered.resolve(); await release.promise;
      throw new Error('end failed', { cause: { bytes: Buffer.from('private native XML') } });
    } });
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: 'cleanup race' });
    const closing = session.close();
    await entered.promise;
    expect(session.exportDebugBundle()).toBeUndefined();
    await expect(opened.openSession({ name: 'too early' })).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    release.resolve();
    const failures = await closing;
    expect(failures).not.toEqual([]);
    const bundle = session.exportDebugBundle()!;
    expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
    expect(bundle.report.run.results[0]!.attempts[0]!.cleanup).toBe('failed');
    expect(JSON.stringify(bundle)).not.toContain('private native XML');
    expect(fake.stats().attemptsEnded).toBe(1);
  });

  it('preserves wire constants when a valid secret coincides with an enum or schema version', async () => {
    const fake = createFakeEngine({ artifacts: true });
    const opened = await host(fake.engine, { config: config(fake.engine, { targets: [{ ...config(fake.engine).targets![0]!, app: { url: 'http://localhost:4599', environment: 'staging' } }], secrets: { wireVersion: 'report-1', wireStatus: 'passed', wireId: 'artifact', wireEnvironment: 'staging' } }) });
    const session = await opened.openSession({ name: 'report-1 passed' });
    await session.fixtures.app.screenshot();
    await session.close();
    const bundle = session.exportDebugBundle()!;
    expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
    expect(bundle.artifacts[0]!.id).toBe(session.attemptId + ':artifact:0');
    expect(bundle.artifacts[0]!.evidence.status).toBe('available');
    expect(bundle.report.run.targets[0]!.environment).toBe('staging');
    expect(bundle.report.schemaVersion).toBe('report-1');
    expect(bundle.report.run.status).toBe('passed');
    expect(bundle.report.run.results[0]!.titlePath[0]).toContain('<secret:wireVersion>');
    expect(bundle.report.run.results[0]!.titlePath[0]).toContain('<secret:wireStatus>');
  });

  it('checks retained evidence after worker disposal triggered by failed attempt cleanup', async () => {
    let artifactRoot = '';
    const entered = gate();
    const release = heldGate();
    const fake = createFakeEngine({
      artifacts: true,
      onStartAttempt: (context) => { artifactRoot = context.artifactsDir; },
      onEndAttempt: () => { throw new Error('close requires worker disposal'); },
      onDispose: async () => {
        entered.resolve(); await release.promise;
        rmSync(artifactRoot, { recursive: true, force: true });
      },
    });
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: 'retiring worker evidence' });
    await session.fixtures.app.screenshot();
    const closing = session.close();
    await entered.promise;
    expect(session.exportDebugBundle()).toBeUndefined();
    release.resolve();
    await closing;
    const bundle = session.exportDebugBundle()!;
    expect(bundle.artifacts[0]!.evidence).toEqual({ status: 'missing', reason: 'not-retained' });
    expect(bundle.report.run.results[0]!.attempts[0]!.artifacts[0]).not.toHaveProperty('path');
  });

  it('host close awaits a retiring session through publication and permits replacement ownership', async () => {
    const entered = gate();
    const release = heldGate();
    const fake = createFakeEngine({
      onEndAttempt: () => { throw new Error('retire worker'); },
      onDispose: async () => { entered.resolve(); await release.promise; },
    });
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: 'retiring publication' });
    const closing = session.close();
    await entered.promise;
    const hostClosing = opened.close();
    expect(session.exportDebugBundle()).toBeUndefined();
    release.resolve();
    await hostClosing;
    expect(session.exportDebugBundle()).toBeDefined();
    await closing;
    const replacement = await host(fake.engine);
    const next = await replacement.openSession({ name: 'replacement after publication' });
    await next.close();
    expect(next.exportDebugBundle()).toBeDefined();
  });

  it('exports a timed-out SDK outcome and keeps retention authoritative', async () => {
    const fake = createFakeEngine({ fixtures: true, video: true });
    const opened = await host(fake.engine, { config: config(fake.engine, { video: 'retain-on-failure' }) });
    const session = await opened.openSession({ name: 'debug timeout', timeout: 10 });
    await expect(session.fixtures.gadget.slow()).rejects.toMatchObject({ code: 'TEST_TIMEOUT' });
    await session.close();
    const bundle = session.exportDebugBundle()!;
    expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
    expect(bundle.report.run.results[0]!.attempts[0]!.status).toBe('timed-out');
    expect(existsSync(path.join(session.artifactsDir, 'video/fake.webm'))).toBe(true);
    expect(bundle.artifacts[0]!.evidence).toEqual({ status: 'withheld', reason: 'incomplete-redaction' });
    expect(readFileSync(session.tracePath, 'utf8')).toContain('timed out');
  });
});
