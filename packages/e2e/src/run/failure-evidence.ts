/**
 * What the runner saw the moment a failure landed.
 *
 * A failure message says what was asked; it cannot say what the screen held
 * instead. While the session is still open, the runner looks once more and
 * keeps what it sees: the redacted semantic tree as the model would read it,
 * a masked screenshot when pixels are allowed, the location, and for a
 * locator that matched nothing, the nodes closest to what it asked for.
 * Everything here is best-effort and bounded in time: evidence never turns a
 * failure into a different failure, and never fails a passing cleanup.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { formatNode, prepareObservation, type AgentObservation } from '../agent/observation.ts';
import type { ResolvedConfig } from '../config/resolve.ts';
import type { OperationContext, TargetSession } from '../engine/surface.ts';
import type { SemanticNode } from '../engine/contract.ts';
import type { E2EError } from '../internal/errors.ts';
import type { ArtifactSink } from './fixtures.ts';
import type { FailureEvidence } from './records.ts';
import type { SessionSecrecy } from './secrecy.ts';
import type { StepRecord } from './steps.ts';

/** The whole capture, observation and screenshot together, gets this long. */
const EVIDENCE_TIMEOUT_MS = 5_000;
/** Screen lines a locator failure lists as its nearest nodes. */
const MAX_CANDIDATES = 5;
/** Report-relative path of the screen text under the attempt's artifact directory. */
const SCREEN_FILE = 'failure/screen.txt';

export interface FailureEvidenceOptions {
  readonly session: TargetSession;
  readonly steps: readonly StepRecord[];
  readonly error: E2EError;
  readonly secrecy: SessionSecrecy;
  readonly config: ResolvedConfig;
  readonly artifacts: ArtifactSink;
  readonly operation: (signal: AbortSignal, timeoutMs: number) => OperationContext;
  /** Aborts the capture: a run interrupt has no time for evidence. */
  readonly interrupt: AbortSignal;
}

/**
 * Captures the evidence of one failed attempt, or as much of it as the
 * session yields within the budget. Resolves with nothing when nothing was
 * captured, so the record carries no empty block.
 */
export async function captureFailureEvidence(options: FailureEvidenceOptions): Promise<FailureEvidence | undefined> {
  const evidence: FailureEvidence = {};
  const failedStep = options.steps.find((step) => step.status !== 'passed');
  if (failedStep !== undefined) evidence.stepIndex = failedStep.index;

  const timeout = AbortSignal.timeout(EVIDENCE_TIMEOUT_MS);
  const signal = AbortSignal.any([options.interrupt, timeout]);
  if (signal.aborted) return finish(evidence);
  const operation = options.operation(signal, EVIDENCE_TIMEOUT_MS);
  const redact = options.secrecy.ledger.redact;

  let observation: AgentObservation | undefined;
  try {
    const raw = await options.session.observe(operation);
    observation = prepareObservation(raw, { redact, maxBytes: options.config.limits.maxObservationBytes });
  } catch {
    // The session may be gone with the failure (a crashed page, a closed app).
  }

  // The location rides on the observation when the platform has one.
  if (observation?.location !== undefined) evidence.url = observation.location;

  if (observation !== undefined) {
    try {
      const file = path.join(options.artifacts.dir, SCREEN_FILE);
      mkdirSync(path.dirname(file), { recursive: true });
      // An earlier run's file at the same path is overwritten: attempt
      // directories are named by test and attempt index, not by run.
      writeFileSync(file, screenText(observation, evidence.url));
      evidence.screen = options.artifacts.register('log', SCREEN_FILE);
    } catch {
      // An unwritable directory: the tree stays unrecorded.
    }
    const candidates = locatorCandidates(options.error, observation, redact);
    if (candidates.length > 0) evidence.candidates = candidates;
  }

  // Pixels only when the run keeps screenshots and no secret has been filled:
  // rectangle masking cannot prove a tainted viewport redacted.
  if (options.config.artifacts.has('screenshot') && !options.secrecy.taint.value && !signal.aborted) {
    try {
      const relative = await options.session.artifacts.screenshot('failure', operation);
      evidence.screenshot = options.artifacts.register('screenshot', relative);
    } catch {
      // A screenshot the engine could not take is not evidence the report claims.
    }
  }
  return finish(evidence);
}

function finish(evidence: FailureEvidence): FailureEvidence | undefined {
  return Object.keys(evidence).length === 0 ? undefined : evidence;
}

/** The screen file: a header a reader can trust, then the tree exactly as the model reads it. */
function screenText(observation: AgentObservation, url: string | undefined): string {
  const header = [
    `# Screen at failure`,
    ...(url === undefined ? [] : [`url: ${url}`]),
    `revision: ${observation.revision}`,
    `viewport: ${observation.viewport.width}x${observation.viewport.height} @${observation.viewport.scale}`,
    `nodes: ${observation.nodes.size}${observation.truncated ? ' (listing truncated at the observation byte limit)' : ''}`,
  ];
  return `${header.join('\n')}\n\n${observation.text}\n`;
}

/**
 * For a locator that matched nothing or too much, the nodes on screen closest
 * to what it asked for: the same role, a name sharing words with the one
 * requested, or the test id. Rendered as the screen lists them, so the reader
 * can rewrite the locator from what is there.
 */
function locatorCandidates(error: E2EError, observation: AgentObservation, redact: (text: string) => string): string[] {
  if (error.code !== 'LOCATOR_NOT_FOUND' && error.code !== 'LOCATOR_AMBIGUOUS') return [];
  const hints = error.details ?? {};
  const role = hints['role']?.toLowerCase();
  const testId = hints['testId'];
  const words = tokens(hints['name'] ?? '');
  if (role === undefined && testId === undefined && words.length === 0) return [];

  const scored: { score: number; node: SemanticNode }[] = [];
  for (const node of observation.nodes.values()) {
    let score = 0;
    if (role !== undefined && node.role?.toLowerCase() === role) score += 3;
    if (testId !== undefined) {
      const own = node.testId;
      if (own === testId) score += 6;
      else if (own !== undefined && (own.includes(testId) || testId.includes(own))) score += 3;
    }
    if (words.length > 0) {
      const own = new Set(tokens(`${node.name ?? ''} ${node.text ?? ''} ${node.attributes?.['placeholder'] ?? ''}`));
      const shared = words.filter((word) => own.has(word)).length;
      // A name sharing every word outranks one sharing one; a role match alone
      // on a name-less node stays below any word match.
      score += shared * 2 + (shared === words.length ? 2 : 0);
    }
    // A role query names a role; a node of that role with no words in common
    // is still a candidate, but only when the request carried no name.
    if (score > 0 && (words.length === 0 || score > 3 || role === undefined)) scored.push({ score, node });
  }
  return scored
    .toSorted((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES)
    .map(({ node }) => formatNode(node, 0, redact));
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);
}
