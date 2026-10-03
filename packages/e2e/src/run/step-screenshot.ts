/**
 * The frame after one top-level step, for `screenshot: 'every-step'`.
 *
 * Best-effort and bounded, like the failure screenshot: a capture that fails
 * or outlives its operation budget becomes an `engine` event on the step and
 * never its verdict. A viewport a secret fill tainted is never captured; the
 * step records the denial instead, as `agent.assert` does.
 */

import { open, rm } from 'node:fs/promises';
import path from 'node:path';
import { recordPolicyEvent } from '../agent/phases.ts';
import type { OperationContext, TargetSession } from '../engine/surface.ts';
import { classifyError } from '../internal/errors.ts';
import { timestamp } from '../internal/ids.ts';
import { withAbort, withTimeout } from '../internal/time.ts';
import type { ArtifactSink } from './fixtures.ts';
import type { SessionSecrecy } from './secrecy.ts';
import type { StepRecord, StepRecorder } from './steps.ts';

/** The eight bytes every PNG file starts with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Steps that keep a frame of their own; a second one after them would be the same picture. */
const SELF_CAPTURING: ReadonlySet<string> = new Set(['app.screenshot', 'agent.assert']);

export interface StepScreenshotOptions {
  readonly record: StepRecord;
  /** The attempt's open session; null before launch or after it closed. */
  readonly session: TargetSession | null;
  readonly secrecy: SessionSecrecy | undefined;
  readonly steps: StepRecorder;
  readonly artifacts: ArtifactSink;
  readonly operation: (signal: AbortSignal, timeoutMs: number) => OperationContext;
  /** The capture's budget, the action timeout. */
  readonly timeoutMs: number;
  /** The attempt's signal: an interrupt or a timeout ends the wait. */
  readonly signal: AbortSignal;
}

/** Screenshots the screen a passed step left, and attaches the frame to that step. */
export async function captureStepScreenshot(options: StepScreenshotOptions): Promise<void> {
  const { record, session, signal } = options;
  // Read live each time: a concurrent step's secret fill can taint the viewport mid-capture.
  const tainted = (): boolean => options.secrecy?.exposure.withholdsPixels === true;
  if (SELF_CAPTURING.has(record.api) || session === null || signal.aborted) return;
  if (tainted()) {
    recordPolicyEvent(options.steps, 'step.screenshot', 'denied', 'PIXEL_TAINTED');
    return;
  }
  const startedAt = timestamp();
  const startedMs = Date.now();
  // Set once the wait gave up: a frame landing after that is nobody's.
  let abandoned = false;
  try {
    const operation = options.operation(signal, options.timeoutMs);
    const capture = session.artifacts.capture(`step-${record.index}`, operation);
    // Given up on, the capture may still land later: nobody registers that file, so it goes.
    void capture.then((late) => (abandoned ? discard(options.artifacts, late.path) : undefined), () => undefined);
    const shot = await withTimeout(
      withAbort(capture, signal, () => new Error('the attempt ended before the step screenshot was captured')),
      options.timeoutMs,
      () => new Error(`step screenshot outlived its ${options.timeoutMs} ms budget`),
    );
    // A concurrent step may have filled a secret while the frame was taken: that frame can show it.
    if (tainted()) {
      await discard(options.artifacts, shot.path);
      recordPolicyEvent(options.steps, 'step.screenshot', 'denied', 'PIXEL_TAINTED');
      return;
    }
    options.steps.attachArtifact(options.artifacts.register('screenshot', shot.path));
    if (shot.viewport !== undefined) {
      options.steps.amendViewport({ ...shot.viewport, scale: await pixelScale(path.join(options.artifacts.dir, shot.path), shot.viewport.width) });
    }
  } catch (cause) {
    abandoned = true;
    const code = classifyError(cause).code;
    // Before the app is open there is no screen to capture, which is not a failed capture.
    if (code === 'APP_NOT_OPEN') return;
    options.steps.recordEvent({
      kind: 'engine',
      name: 'step.screenshot',
      status: 'failed',
      startedAt,
      durationMs: Date.now() - startedMs,
      code,
    });
  }
}

/** Deletes a frame the report will not carry, so no unregistered pixels stay in the attempt directory. */
async function discard(artifacts: ArtifactSink, relative: string): Promise<void> {
  await rm(path.join(artifacts.dir, relative), { force: true }).catch(() => undefined);
}

/** How many image pixels one viewport unit is, from the PNG's own header; 1 when the header cannot be read. */
async function pixelScale(file: string, viewportWidth: number): Promise<number> {
  try {
    const handle = await open(file, 'r');
    try {
      const header = Buffer.alloc(24);
      await handle.read(header, 0, 24, 0);
      if (!header.subarray(0, 8).equals(PNG_SIGNATURE)) return 1;
      // A PNG's width is the big-endian word at byte 16, inside its IHDR chunk.
      const width = header.readUInt32BE(16);
      return width > 0 && viewportWidth > 0 ? Math.round((width / viewportWidth) * 100) / 100 : 1;
    } finally {
      await handle.close();
    }
  } catch {
    return 1;
  }
}
