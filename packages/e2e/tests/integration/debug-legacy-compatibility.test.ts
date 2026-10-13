/** Built ordinary CLI/serial/MCP and private hosted seams, not a new public debug option. */
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { expect, it, vi } from 'vitest';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import { defineEngine } from '../helpers/engine-runtime.ts';
import { createProject, runExisting } from '../helpers/run-project.ts';
import type { StoredArtifact } from '../../src/types.ts';

const builtRoot = new URL('../../dist/', import.meta.url).href;
const { resolveConfig } = await import(builtRoot + 'config/resolve.js') as typeof import('../../src/config/resolve.ts');
const { openStandaloneHost, openStandaloneAttempt } = await import(builtRoot + 'run/standalone.js') as typeof import('../../src/run/standalone.ts');
const { DebugTrace } = await import(builtRoot + 'internal/debug.js') as typeof import('../../src/internal/debug.ts');
const { secrets } = await import(builtRoot + 'index.js') as typeof import('../../src/index.ts');
const png = new PNG({ width: 1, height: 1 });
png.data.set([0, 0, 0, 255]);
const image = PNG.sync.write(png);

/** Trusted engine returns its original file without renaming, copying or fake registration metadata. */
function captureEngine(name: string) {
  const fake = createFakeEngine();
  const { capabilities, ...spec } = fake.engine;
  void capabilities;
  const engine = defineEngine({ ...spec, artifacts: { async screenshot() {
    const dir = fake.attempts.at(-1)!.artifactsDir;
    fs.writeFileSync(path.join(dir, name), image);
    return name;
  } } });
  return { fake, engine };
}

it.each([true, false].flatMap((store) => ['custom', 'genuine'].map((source) => [store, source] as const)))('denies late unsafe handoff after a real authorized fill during delayed image measurement, store=%s source=%s', async (store, source) => {
  const project = createProject({});
  const puts: StoredArtifact[] = [];
  let id = '', tainted = false, measured = false;
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const fake = createFakeEngine({
    tree: { ref: { id: 'token', revision: '' }, role: 'textbox', name: 'Token' },
    pixels: () => ({ pixels: { data: image, width: 1, height: 1, scale: 1, mediaType: 'image/png' }, maskedRegionCount: 0 }),
  });
  const open = fsPromises.open;
  const spy = vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
    if (String(args[0]).endsWith('.png')) { entered(); await barrier; measured = true; }
    return open(...args);
  });
  syncBuiltinESMExports();
  let close: (() => Promise<unknown>) | undefined;
  try {
    const resolved = resolveConfig({
      targets: [{ name: 'fake', platform: 'fake', engine: fake.engine, app: FAKE_APP }], cache: 'off', secrets: { token: 'authorized-fill-R9' },
      ...(store ? { artifacts: { store: { async put(artifact: StoredArtifact) { puts.push({ ...artifact, bytes: new Uint8Array(artifact.bytes) }); return { ref: artifact.sha256 }; } } } } : {}),
      agents: { default: { executor: { name: 'late-fill', async runStep(context) {
        const observation = await context.observe({ tree: true, pixels: source === 'genuine' });
        const pixels = source === 'genuine' ? observation.pixels! : { data: image, width: 1, height: 1, scale: 1, mediaType: 'image/png' as const, maskedRegionCount: 0 };
        id = await context.attachScreenshot(pixels, 'before-fill');
        await reading;
        expect(context.pixelsTainted).toBe(false);
        await context.actions.typeSecret({ id: observation.tree!.id }, 'token');
        tainted = context.pixelsTainted;
        expect(measured).toBe(false);
        release();
        return { status: 'passed' as const, summary: 'filled' };
      } } } },
    }, { projectRoot: project.dir, env: {} });
    const signal = new AbortController().signal;
    const host = await openStandaloneHost({ config: resolved, target: resolved.targets[0]!, headed: false, env: {}, signal, debug: new DebugTrace(false) });
    close = host.close;
    const attempt = await host.openAttempt({ name: 'late-fill', timeoutMs: 10000, signal });
    await attempt.fixtures.agent.act('fill token', { params: { token: secrets.get('token') } });
    expect(await attempt.close()).toEqual([]);
    expect(tainted).toBe(true);
    expect(measured).toBe(true);
    expect(fake.callsOf(attempt.attemptId, 'perform')).toEqual([expect.objectContaining({ action: { kind: 'fill', value: 'authorized-fill-R9', sensitive: true } })]);
    expect(puts.filter((put) => put.kind === 'screenshot')).toEqual([]);
    expect(attempt.exportDebugBundle()!.artifacts.find((row) => row.id === id)!.evidence.status).toBe('withheld');
  } finally { release(); spy.mockRestore(); syncBuiltinESMExports(); await close?.(); project.cleanup(); }
});

it.each(['serial', 'mcp', 'hosted'].flatMap((mode) => ['capture.png', 'capture image.png', 'écran.png'].map((name) => [mode, name] as const)))('keeps genuine original engine captures ordinary-complete but hosted-portable, mode=%s name=%s', async (mode, name) => {
  const project = createProject({ 'tests/capture.e2e.ts': "import { test } from 'e2e'; test.describe('serial', { serial: true }, () => { test('one', async ({ app }) => { await app.screenshot(); }); test('two', async ({ app }) => { await app.screenshot(); }); });" });
  const { fake, engine } = captureEngine(name);
  const puts: StoredArtifact[] = [];
  const config = { targets: [{ name: 'fake', platform: 'fake', engine, app: FAKE_APP }], cache: 'off' as const,
    artifacts: { store: { async put(artifact: StoredArtifact) { puts.push({ ...artifact, bytes: new Uint8Array(artifact.bytes) }); return { ref: artifact.sha256 }; } } },
  };
  let close: (() => Promise<unknown>) | undefined;
  try {
    if (mode === 'serial') {
      const outcome = await runExisting(project, { config });
      expect(outcome.status).toBe('passed');
      const records = outcome.report.run.serialGroups.flatMap((group) => group.attempts.flatMap((attempt) => attempt.artifacts));
      expect(records.length).toBeGreaterThan(0);
      expect(records.every((row) => row.redaction === 'complete' && row.path?.endsWith('/' + name))).toBe(true);
    } else {
      const resolved = resolveConfig(config, { projectRoot: project.dir, env: {} });
      const signal = new AbortController().signal;
      const options = { config: resolved, target: resolved.targets[0]!, headed: false, env: {}, signal, debug: new DebugTrace(false) };
      const host = mode === 'hosted' ? await openStandaloneHost(options) : undefined;
      close = host?.close;
      const attempt = host ? await host.openAttempt({ name: 'capture', timeoutMs: 10000, signal }) : await openStandaloneAttempt({ ...options, timeoutMs: 10000 });
      close ??= attempt.close;
      expect(await attempt.fixtures.app.screenshot()).toBe(name);
      expect(await attempt.close()).toEqual([]);
      if (mode === 'hosted') {
        const row = attempt.exportDebugBundle()!.artifacts.find((artifact) => artifact.kind === 'screenshot')!;
        expect(row.evidence.status).toBe(name === 'capture.png' ? 'available' : 'withheld');
        if (name !== 'capture.png') expect(row.evidence).not.toHaveProperty('path');
      }
    }
    const expectedPuts = mode === 'hosted' && name !== 'capture.png' ? 0 : mode === 'serial' ? 2 : 1;
    expect(puts).toHaveLength(expectedPuts);
    for (const put of puts) {
      expect(put.redaction).toBe('complete');
      expect(put.path.endsWith('/' + name)).toBe(true);
      expect(Buffer.from(put.bytes)).toEqual(image);
    }
    expect(fake.attempts).toHaveLength(1);
    expect(fs.existsSync(path.join(fake.attempts[0]!.artifactsDir, name))).toBe(true);
  } finally { await close?.(); project.cleanup(); }
});

it.each(['capture.png', 'capture image.png', 'écran.png'])('runs actual CLI with a genuine contained engine filename: %s', (name) => {
  const project = createProject({
    'tests/capture.e2e.ts': "import { test } from 'e2e'; test('capture', async ({ app }) => { await app.screenshot(); });",
    'e2e.config.ts': CONFIG_TEMPLATE.replace('NAME_JSON', JSON.stringify(name)).replace('IMAGE_JSON', JSON.stringify([...image])),
  });
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url)), 'run'], {
      cwd: project.dir, env: { ...process.env, E2E_TELEMETRY_DISABLED: '1' }, encoding: 'utf8', timeout: 20000, stdio: 'pipe',
    });
    const report = JSON.parse(fs.readFileSync(path.join(project.dir, '.e2e/report.json'), 'utf8'));
    expect(report.run.status).toBe('passed');
    const record = report.run.results[0].attempts[0].artifacts[0];
    expect(record.redaction).toBe('complete');
    expect(record.path.endsWith('/' + name)).toBe(true);
    const put = JSON.parse(fs.readFileSync(path.join(project.dir, 'store.txt'), 'utf8').trim());
    expect(put.redaction).toBe('complete');
    expect(Buffer.from(put.bytes)).toEqual(image);
    expect(put.path).toBe(record.path);
  } finally { project.cleanup(); }
});

const CONFIG_TEMPLATE = "import { writeFileSync, appendFileSync } from 'node:fs';\nimport path from 'node:path';\nimport { defineEngine } from 'e2e/engine';\nimport { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';\nconst fake = createFakeEngine();\nconst { capabilities, ...spec } = fake.engine;\nconst engine = defineEngine({ ...spec, artifacts: { async screenshot() {\n  const name = NAME_JSON;\n  writeFileSync(path.join(fake.attempts.at(-1).artifactsDir, name), Buffer.from(IMAGE_JSON));\n  return name;\n} } });\nexport default { targets: [{ name: 'fake', platform: 'fake', engine, app: FAKE_APP }], reporters: ['json'], cache: 'off',\n  artifacts: { store: { async put(artifact) {\n    appendFileSync('store.txt', JSON.stringify({ redaction: artifact.redaction, path: artifact.path, bytes: [...artifact.bytes] }) + '\\n');\n    return { ref: artifact.sha256 };\n  } } },\n};\n";
