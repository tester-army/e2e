/**
 * The agent-device engine against a real booted iOS simulator, through the
 * public contract only: boot, open Settings fresh, observe, locate, perform,
 * location, screenshot, dispose. Opt in with `E2E_AGENT_DEVICE_SIMULATOR=1`;
 * needs Xcode with a booted simulator and a working `agent-device doctor`.
 */

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineHandle, OperationContext, SemanticNode } from '@e2edev/e2e/engine';
import { agentDevice } from '../../src/index.ts';

const enabled = process.env['E2E_AGENT_DEVICE_SIMULATOR'] === '1';

function operation(): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 120_000, runId: 'run-sim', attemptId: 'sim-1', origin: 'test' };
}

/**
 * An observation answers immediately, like every engine read; a push
 * transition takes a few frames, so the test polls for the location to change
 * the way the runner's `expect` polls a locator, instead of sampling one frame.
 */
async function locationWhen(engine: EngineHandle, accept: (location: string) => boolean): Promise<string> {
  const deadline = Date.now() + 8_000;
  let last = '';
  while (Date.now() < deadline) {
    last = (await engine.observe!(operation())).location ?? '';
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return last;
}

function* walk(root: SemanticNode): Generator<SemanticNode> {
  for (const node of root.children ?? []) {
    yield node;
    yield* walk(node);
  }
}

describe.skipIf(!enabled)('agent-device engine on a booted iOS simulator', () => {
  let engine: EngineHandle;
  let artifactsDir: string;

  beforeAll(async () => {
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-agent-device-sim-'));
    engine = agentDevice({ platform: 'ios', app: 'Settings', session: 'e2e-agent-device-integration' });
    await engine.init!({
      runId: 'run-sim',
      targetName: 'ios',
      projectRoot: process.cwd(),
      app: {},
      headed: true,
      workerSlot: 0,
      signal: new AbortController().signal,
    });
    await engine.startAttempt!({ attemptId: 'sim-1', artifactsDir, signal: new AbortController().signal });
  });

  afterAll(async () => {
    const cleanup = { signal: new AbortController().signal, timeoutMs: 30_000 };
    await engine.endAttempt!(cleanup);
    await engine.dispose!(cleanup);
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('observes Settings under a stable root with a viewport and named cells', async () => {
    const snapshot = await engine.observe!(operation());
    expect(snapshot.viewport.width).toBeGreaterThan(0);
    expect(snapshot.root.ref.id).toBe('root');
    expect(snapshot.root.rect).toEqual({ x: 0, y: 0, width: snapshot.viewport.width, height: snapshot.viewport.height });
    const names = [...walk(snapshot.root)].map((node) => node.name ?? '');
    expect(names).toContain('General');
  });

  it('locates the observation on the app and screen, then navigates by grammar and comes back', async () => {
    const root = await locationWhen(engine, (location) => location.startsWith('com.apple.Preferences'));
    expect(root).toMatch(/^com\.apple\.Preferences/);

    const [general] = await engine.locate!(
      { kind: 'query', query: { kind: 'text', value: { kind: 'string', value: 'General', exact: true } } },
      operation(),
    );
    expect(general).toBeDefined();
    await engine.perform!(general!.ref, { kind: 'tap' }, operation());

    const inside = await locationWhen(engine, (location) => location !== root);
    expect(inside).toBe('com.apple.Preferences / General');

    await engine.session!.back!(operation());
    expect(await locationWhen(engine, (location) => location === root)).toBe(root);
  });

  it('scrolls the whole screen through a swipe on the root', async () => {
    const { root } = await engine.observe!(operation());
    await engine.perform!(root.ref, { kind: 'swipe', direction: 'down' }, operation());
    await engine.perform!(root.ref, { kind: 'swipe', direction: 'up' }, operation());
  });

  it('writes a screenshot artifact under the attempt directory', async () => {
    const relative = await engine.artifacts!.screenshot('settings', operation());
    expect(relative).toBe('screenshots/001-settings.png');
    const absolute = path.join(artifactsDir, relative);
    expect(existsSync(absolute)).toBe(true);
    expect(statSync(absolute).size).toBeGreaterThan(0);
  });

  it('reports a stale id after a new observation', async () => {
    const first = await engine.observe!(operation());
    const cell = [...walk(first.root)].find((node) => node.role === 'listitem');
    expect(cell).toBeDefined();
    await engine.observe!(operation());
    await expect(engine.perform!(cell!.ref, { kind: 'tap' }, operation())).rejects.toMatchObject({
      code: 'NODE_STALE',
    });
  });
});
