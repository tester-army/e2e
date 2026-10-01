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
import { formatNode, prepareObservation, type AgentObservation, type RedactedNode } from '../agent/observation.ts';
import type { ResolvedConfig } from '../config/resolve.ts';
import type { OperationContext, TargetSession } from '../engine/surface.ts';
import { truncateUtf8, type E2EError } from '../internal/errors.ts';
import { isTypoOf } from '../internal/suggest.ts';
import type { ArtifactSink } from './fixtures.ts';
import type { FailureEvidence } from './records.ts';
import type { SessionSecrecy } from './secrecy.ts';

/** The whole capture, observation and screenshot together, gets this long. */
const EVIDENCE_TIMEOUT_MS = 5_000;
/** Screen lines a locator failure lists as its nearest nodes, and the bytes each keeps; the wire schema caps both. */
const MAX_CANDIDATES = 5;
const MAX_CANDIDATE_BYTES = 1024;
/** Longer tokens are ids or hashes, not words a locator names; comparing them would cost an edit-distance matrix each. */
const MAX_NEAR_WORD_LENGTH = 24;
const MAX_URL_BYTES = 2048;
/** Report-relative path of the screen text under the attempt's artifact directory. */
const SCREEN_FILE = 'failure/screen.txt';

export interface FailureEvidenceOptions {
  readonly session: TargetSession;
  readonly error: E2EError;
  readonly secrecy: SessionSecrecy;
  readonly config: ResolvedConfig;
  /** The app base URL's origin, whose link targets the screen lists as paths. */
  readonly appOrigin: string | undefined;
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
  const timeout = AbortSignal.timeout(EVIDENCE_TIMEOUT_MS);
  const signal = AbortSignal.any([options.interrupt, timeout]);
  if (signal.aborted) return finish(evidence);
  const operation = options.operation(signal, EVIDENCE_TIMEOUT_MS);
  const { redact, redactCut } = options.secrecy.ledger;

  let observation: AgentObservation | undefined;
  try {
    const raw = await options.session.observe(operation);
    observation = prepareObservation(raw, {
      redact,
      redactCut,
      maxBytes: options.config.limits.maxObservationBytes,
      appOrigin: options.appOrigin,
    });
  } catch {
    // The session may be gone with the failure (a crashed page, a closed app).
  }

  // The location rides on the observation when the platform has one.
  if (observation?.location !== undefined) evidence.url = truncateUtf8(observation.location, MAX_URL_BYTES);

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
    const candidates = locatorCandidates(options.error, observation, redact, options.appOrigin);
    if (candidates.length > 0) evidence.candidates = candidates;
  }

  // Pixels only when no secret has been filled: rectangle masking cannot
  // prove a tainted viewport redacted.
  if (!options.secrecy.exposure.withholdsPixels && !signal.aborted) {
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
    `viewport: ${observation.viewport.width}x${observation.viewport.height}`,
    observation.kind === 'semantic'
      ? `nodes: ${observation.nodes.size}${observation.truncated ? ' (listing truncated)' : ''}`
      : 'nodes: unavailable',
  ];
  return `${header.join('\n')}\n\n${observation.text}\n`;
}

/**
 * For a locator that matched nothing or too much, the nodes on screen closest
 * to what it asked for: the same role, a name sharing words (or near misses
 * of them) with the one requested, or the test id. Rendered as the screen
 * lists them, so the reader can rewrite the locator from what is there.
 */
function locatorCandidates(
  error: E2EError,
  observation: AgentObservation,
  redact: (text: string) => string,
  appOrigin: string | undefined,
): string[] {
  if (observation.kind === 'pixels') return [];
  if (error.code !== 'LOCATOR_NOT_FOUND' && error.code !== 'LOCATOR_AMBIGUOUS') return [];
  const details = error.details ?? {};
  // The nodes are redacted; the query is compared in the same form, so a secret test id still finds its node.
  const [role, testId, name] = [details.role, details.testId, details.name].map((value) => (value === undefined ? undefined : redact(value)));
  const words = tokens(name ?? '');
  if (role === undefined && testId === undefined && words.length === 0) return [];

  const scored: { score: number; node: RedactedNode }[] = [];
  for (const node of observation.nodes.values()) {
    const roleMatched = role !== undefined && node.role?.toLowerCase() === role.toLowerCase();
    const testIdMatched = testId !== undefined && node.testId !== undefined && (node.testId === testId || node.testId.includes(testId) || testId.includes(node.testId));
    const own = new Set(tokens(`${node.name ?? ''} ${node.text ?? ''} ${node.attributes?.['placeholder'] ?? ''}`));
    const exact = words.filter((word) => own.has(word)).length;
    const roleEligible = role === undefined || roleMatched;
    const near = roleEligible ? words.filter((word) => !own.has(word) && [...own].some((other) => nearWord(word, other))).length : 0;
    const shared = exact + near;
    // A request that named the node is answered by nodes of the asked role
    // (any role, when none was asked) sharing a word, or a near miss of one,
    // with the name; a role alone is enough only when no name was asked for;
    // a test id stands on its own either way.
    const nameMatched = shared > 0 && roleEligible;
    if (!(nameMatched || testIdMatched || (roleMatched && words.length === 0))) continue;
    const score =
      (roleMatched ? 3 : 0) +
      (testIdMatched ? (node.testId === testId ? 6 : 3) : 0) +
      exact * 2 +
      near +
      (words.length > 0 && exact === words.length ? 2 : 0);
    scored.push({ score, node });
  }
  return scored
    .toSorted((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES)
    .map(({ node }) => truncateUtf8(formatNode(node, 0, appOrigin), MAX_CANDIDATE_BYTES));
}

/**
 * Whether a word on screen is a near miss for one asked for: a typo or an
 * inflection of it (`Notes` for `Note`, `Submit` for `Sumbit`), by the budget
 * "did you mean" uses. Words under four letters or over
 * `MAX_NEAR_WORD_LENGTH` only match exactly, so `and` never answers `add`.
 */
function nearWord(asked: string, seen: string): boolean {
  const eligible = (word: string) => word.length >= 4 && word.length <= MAX_NEAR_WORD_LENGTH;
  return eligible(asked) && eligible(seen) && isTypoOf(asked, seen);
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);
}
