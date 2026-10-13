/** Genuine SDK producers through the ordinary runner, serial, MCP and hosted owning seams.
 * Public openHost does not enable --debug; the hosted transcript case uses its
 * private worker's existing debug option, not a new public capability.
 */
import { createHash } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { E2EConfig, StoredArtifact } from '../../src/types.ts';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import { createProject, runExisting } from '../helpers/run-project.ts';

const privateRoot = new URL('../../dist/', import.meta.url).href;
const { resolveConfig } = await import(privateRoot + 'config/resolve.js') as typeof import('../../src/config/resolve.ts');
const { openStandaloneHost, openStandaloneAttempt } = await import(privateRoot + 'run/standalone.js') as typeof import('../../src/run/standalone.ts');
const { DebugTrace } = await import(privateRoot + 'internal/debug.js') as typeof import('../../src/internal/debug.ts');

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PIXELS = { data: PNG, width: 8, height: 8, scale: 1, mediaType: 'image/png' as const, maskedRegionCount: 0 };
const SUITE = "import { test } from 'e2e'; test('producer', async ({ agent }) => { await agent.act('producer'); });";
const SERIAL = "import { test } from 'e2e'; test.describe('serial', { serial: true }, () => { test('one', async ({ agent }) => { await agent.act('one'); }); test('two', async ({ agent }) => { await agent.act('two'); }); });";

describe('SDK debug producer proof', () => {
  it.each((['runner', 'serial', 'mcp', 'hosted'] as const).flatMap((mode) => (['none', 'literal'] as const).map((secret) => [mode, secret] as const)))('keeps redacted transcripts complete and genuine pixel handoffs private (%s, %s)', async (mode, secret) => {
    const puts: StoredArtifact[] = [];
    const accepted: StoredArtifact[] = [];
    const project = createProject({ 'tests/producer.e2e.ts': mode === 'serial' ? SERIAL : SUITE });
    const fake = createFakeEngine({ pixels: () => ({ pixels: { ...PIXELS, data: new Uint8Array(PNG) }, maskedRegionCount: 0 }) });
    const config: E2EConfig = {
      targets: [{ name: 'fake', platform: 'fake', engine: fake.engine, app: FAKE_APP }],
      cache: 'off', secrets: secret === 'none' ? {} : { token: 'producer-secret-K8j3' },
      artifacts: { store: { async put(artifact) {
        puts.push(artifact);
        if (artifact.redaction === 'complete') accepted.push(artifact);
        return { ref: 'store://complete/' + artifact.sha256 };
      } } },
      agents: { default: { executor: { name: 'producer', async runStep(context) {
        const observation = await context.observe({ pixels: true });
        expect(observation.pixels).toBeDefined();
        await context.attachScreenshot(observation.pixels!, 'sdk');
        await context.attachScreenshot({ ...PIXELS }, 'unsupported');
        context.attachTranscript('transcript producer-secret-K8j3');
        return { status: 'passed' as const, summary: 'passed' };
      } } } },
    };
    let close: (() => Promise<unknown>) | undefined;
    const firstWrites: string[] = [];
    const original = fs.writeFileSync;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]).includes('transcript-')) firstWrites.push(String(args[1]));
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      if (mode === 'runner' || mode === 'serial') {
        const outcome = await runExisting(project, { config, runOptions: { debug: true } });
        expect(outcome.status).toBe('passed');
      } else {
        const resolved = resolveConfig(config, { projectRoot: project.dir, env: {} });
        const options = { config: resolved, target: resolved.targets[0]!, headed: false, env: {}, signal: new AbortController().signal, debug: new DebugTrace(true) };
        const host = mode === 'hosted' ? await openStandaloneHost(options) : undefined;
        close = host?.close;
        const attempt = host === undefined
          ? await openStandaloneAttempt({ ...options, timeoutMs: 10000, signal: options.signal })
          : await host.openAttempt({ name: 'producer', timeoutMs: 10000, signal: options.signal });
        close ??= attempt.close;
        await attempt.fixtures.agent.act('producer');
        expect(await attempt.close()).toEqual([]);
        if (mode === 'hosted') {
          const bundle = attempt.exportDebugBundle()!;
          const transcript = bundle.artifacts.find((row) => row.kind === 'log')!;
          const sdk = bundle.artifacts.find((row) => row.kind === 'screenshot' && row.evidence.status === 'available')!;
          expect(transcript.evidence.status).toBe('available');
          expect(sdk.evidence.status).toBe('available');
          expect(bundle.artifacts.filter((row) => row.kind === 'screenshot' && row.evidence.status === 'withheld')).toHaveLength(1);
          for (const row of [sdk, transcript]) {
            expect(row.stepIds).toHaveLength(1);
            expect(row.observationRevision).toBeNull();
            const record = bundle.report.run.results[0]!.attempts[0]!.artifacts.find((candidate) => candidate.id === row.id)!;
            expect(record.mediaType).toBe(row.mediaType);
            expect(record.producer.kind).toBe('step');
          }
        }
      }
      const expected = secret === 'none' ? 'transcript producer-secret-K8j3' : 'transcript <secret:token>';
      expect(firstWrites).toHaveLength(mode === 'serial' ? 2 : 1);
      expect(firstWrites.every((text) => text === expected)).toBe(true);
      expect(puts).toHaveLength(mode === 'serial' ? 6 : 3);
      expect(accepted).toHaveLength(puts.length);
      expect(puts.every((artifact) => artifact.redaction === 'complete')).toBe(true);
      expect(puts.filter((artifact) => artifact.kind === 'log').every((artifact) => Buffer.from(artifact.bytes).toString() === expected)).toBe(true);
    } finally {
      spy.mockRestore(); syncBuiltinESMExports();
      await close?.(); project.cleanup();
    }
  });

  it('withholds future opaque provider transcripts before the first write and store publication', async () => {
    let calls = 0;
    const puts: StoredArtifact[] = [];
    const project = createProject({ 'tests/producer.e2e.ts': SUITE });
    const fake = createFakeEngine();
    const firstWrites: string[] = [];
    const original = fs.writeFileSync;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]).includes('transcript-')) firstWrites.push(String(args[1]));
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      const outcome = await runExisting(project, { runOptions: { debug: true }, config: {
        targets: [{ name: 'fake', platform: 'fake', engine: fake.engine, app: FAKE_APP }], cache: 'off',
        secrets: { future: () => { calls++; return 'future-token-Z8q4'; } },
        artifacts: { store: { async put(artifact) { puts.push(artifact); return { ref: 'store://seen' }; } } },
        agents: { default: { executor: { name: 'producer', async runStep(context) {
          context.attachTranscript('x'.repeat(1997) + 'future-token-Z8q4');
          return { status: 'passed' as const, summary: 'passed' };
        } } } },
      } });
      expect(outcome.status).toBe('passed');
      expect(calls).toBe(0);
      expect(firstWrites).toEqual(['[text withheld: secret resolution unproven]']);
      expect(puts).toHaveLength(1);
      expect(puts[0]!.redaction).toBe('incomplete');
      expect(Buffer.from(puts[0]!.bytes).toString()).toBe(firstWrites[0]);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); project.cleanup(); }
  });

  it.each(['Waiting… done.', 'Waiting... done.', ...[1, 3, 8].flatMap((size) =>
    ['…', '...', '…[truncated]'].map((marker) => JSON.stringify({ text: 'PQ7rs9Uv4wx2'.slice(0, size) + marker })),
  )])('documents conservative literal-secret transcript withholding: %s', async (text) => {
    const project = createProject({});
    const fake = createFakeEngine({});
    const firstWrites: string[] = [];
    const write = fs.writeFileSync;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]).includes('transcript-')) firstWrites.push(String(args[1]));
      return write(...args);
    });
    syncBuiltinESMExports();
    let close: (() => Promise<unknown>) | undefined;
    try {
      const config = resolveConfig({
        targets: [{ name: 'fake', platform: 'fake', engine: fake.engine, app: FAKE_APP }],
        cache: 'off', secrets: { token: 'PQ7rs9Uv4wx2' },
        agents: { default: { executor: { name: 'literal-cut-tradeoff', async runStep(context) {
          context.attachTranscript(text); return { status: 'passed', summary: 'passed' };
        } } } },
      }, { projectRoot: project.dir, env: {} });
      const signal = new AbortController().signal;
      const host = await openStandaloneHost({ config, target: config.targets[0]!, headed: false, env: {}, signal, debug: new DebugTrace(true) });
      close = host.close;
      const attempt = await host.openAttempt({ name: 'conservative prose', timeoutMs: 10000, signal });
      await attempt.fixtures.agent.act('attach prose');
      expect(await attempt.close()).toEqual([]);
      const marker = '[text withheld: truncated before final redaction]';
      expect(firstWrites).toEqual([marker]);
      const bundle = attempt.exportDebugBundle()!;
      const log = bundle.artifacts.find((row) => row.kind === 'log')!;
      expect(log.evidence.status).toBe('available');
      if (log.evidence.status === 'available') expect(fs.readFileSync(path.join(attempt.artifactsDir, log.evidence.path), 'utf8')).toBe(marker);
    } finally {
      spy.mockRestore(); syncBuiltinESMExports();
      try { await close?.(); }
      finally { project.cleanup(); }
    }
    expect(fs.existsSync(project.dir)).toBe(false);
  });

  it.each(['cut', 'expanded'] as const)('withholds known cuts and bounds transcript text AFTER masking (%s)', async (kind) => {
    const project = createProject({ 'tests/producer.e2e.ts': SUITE });
    const puts: StoredArtifact[] = [];
    try {
      const outcome = await runExisting(project, { runOptions: { debug: true }, config: {
        cache: 'off', secrets: { token: kind === 'cut' ? 'PQ7rs9Uv4wx2' : 'abcdefgh' },
        artifacts: { store: { async put(artifact) { puts.push(artifact); return { ref: 'store://seen' }; } } },
        agents: { default: { executor: { name: 'transcript', async runStep(context) {
          context.attachTranscript(kind === 'cut' ? 'x'.repeat(1997) + 'PQ7…[truncated]' : 'abcdefgh'.repeat(30000));
          return { status: 'passed' as const, summary: 'passed' };
        } } } },
      } });
      expect(outcome.status).toBe('passed');
      const put = puts.find((artifact) => artifact.kind === 'log')!;
      const text = Buffer.from(put.bytes).toString('utf8');
      expect(put.redaction).toBe('complete');
      if (kind === 'cut') {
        expect(text).toBe('[text withheld: truncated before final redaction]');
        expect(text).not.toContain('PQ7');
      } else {
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(262144);
        expect(text.endsWith('…[truncated]')).toBe(true);
        expect(text).not.toContain('abcdefgh');
        expect(text.startsWith('<secret:token>')).toBe(true);
      }
    } finally { project.cleanup(); }
  });

  it.each(['none', 'opaque'] as const)('runs actual CLI --debug with complete-only transcript storage (%s)', (secret) => {
    const project = createProject({
      'tests/producer.e2e.ts': SUITE,
      'e2e.config.ts': `import { appendFileSync, writeFileSync } from 'node:fs';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';
export default {
  targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine().engine, app: FAKE_APP }],
  cache: 'off', reporters: ['json'],
  secrets: ${secret === 'none' ? '{}' : "{ future: () => 'cli-future-secret-B9m3' }"},
  agents: { default: { executor: { name: 'cli-producer', async runStep(context) {
    context.attachTranscript('cli-future-secret-B9m3');
    return { status: 'passed', summary: 'passed' };
  } } } },
  artifacts: { store: { async put(artifact) {
    if (artifact.kind === 'log') {
      appendFileSync('store-redactions.txt', artifact.redaction + '\\n');
      if (artifact.redaction === 'complete') writeFileSync('accepted-transcript.txt', artifact.bytes);
    }
    return { ref: artifact.sha256 };
  } } },
};
`,
    });
    try {
      execFileSync(process.execPath, [fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url)), 'run', '--debug'], {
        cwd: project.dir, env: { ...process.env, E2E_TELEMETRY_DISABLED: '1' }, encoding: 'utf8', timeout: 20000, stdio: 'pipe',
      });
      const report = JSON.parse(fs.readFileSync(path.join(project.dir, '.e2e/report.json'), 'utf8'));
      expect(report.run.status).toBe('passed');
      const log = report.run.results[0].attempts[0].artifacts.find((artifact: { kind: string }) => artifact.kind === 'log');
      expect(log.redaction).toBe(secret === 'none' ? 'complete' : 'incomplete');
      expect(fs.readFileSync(path.join(project.dir, 'store-redactions.txt'), 'utf8').trim()).toBe(log.redaction);
      expect(fs.existsSync(path.join(project.dir, 'accepted-transcript.txt'))).toBe(secret === 'none');
      const text = fs.readFileSync(path.join(project.dir, '.e2e/results', log.path), 'utf8');
      expect(text).toBe(secret === 'none' ? 'cli-future-secret-B9m3' : '[text withheld: secret resolution unproven]');
    } finally { project.cleanup(); }
  });

  it('rejects changed genuine capture bytes before persistence', async () => {
    const project = createProject({ 'tests/producer.e2e.ts': SUITE });
    const fake = createFakeEngine({ pixels: () => ({ pixels: { ...PIXELS, data: new Uint8Array(PNG) }, maskedRegionCount: 0 }) });
    try {
      const outcome = await runExisting(project, { config: {
        targets: [{ name: 'fake', platform: 'fake', engine: fake.engine, app: FAKE_APP }], cache: 'off',
        agents: { default: { executor: { name: 'mutator', async runStep(context) {
          const observation = await context.observe({ pixels: true });
          observation.pixels!.data[0] = 0;
          await expect(context.attachScreenshot(observation.pixels!, 'changed')).rejects.toThrow('changed after the SDK capture');
          return { status: 'passed' as const, summary: 'passed' };
        } } } },
      } });
      expect(outcome.status).toBe('passed');
      expect(outcome.results[0]!.attempts[0]!.artifacts).toEqual([]);
    } finally { project.cleanup(); }
  });
  it.each(['custom', 'genuine'] as const)('binds concurrent sanitized-label collisions to original captured bytes (%s)', async (other) => {
    const project = createProject({});
    const originalPixels = Uint8Array.from([...PNG, 11]);
    const otherPixels = Uint8Array.from([...PNG, 22]);
    let nextPixels = originalPixels;
    const puts: StoredArtifact[] = [];
    const fake = createFakeEngine({ pixels: () => ({ pixels: { ...PIXELS, data: nextPixels }, maskedRegionCount: 0 }) });
    const resolved = resolveConfig({
      targets: [{ name: 'fake', platform: 'fake', engine: fake.engine, app: FAKE_APP }], cache: 'off',
      artifacts: { store: { async put(artifact) { puts.push(artifact); return { ref: artifact.sha256 }; } } },
      agents: { default: { executor: { name: 'collision', async runStep(context) {
        const first = (await context.observe({ pixels: true })).pixels!;
        nextPixels = otherPixels;
        const second = other === 'genuine' ? (await context.observe({ pixels: true })).pixels! : { ...PIXELS, data: otherPixels };
        await Promise.all([context.attachScreenshot(first, 'same.label'), context.attachScreenshot(second, 'same/label')]);
        return { status: 'passed' as const, summary: 'passed' };
      } } } },
    }, { projectRoot: project.dir, env: {} });
    let secondWritten!: () => void;
    const barrier = new Promise<void>((resolve) => { secondWritten = resolve; });
    let writes = 0;
    const original = fsPromises.writeFile;
    const spy = vi.spyOn(fsPromises, 'writeFile').mockImplementation(async (...args) => {
      if (!String(args[0]).endsWith('.png')) return original(...args);
      const index = ++writes;
      await original(...args);
      if (index === 1) await barrier;
      else secondWritten();
    });
    syncBuiltinESMExports();
    const host = await openStandaloneHost({ config: resolved, target: resolved.targets[0]!, headed: false, env: {}, signal: new AbortController().signal, debug: new DebugTrace(false) });
    try {
      const attempt = await host.openAttempt({ name: 'collision', timeoutMs: 10000, signal: new AbortController().signal });
      await attempt.fixtures.agent.act('collision');
      expect(await attempt.close()).toEqual([]);
      const bundle = attempt.exportDebugBundle()!;
      const available = bundle.artifacts.filter((row) => row.evidence.status === 'available');
      expect(available).toHaveLength(other === 'custom' ? 1 : 2);
      const firstHash = createHash('sha256').update(originalPixels).digest('hex');
      expect(available.some((row) => row.evidence.status === 'available' && row.evidence.sha256 === firstHash)).toBe(true);
      expect(puts.some((put) => Buffer.from(put.bytes).equals(Buffer.from(originalPixels)))).toBe(true);
      expect(new Set(puts.map((put) => put.path)).size).toBe(2);
      for (const row of available) {
        const put = puts.find((candidate) => row.evidence.status === 'available' && candidate.sha256 === row.evidence.sha256)!;
        expect(row.evidence.status).toBe('available');
        if (row.evidence.status === 'available') expect(put.size).toBe(row.evidence.size);
        expect(put.mediaType).toBe('image/png');
      }
      if (other === 'custom') expect(bundle.artifacts.filter((row) => row.evidence.status === 'withheld')).toHaveLength(1);
    } finally { secondWritten(); spy.mockRestore(); syncBuiltinESMExports(); await host.close(); project.cleanup(); }
  });

  it.each(['throws', 'string', 'throws-second'] as const)('never evaluates private bound getters merely to open, close or export (%s)', async (mode) => {
    const project = createProject({});
    const fake = createFakeEngine();
    const resolved = resolveConfig({ targets: [{ name: 'fake', platform: 'fake', engine: fake.engine, app: FAKE_APP }], secrets: { unused: 'original-value-R8' } }, { projectRoot: project.dir, env: {} });
    let calls = 0;
    Object.defineProperty(resolved.allSecrets.get('unused')!, 'value', { get() {
      calls++;
      if (mode === 'throws' || mode === 'throws-second' && calls > 1) throw new Error('classification invoked getter');
      return mode === 'string' ? 'getter-secret-R8' : () => 'getter-secret-R8';
    } });
    const host = await openStandaloneHost({ config: resolved, target: resolved.targets[0]!, headed: false, env: {}, signal: new AbortController().signal, debug: new DebugTrace(false) });
    try {
      const attempt = await host.openAttempt({ name: 'getter-secret-R8', timeoutMs: 10000, signal: new AbortController().signal });
      expect(await attempt.close()).toEqual([]);
      const bundle = attempt.exportDebugBundle()!;
      expect(bundle).toBeDefined();
      expect(bundle.report.run.runner.name).toBe('e2e');
      expect(JSON.stringify(bundle)).not.toContain('getter-secret-R8');
      expect(calls).toBe(0);
      expect(attempt.exportDebugBundle()).toBe(bundle);
    } finally { await host.close(); project.cleanup(); }
  });

  it('never downgrades a consumed genuine pixel identity to an unsupported attachment', async () => {
    const project = createProject({ 'tests/producer.e2e.ts': SUITE });
    const fake = createFakeEngine({ pixels: () => ({ pixels: { ...PIXELS, data: new Uint8Array(PNG) }, maskedRegionCount: 0 }) });
    const puts: StoredArtifact[] = [];
    try {
      const outcome = await runExisting(project, { config: {
        targets: [{ name: 'fake', platform: 'fake', engine: fake.engine, app: FAKE_APP }], cache: 'off',
        artifacts: { store: { async put(artifact) { puts.push(artifact); return { ref: artifact.sha256 }; } } },
        agents: { default: { executor: { name: 'reuse', async runStep(context) {
          const pixels = (await context.observe({ pixels: true })).pixels!;
          await context.attachScreenshot(pixels, 'one');
          await expect(context.attachScreenshot(pixels, 'two')).rejects.toThrow('already consumed');
          return { status: 'passed' as const, summary: 'passed' };
        } } } },
      } });
      expect(outcome.status).toBe('passed');
      expect(puts).toHaveLength(1);
      expect(outcome.results[0]!.attempts[0]!.artifacts).toHaveLength(1);
    } finally { project.cleanup(); }
  });

});
