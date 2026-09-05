/**
 * Failure-time evidence capture. When a test failure lands with the session
 * still open, the runner records what the screen showed: a masked screenshot
 * (when the run's artifact kinds include one) and the redacted semantic tree,
 * as a `log` artifact. Both go through the same masking and redaction the
 * agent's own observations do (spec 14-security.md), and both are best-effort
 * under the cleanup budget: evidence that cannot be captured is simply absent,
 * never a second failure on top of the first.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { prepareObservation } from '../agent/observation.ts';
import type { OperationContext, TargetSession } from '../backend/surface.ts';
import type { ResolvedConfig } from '../config/resolve.ts';
import type { SecretLedger } from '../internal/redact.ts';
import { withTimeout } from '../internal/time.ts';
import type { ArtifactSink } from './fixtures.ts';
import type { FailureEvidence } from './records.ts';
import type { StepRecorder } from './steps.ts';

/** Report-relative path of the observation snapshot inside the attempt directory. */
const OBSERVATION_SNAPSHOT_PATH = 'failure/observation.txt';

export interface CaptureFailureEvidenceOptions {
  readonly session: TargetSession;
  readonly config: ResolvedConfig;
  readonly secrecy: { readonly ledger: SecretLedger; readonly taint: { readonly value: boolean } };
  readonly steps: StepRecorder;
  readonly artifacts: ArtifactSink;
  /** Mints one backend operation on the cleanup budget with the given signal. */
  readonly operation: (signal: AbortSignal) => OperationContext;
  readonly interruptSignal: AbortSignal;
}

/**
 * Captures the failure evidence of one attempt. Each capture is its own
 * bounded operation, so a hung screenshot cannot cost the observation, and
 * both attach to the step that failed (the most recent step), so the report
 * files them where the failure is.
 */
export async function captureFailureEvidence(
  options: CaptureFailureEvidenceOptions,
): Promise<FailureEvidence> {
  const { session, config, artifacts, steps } = options;
  const evidence: FailureEvidence = { pixelsTainted: options.secrecy.taint.value };

  const bounded = async <T>(work: (operation: OperationContext) => Promise<T>): Promise<T | undefined> => {
    if (options.interruptSignal.aborted) return undefined;
    const scope = new AbortController();
    const signal = AbortSignal.any([options.interruptSignal, scope.signal]);
    try {
      return await withTimeout(
        Promise.resolve().then(() => work(options.operation(signal))),
        config.cleanupTimeout,
        () => new Error('failure evidence capture timed out'),
      );
    } catch {
      scope.abort();
      return undefined;
    }
  };

  if (config.artifacts.includes('screenshot')) {
    const relative = await bounded((operation) => session.artifacts.screenshot('failure', operation));
    if (relative !== undefined) {
      evidence.screenshot = artifacts.register('screenshot', relative);
      steps.attachArtifact(evidence.screenshot);
    }
  }

  const observation = await bounded((operation) => session.observe(operation));
  if (observation !== undefined) {
    const prepared = prepareObservation(observation, {
      redact: options.secrecy.ledger.redact,
      maxBytes: config.agent.maxObservationBytes,
      testIdAttribute: config.testIdAttribute,
    });
    // A backend may report the location with the tree or through the
    // session's own capability; either way it is redacted like the tree.
    const url =
      prepared.url ??
      (session.url === undefined
        ? undefined
        : await bounded((operation) => session.url!(operation)).then((raw) =>
            raw === undefined ? undefined : options.secrecy.ledger.redact(raw),
          ));
    const header = [
      '# e2e failure observation',
      ...(url === undefined ? [] : [`url: ${url}`]),
      `viewport: ${prepared.viewport.width}x${prepared.viewport.height}@${prepared.viewport.scale}`,
      `revision: ${prepared.revision}`,
      `truncated: ${prepared.truncated}`,
      '',
    ];
    try {
      const absolute = path.join(artifacts.dir, OBSERVATION_SNAPSHOT_PATH);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, `${header.join('\n')}\n${prepared.text}\n`, 'utf8');
      evidence.observation = artifacts.register('log', OBSERVATION_SNAPSHOT_PATH);
      steps.attachArtifact(evidence.observation);
    } catch {
      // The snapshot is evidence, not a result: a full disk loses it, not the run.
    }
    if (url !== undefined) evidence.url = url;
  }

  return evidence;
}
