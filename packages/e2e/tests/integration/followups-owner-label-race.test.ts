/** Positive owner #17 regression through the built PRIVATE hosted producer seam.
 * Scheduling barriers interleave two legitimate executor attachments; no test
 * writes or replaces their files. Public openHost does not enable --debug.
 */
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { PNG } from 'pngjs';
import { expect, it, vi } from 'vitest';
import type { E2EConfig, StoredArtifact } from '../../src/types.ts';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import { createProject } from '../helpers/run-project.ts';

const privateRoot = new URL('../../dist/', import.meta.url).href;
const { resolveConfig } = await import(privateRoot + 'config/resolve.js') as typeof import('../../src/config/resolve.ts');
const { openStandaloneHost } = await import(privateRoot + 'run/standalone.js') as typeof import('../../src/run/standalone.ts');
const { DebugTrace } = await import(privateRoot + 'internal/debug.js') as typeof import('../../src/internal/debug.ts');

/** Two distinct, fully encoded PNGs avoid conflating MIME signature and SDK provenance. */
function image(red: number): Buffer {
  const png = new PNG({ width: 1, height: 1 });
  png.data.set([red, 0, 0, 255]);
  return PNG.sync.write(png);
}
const sdkPixels = image(0), customPixels = image(255);
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

it.each([false, true])('keeps an original SDK capture independent of concurrent same-sanitized-label custom pixels, store=%s (owner #17)', async (store) => {
  const project = createProject({});
  let genuineId = '', customId = '', genuinePath = '';
  let originalPixels: Uint8Array = sdkPixels;
  let sdkWritten!: () => void, customWritten!: () => void;
  const sdkWrite = new Promise<void>((resolve) => { sdkWritten = resolve; });
  const customWrite = new Promise<void>((resolve) => { customWritten = resolve; });
  const puts: StoredArtifact[] = [];
  const fake = createFakeEngine({ pixels: () => ({ pixels: { data: sdkPixels, width: 1, height: 1, scale: 1, mediaType: 'image/png' }, maskedRegionCount: 0 }) });
  const config: E2EConfig = {
    targets: [{ name: 'fake', platform: 'fake', engine: fake.engine, app: FAKE_APP }], cache: 'off',
    ...(store ? { artifacts: { store: { async put(artifact: StoredArtifact) { puts.push({ ...artifact, bytes: new Uint8Array(artifact.bytes) }); return { ref: artifact.sha256 }; } } } } : {}),
    agents: { default: { executor: { name: 'legitimate-label-race', async runStep(context) {
      const observation = await context.observe({ pixels: true });
      expect(observation.pixels).toBeDefined();
      originalPixels = new Uint8Array(observation.pixels!.data);
      [genuineId, customId] = await Promise.all([
        context.attachScreenshot(observation.pixels!, 'shared/label'),
        context.attachScreenshot({ data: customPixels, width: 1, height: 1, scale: 1, maskedRegionCount: 0, mediaType: 'image/png' }, 'shared?label'),
      ]);
      return { status: 'passed' as const, summary: 'original SDK pixels and unsupported custom pixels attached' };
    } } } },
  };
  const write = fs.writeFile, open = fs.open;
  const writing = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    const data = args[1];
    if (data instanceof Uint8Array && Buffer.from(data).equals(Buffer.from(originalPixels))) {
      genuinePath = String(args[0]);
      await write(...args); sdkWritten(); return;
    }
    if (data instanceof Uint8Array && Buffer.from(data).equals(customPixels)) {
      await sdkWrite; await write(...args); customWritten(); return;
    }
    return write(...args);
  });
  const measuring = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (String(args[0]) === genuinePath) await customWrite;
    return open(...args);
  });
  syncBuiltinESMExports();
  let close: (() => Promise<unknown>) | undefined;
  try {
    const resolved = resolveConfig(config, { projectRoot: project.dir, env: {} });
    const signal = new AbortController().signal;
    const host = await openStandaloneHost({ config: resolved, target: resolved.targets[0]!, headed: false, env: {}, signal, debug: new DebugTrace(true) });
    close = host.close;
    const attempt = await host.openAttempt({ name: 'concurrent SDK/custom attachments', timeoutMs: 10000, signal });
    await attempt.fixtures.agent.act('attach concurrent same-label screenshots');
    expect(await attempt.close()).toEqual([]);
    const bundle = attempt.exportDebugBundle()!;
    const genuine = bundle.artifacts.find((row) => row.id === genuineId)!;
    const custom = bundle.artifacts.find((row) => row.id === customId)!;
    const record = bundle.report.run.results[0]!.attempts[0]!.artifacts.find((row) => row.id === genuineId)!;
    const expectedHash = digest(originalPixels), customHash = digest(customPixels);
    const actualFileHash = genuine.evidence.status === 'available' ? digest(readFileSync(path.join(attempt.artifactsDir, genuine.evidence.path))) : null;
    console.log(JSON.stringify({ pendingOwner: 17, privateHostedProducer: true, store, genuineStatus: genuine.evidence.status, customStatus: custom.evidence.status,
      expectedOriginalHash: expectedHash, customHash, registeredHash: record.sha256 ?? null, finalFileHash: actualFileHash,
      sdkStoreBytesPreserved: !store || puts.filter((row) => path.join(project.dir, '.e2e/results', row.path) === genuinePath).every((row) => digest(row.bytes) === expectedHash) }));
    expect(genuine.evidence.status).toBe('available');
    expect(record.sha256).toBe(expectedHash);
    expect(custom.evidence.status).toBe('withheld');
    expect(actualFileHash).toBe(expectedHash);
    if (store) {
      const sdkPuts = puts.filter((row) => path.join(project.dir, '.e2e/results', row.path) === genuinePath);
      expect(sdkPuts).toHaveLength(1);
      expect(digest(sdkPuts[0]!.bytes)).toBe(expectedHash);
    }
  } finally {
    sdkWritten(); customWritten();
    writing.mockRestore(); measuring.mockRestore(); syncBuiltinESMExports();
    await close?.(); project.cleanup();
  }
});
