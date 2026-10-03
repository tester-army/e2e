/** The frame after a step under `screenshot: 'every-step'`: when it is taken, attached, denied, or given up on. */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OperationContext, TargetSession } from '../../src/engine/surface.ts';
import { TestError } from '../../src/internal/errors.ts';
import type { ArtifactSink } from '../../src/run/fixtures.ts';
import type { SessionSecrecy } from '../../src/run/secrecy.ts';
import { captureStepScreenshot } from '../../src/run/step-screenshot.ts';
import { StepRecorder } from '../../src/run/steps.ts';

/** A session whose only working part is `artifacts.screenshot`. */
function sessionWith(screenshot: (label: string | undefined) => Promise<string>): TargetSession {
  return { artifacts: { screenshot } } as unknown as TargetSession;
}

function sink(dir = '/tmp/a'): ArtifactSink & { readonly registered: string[] } {
  const registered: string[] = [];
  return {
    dir,
    registered,
    register: (kind, relativePath) => {
      registered.push(`${kind}:${relativePath}`);
      return `art-${registered.length - 1}`;
    },
    link: () => 'link',
  };
}

const clean = { exposure: { withholdsPixels: false } } as unknown as SessionSecrecy;
const tainted = { exposure: { withholdsPixels: true } } as unknown as SessionSecrecy;
const operation = (signal: AbortSignal, timeoutMs: number): OperationContext =>
  ({ signal, timeoutMs, runId: 'r', attemptId: 'a', origin: 'test' }) as OperationContext;

/** Runs one step whose afterStep is the capture, and returns the step record and the sink. */
async function stepWith(api: string, session: TargetSession | null, secrecy: SessionSecrecy | undefined, timeoutMs = 1_000) {
  const artifacts = sink();
  const steps: StepRecorder = new StepRecorder('a', {
    afterStep: (record) =>
      captureStepScreenshot({ record, session, secrecy, steps, artifacts, operation, timeoutMs, signal: new AbortController().signal }),
  });
  await steps.run('app', api, 'x', async () => undefined);
  return { record: steps.all()[0]!, artifacts };
}

describe('captureStepScreenshot', () => {
  it('attaches one screenshot to the step, labelled by its index', async () => {
    const labels: (string | undefined)[] = [];
    const { record, artifacts } = await stepWith('screen.tap', sessionWith(async (label) => {
      labels.push(label);
      return 'screenshots/001-step-0.png';
    }), clean);
    expect(labels).toEqual(['step-0']);
    expect(artifacts.registered).toEqual(['screenshot:screenshots/001-step-0.png']);
    expect(record.artifacts).toEqual(['art-0']);
  });

  it('leaves steps that keep their own frame alone', async () => {
    for (const api of ['app.screenshot', 'agent.assert']) {
      const { artifacts } = await stepWith(api, sessionWith(async () => 'x.png'), clean);
      expect(artifacts.registered).toEqual([]);
    }
  });

  it('takes nothing after a secret fill, and says so with a policy event', async () => {
    let asked = 0;
    const { record, artifacts } = await stepWith('screen.tap', sessionWith(async () => {
      asked += 1;
      return 'x.png';
    }), tainted);
    expect(asked).toBe(0);
    expect(artifacts.registered).toEqual([]);
    expect(record.events).toMatchObject([{ kind: 'policy', name: 'step.screenshot', decision: 'denied', code: 'PIXEL_TAINTED' }]);
  });

  it('records a failed capture as an engine event and keeps the step passed', async () => {
    const { record } = await stepWith('screen.tap', sessionWith(async () => Promise.reject(new Error('page closed'))), clean);
    expect(record.status).toBe('passed');
    expect(record.events).toMatchObject([{ kind: 'engine', name: 'step.screenshot', status: 'failed' }]);
    expect(record.artifacts).toEqual([]);
  });

  it('records nothing for a step before the app is open: there is no screen to capture', async () => {
    const notOpen = new TestError('APP_NOT_OPEN', 'no app page is open');
    const { record } = await stepWith('browser.route', sessionWith(async () => Promise.reject(notOpen)), clean);
    expect(record.events).toEqual([]);
    expect(record.artifacts).toEqual([]);
  });

  it('gives up on a capture that never settles within its budget', async () => {
    const started = Date.now();
    const { record } = await stepWith('screen.tap', sessionWith(() => new Promise<string>(() => undefined)), clean, 50);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(record.status).toBe('passed');
    expect(record.events).toMatchObject([{ kind: 'engine', name: 'step.screenshot', status: 'failed' }]);
  });

  it('does nothing without a session', async () => {
    const { record } = await stepWith('screen.tap', null, undefined);
    expect(record.events).toEqual([]);
    expect(record.artifacts).toEqual([]);
  });

  it('discards a frame taken while a secret fill raced it, and says so', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'step-shot-'));
    const exposure = { withholdsPixels: false };
    const secrecy = { exposure } as unknown as SessionSecrecy;
    const artifacts = sink(dir);
    const session = sessionWith(async () => {
      // A concurrent step fills a secret while the capture is in flight.
      exposure.withholdsPixels = true;
      mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
      writeFileSync(path.join(dir, 'screenshots', 'raced.png'), 'pixels');
      return 'screenshots/raced.png';
    });
    const steps: StepRecorder = new StepRecorder('a', {
      afterStep: (record) =>
        captureStepScreenshot({ record, session, secrecy, steps, artifacts, operation, timeoutMs: 1_000, signal: new AbortController().signal }),
    });
    await steps.run('app', 'screen.hover', 'x', async () => undefined);
    const record = steps.all()[0]!;
    expect(artifacts.registered).toEqual([]);
    expect(record.artifacts).toEqual([]);
    expect(existsSync(path.join(dir, 'screenshots', 'raced.png'))).toBe(false);
    expect(record.events).toMatchObject([{ kind: 'policy', name: 'step.screenshot', decision: 'denied', code: 'PIXEL_TAINTED' }]);
  });
});

describe('a capture given up on', () => {
  it('deletes the frame when it lands after the budget, and keeps a frame that landed in time', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'step-shot-late-'));
    const write = (name: string): string => {
      mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
      writeFileSync(path.join(dir, 'screenshots', name), 'pixels');
      return `screenshots/${name}`;
    };
    let land: (() => void) | undefined;
    const late = sessionWith(() => new Promise<string>((resolve) => (land = () => resolve(write('late.png')))));
    const steps: StepRecorder = new StepRecorder('a', {
      afterStep: (record) =>
        captureStepScreenshot({ record, session: late, secrecy: clean, steps, artifacts: sink(dir), operation, timeoutMs: 30, signal: new AbortController().signal }),
    });
    await steps.run('app', 'screen.tap', 'x', async () => undefined);
    land!();
    // The deletion is fired from the capture's own settlement, unawaited: poll for it with a deadline.
    const lateFile = path.join(dir, 'screenshots', 'late.png');
    for (let waited = 0; existsSync(lateFile) && waited < 2_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(lateFile)).toBe(false);

    const onTime = sessionWith(async () => write('on-time.png'));
    const kept: StepRecorder = new StepRecorder('b', {
      afterStep: (record) =>
        captureStepScreenshot({ record, session: onTime, secrecy: clean, steps: kept, artifacts: sink(dir), operation, timeoutMs: 1_000, signal: new AbortController().signal }),
    });
    await kept.run('app', 'screen.tap', 'x', async () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(path.join(dir, 'screenshots', 'on-time.png'))).toBe(true);
    expect(kept.all()[0]!.artifacts).toHaveLength(1);
  });
});
