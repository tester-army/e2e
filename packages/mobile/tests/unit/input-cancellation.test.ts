import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentDeviceClient } from 'agent-device';
import { expect, it } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { buildEngine } from '../../src/engine.ts';
import { AgentDeviceSurface } from '../../src/surface.ts';
import { InputBudget } from '../../src/support.ts';
import { SETTINGS_SNAPSHOT } from '../helpers/fake-client.ts';
import { boot } from '../helpers/harness.ts';

it.each(['caller abort', 'input deadline'] as const)('cancels a press waiting for readiness at the SDK boundary after %s', async (reason) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'e2e-input-cancel-'));
  let releaseReady!: () => void;
  let markStarted!: () => void;
  let markFinished!: () => void;
  const ready = new Promise<void>((resolve) => { releaseReady = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const finished = new Promise<void>((resolve) => { markFinished = resolve; });
  const controller = new AbortController();
  let delivered = 0;
  const client = createAgentDeviceClient({ session: 'input-cancel', stateDir }, {
    transport: async (request, context) => {
      if (request.command === 'snapshot') return { ok: true, data: SETTINGS_SNAPSHOT };
      if (request.command === 'open') return { ok: true, data: { appName: 'Settings', appBundleId: 'com.apple.Preferences' } };
      if (request.command === 'press') {
        markStarted();
        await ready;
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
    const [target] = await engine.locate!({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'ABOUT', exact: true } } }, operation);
    expect(target).toBeDefined();
    const pressing = engine.perform!(target!.ref, { kind: 'tap' }, operation);
    const rejected = expect(pressing).rejects.toMatchObject({ code: reason === 'caller abort' ? 'CANCELLED' : 'ACTION_MAY_HAVE_COMMITTED' });
    await started;
    if (reason === 'caller abort') controller.abort();
    await rejected;
    // The external control becomes ready after the operation has already ended.
    releaseReady();
    await finished;
    expect(delivered).toBe(0);
  } finally {
    releaseReady();
    await engine.dispose!({ signal: new AbortController().signal, timeoutMs: 1000 });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

it.each(['press', 'type'] as const)('preserves the acknowledgement allowance for %s at the SDK boundary', async (command) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'e2e-input-ack-'));
  let delivered = 0;
  const client = createAgentDeviceClient({ session: 'input-ack', stateDir }, {
    transport: async (request) => {
      delivered += 1;
      await new Promise((resolve) => setTimeout(resolve, 180));
      return request.command === 'type'
        ? { ok: false, error: { code: 'UNSUPPORTED_OPERATION', message: 'Typing is unavailable' } }
        : { ok: true, data: {} };
    },
  });
  const budget = new InputBudget(command, 100, (pending) => pending);
  try {
    if (command === 'press') {
      await expect(budget.send((signal) => client.interactions.press({ x: 20, y: 20, signal }), 0, new AbortController().signal)).resolves.toBeDefined();
    } else {
      await expect(budget.send(() => client.interactions.type({ text: 'hello' }))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION', message: 'Typing is unavailable' });
    }
    expect(delivered).toBe(1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
