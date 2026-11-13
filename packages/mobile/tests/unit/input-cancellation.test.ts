import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentDeviceClient } from 'agent-device';
import { expect, it } from 'vitest';
import type { EngineFixtureContext, OperationContext } from 'e2e-core/engine';
import type { Device } from '../../src/device.ts';
import { buildEngine } from '../../src/engine.ts';
import { AgentDeviceSurface } from '../../src/surface.ts';
import { SETTINGS_SNAPSHOT } from '../helpers/fake-client.ts';
import { boot } from '../helpers/harness.ts';

it.each(['caller abort', 'input deadline', 'device fixture abort'] as const)('cancels a pending press at the SDK boundary after %s', async (reason) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'e2e-input-cancel-'));
  let releaseRequest!: () => void;
  let markStarted!: () => void;
  let markFinished!: () => void;
  const pendingRequest = new Promise<void>((resolve) => { releaseRequest = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const finished = new Promise<void>((resolve) => { markFinished = resolve; });
  const controller = new AbortController();
  let delivered = 0;
  const snapshot = reason === 'device fixture abort'
    ? {
      ...SETTINGS_SNAPSHOT,
      nodes: [
        ...SETTINGS_SNAPSHOT.nodes,
        { ref: '@e30', index: 10, parentIndex: 0, depth: 1, type: 'static-text', label: 'Speed up your typing by sliding your finger across the letters to compose a word.', rect: { x: 20, y: 600, width: 350, height: 60 } },
        { ref: '@e31', index: 11, parentIndex: 0, depth: 1, type: 'button', label: 'Continue', rect: { x: 95, y: 700, width: 200, height: 44 } },
      ],
      keyboard: { kind: 'visible', frame: { x: 0, y: 583, width: 390, height: 261 } },
    }
    : SETTINGS_SNAPSHOT;
  const client = createAgentDeviceClient({ session: 'input-cancel', stateDir }, {
    transport: async (request, context) => {
      if (request.command === 'snapshot') return { ok: true, data: snapshot };
      if (request.command === 'open') return { ok: true, data: { appName: 'Settings', appBundleId: 'com.apple.Preferences' } };
      if (request.command === 'keyboard') return { ok: false, error: { code: 'UNSUPPORTED_OPERATION', message: 'The keyboard has no dismiss key' } };
      if (request.command === 'press') {
        markStarted();
        await pendingRequest;
        if (context?.signal?.aborted !== true) delivered += 1;
        markFinished();
      }
      return { ok: true, data: {} };
    },
  });
  const engine = buildEngine(new AgentDeviceSurface({ platform: 'ios', transition: 0, settle: false }, () => client));
  const operation: OperationContext = { signal: controller.signal, timeoutMs: reason === 'input deadline' ? 100 : 30000, runId: 'run', attemptId: 'a1', origin: 'test' };
  try {
    await boot({ engine, app: { bundleId: 'Settings' } });
    await engine.session!.restart!(operation);
    let pressing: Promise<void>;
    if (reason === 'device fixture abort') {
      const device = engine.fixtures!['device']!({
        fixture: (_name: string, value: object) => value,
        signal: controller.signal,
        timeouts: { action: 30_000 },
      } as unknown as EngineFixtureContext) as Device;
      pressing = device.dismissKeyboard();
    } else {
      const [target] = await engine.locate!({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'ABOUT', exact: true } } }, operation);
      expect(target).toBeDefined();
      pressing = engine.perform!(target!.ref, { kind: 'tap' }, operation);
    }
    const rejected = expect(pressing).rejects.toMatchObject({ code: reason === 'input deadline' ? 'ACTION_MAY_HAVE_COMMITTED' : 'CANCELLED' });
    await started;
    if (reason !== 'input deadline') controller.abort();
    await rejected;
    // The external request resumes after the operation has already ended.
    releaseRequest();
    await finished;
    expect(delivered).toBe(0);
  } finally {
    releaseRequest();
    await engine.dispose!({ signal: new AbortController().signal, timeoutMs: 1000 });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
