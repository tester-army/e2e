/** A built-public-SDK consumer smoke with synthetic transport responses. No browser, device, or model. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'e2e';
import { defineEngine, ENGINE_SPI_VERSION } from 'e2e/engine';
import { openHost } from 'e2e/runner';

const root = mkdtempSync(path.join(os.tmpdir(), 'e2e-public-debug-'));
const calls = [];
let attempt;
/** The transport is synthetic; its payloads are deterministic and never native evidence. */
async function send(method, payload) {
  calls.push(method);
  if (method === 'start') attempt = payload;
  if (method === 'screenshot') {
    writeFileSync(path.join(attempt.artifactsDir, 'capture.png'), Buffer.from([137, 80, 78, 71]));
    return 'capture.png';
  }
  if (method === 'slow') await new Promise((resolve) => setTimeout(resolve, 100));
}
const engine = defineEngine({
  name: 'synthetic-transport', version: '1.0.0', spiVersion: ENGINE_SPI_VERSION,
  init: () => send('init'), startAttempt: (context) => send('start', context),
  endAttempt: () => send('end'), dispose: () => send('dispose'),
  observe: async () => ({ root: { ref: { id: 'root', revision: 'r1' }, role: 'button', name: 'Synthetic' }, viewport: { width: 100, height: 100, scale: 1 } }),
  artifacts: { screenshot: () => send('screenshot') },
  fixtures: { transport: (context) => context.fixture('transport', {
    slow: () => send('slow'),
  }, { slow: { kind: 'resource' } }) },
});
let host;
try {
  host = await openHost({ cwd: root, config: { timeout: 5_000, cache: 'off', targets: [{ name: 'synthetic', platform: 'synthetic', engine }] }, env: {} });
  for (const status of ['passed', 'failed', 'timed-out']) {
    const session = await host.openSession({ name: 'consumer ' + status, timeout: status === 'timed-out' ? 30 : 5_000 });
    assert.equal(session.exportDebugBundle(), undefined);
    if (status !== 'timed-out') await session.fixtures.app.screenshot();
    if (status === 'failed') expect.soft(1, 'synthetic failure').toBe(2);
    if (status === 'timed-out') await assert.rejects(session.fixtures.transport.slow(), { code: 'TEST_TIMEOUT' });
    const failures = await session.close();
    const bundle = session.exportDebugBundle();
    assert.equal(bundle.schemaVersion, 'session-debug-1');
    assert.equal(bundle.report.run.results[0].attempts[0].status, status);
    assert.equal(bundle.report.run.id, host.runId);
    assert.equal(bundle.report.run.results[0].attempts[0].id, session.attemptId);
    assert.equal(bundle.trace, 'written');
    for (const artifact of bundle.artifacts) {
      if (artifact.evidence.status === 'available') assert.ok(readFileSync(path.join(session.artifactsDir, artifact.evidence.path)).length);
    }
    const serialized = JSON.stringify(bundle);
    await session.close();
    assert.equal(session.exportDebugBundle(), bundle);
    assert.equal(JSON.stringify(session.exportDebugBundle()), serialized);
    assert.ok(Object.isFrozen(bundle.report.run.results[0].attempts[0].steps));
    console.log(JSON.stringify({ schema: bundle.schemaVersion, status, artifacts: bundle.artifacts.length, failures: failures.length, immutable: true }));
  }
  await host.close();
  assert.equal(calls.filter((call) => call === 'init').length, 1);
  assert.equal(calls.filter((call) => call === 'end').length, 3);
  assert.equal(calls.filter((call) => call === 'dispose').length, 1);
} finally {
  await host?.close();
  rmSync(root, { recursive: true, force: true });
}
