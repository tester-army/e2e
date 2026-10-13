/** Positive owner #18 SOURCE-only private resolved-config counterexample.
 * resolveConfig public inputs are plain entries. This test installs a private
 * effective-definition accessor only AFTER resolution, not a public API claim.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/resolve.ts';
import { openStandaloneHost } from '../../src/run/standalone.ts';
import type { StandaloneAttempt } from '../../src/run/standalone.ts';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';

it('classifies private opaque descriptors without invoking a getter during host open/close (owner #18)', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'e2e-private-classification-'));
  const fake = createFakeEngine();
  let getterReads = 0, providerCalls = 0;
  const provider = () => { providerCalls++; return 'private-provider-value-R6'; };
  const config = resolveConfig({ targets: [{ name: 'synthetic', platform: 'synthetic', engine: fake.engine, app: FAKE_APP }], secrets: { future: provider } }, { projectRoot: cwd, env: {} });
  const definition = config.allSecrets.get('future')!;
  Object.defineProperty(definition, 'value', { configurable: true, get() {
    getterReads++;
    if (getterReads > 1) throw new Error('synthetic second classification getter read');
    return provider;
  } });
  const signal = new AbortController().signal;
  let close: (() => Promise<unknown>) | undefined;
  let attempt: StandaloneAttempt | undefined;
  let failure: unknown;
  let stage = 'open';
  try {
    const host = await openStandaloneHost({ config, target: config.targets[0]!, headed: false, env: {}, signal });
    close = host.close;
    try {
      attempt = await host.openAttempt({ name: 'private getter', timeoutMs: 10000, signal });
      stage = 'close';
      expect(await attempt.close()).toEqual([]);
      stage = 'closed';
    } catch (cause) { failure = cause; }
    const bundle = attempt?.exportDebugBundle();
    console.log(JSON.stringify({ pendingOwner: 18, sourceOnlyPrivateResolvedConfig: true, stage, getterReads, providerCalls, bundleAssigned: bundle !== undefined,
      failure: failure instanceof Error ? failure.message : null }));
    expect(failure).toBeUndefined();
    expect(getterReads).toBe(0);
    expect(providerCalls).toBe(0);
    expect(bundle?.report.run.runner.name).toBe('e2e');
    expect(bundle?.report.run.results[0]!.titlePath).toEqual(['[text withheld: secret resolution unproven]']);
  } finally { await close?.(); rmSync(cwd, { recursive: true, force: true }); }
});
