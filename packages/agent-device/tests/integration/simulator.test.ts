/**
 * The agent-device backend against a real booted iOS simulator, through the
 * public contract only: boot, open Settings fresh, observe, locate, perform,
 * anchor, screenshot, dispose. Opt in with `E2E_AGENT_DEVICE_SIMULATOR=1`;
 * needs Xcode with a booted simulator and a working `agent-device doctor`.
 */

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackendHandle, OperationContext, SemanticNode } from 'e2e/backend';
import { agentDevice } from '../../src/index.ts';

const enabled = process.env['E2E_AGENT_DEVICE_SIMULATOR'] === '1';

function operation(): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 120_000, runId: 'run-sim', attemptId: 'sim-1' };
}

function* walk(nodes: readonly SemanticNode[]): Generator<SemanticNode> {
  for (const node of nodes) {
    yield node;
    yield* walk(node.children ?? []);
  }
}

describe.skipIf(!enabled)('agent-device backend on a booted iOS simulator', () => {
  let backend: BackendHandle;
  let artifactsDir: string;

  beforeAll(async () => {
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-agent-device-sim-'));
    backend = agentDevice({ platform: 'ios', app: 'Settings', session: 'e2e-agent-device-integration' });
    await backend.init!({
      runId: 'run-sim',
      targetName: 'ios',
      app: { allowedOrigins: [] },
      testIdAttribute: 'data-testid',
      headed: true,
      signal: new AbortController().signal,
    });
    await backend.startAttempt!({ attemptId: 'sim-1', artifactsDir, signal: new AbortController().signal });
  });

  afterAll(async () => {
    const cleanup = { signal: new AbortController().signal, timeoutMs: 30_000 };
    await backend.endAttempt!(cleanup);
    await backend.dispose!(cleanup);
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('observes Settings with a viewport and named cells', async () => {
    const snapshot = await backend.observe!(operation());
    expect(snapshot.viewport?.width).toBeGreaterThan(0);
    const names = [...walk(snapshot.nodes)].map((node) => node.name ?? '');
    expect(names).toContain('General');
  });

  it('anchors the path on the app and screen, then navigates by grammar and comes back', async () => {
    const root = await backend.url!(operation());
    expect(root).toMatch(/^app:\/\/com\.apple\.preferences\//);

    const [general] = await backend.locate!(
      { kind: 'query', query: { kind: 'text', value: { kind: 'string', value: 'General', exact: true } } },
      operation(),
    );
    expect(general).toBeDefined();
    await backend.perform!(general!.ref, { kind: 'tap' }, operation());

    const inside = await backend.url!(operation());
    expect(new URL(inside).pathname).toBe('/General');
    expect(inside).not.toBe(root);

    await backend.app!.back!(operation());
    expect(await backend.url!(operation())).toBe(root);
  });

  it('writes a screenshot artifact under the attempt directory', async () => {
    const relative = await backend.artifacts!.screenshot('settings', operation());
    expect(relative).toBe('screenshots/001-settings.png');
    const absolute = path.join(artifactsDir, relative);
    expect(existsSync(absolute)).toBe(true);
    expect(statSync(absolute).size).toBeGreaterThan(0);
  });

  it('reports a stale id after a new observation', async () => {
    const first = await backend.observe!(operation());
    const cell = [...walk(first.nodes)].find((node) => node.role === 'listitem');
    expect(cell).toBeDefined();
    await backend.observe!(operation());
    await expect(backend.perform!(cell!.ref, { kind: 'tap' }, operation())).rejects.toMatchObject({
      code: 'NODE_STALE',
    });
  });
});
