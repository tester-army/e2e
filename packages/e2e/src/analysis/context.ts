/**
 * Assembles the evidence of one failed test into the `FailureContext` an
 * analyzer receives. Everything here is read from records the worker already
 * produced and files it already wrote; nothing touches a live session, so it
 * can run in the runner process while other tests are still executing.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactRecord, AttemptRecord, ResultRecord } from '../run/records.ts';
import type { StepEvent, StepRecord } from '../run/steps.ts';
import type { SerializedError } from '../internal/errors.ts';
import { sanitizeText, truncateUtf8 } from '../internal/errors.ts';
import { userFrame } from '../report/code-frame.ts';
import { SCREEN_FILE_HEADER } from '../run/failure-evidence.ts';
import type { FailureArtifact, FailureAttempt, FailureContext, FailureStep } from '../types.ts';

/** The observation snapshot is bounded for the model even when the artifact is not. */
const MAX_OBSERVATION_BYTES = 48 * 1024;
const MAX_MESSAGE_BYTES = 4096;
/** Event lines kept per step: the first and the last, the failure being at the end. */
const MAX_EVENTS_PER_STEP = 24;
/** Lines of test source on each side of the failing line. */
const SOURCE_CONTEXT_LINES = 4;

export interface BuildFailureContextOptions {
  readonly artifactsRoot: string;
  readonly projectRoot: string;
  /** Whether the failing test line and its neighbors join the context. */
  readonly source: boolean;
  /** Whether a non-tainted failure screenshot may become model input. */
  readonly vision: boolean;
}

export type AnalyzableResult = ResultRecord & { status: 'failed' | 'timed-out' | 'flaky' };

/**
 * True for a result the runner analyzes: a test-category failure or timeout,
 * or a flaky pass whose earlier attempt failed that way. Serial members'
 * attempts live on the group record, so a member is skipped.
 */
export function isAnalyzable(result: ResultRecord): result is AnalyzableResult {
  if (result.status !== 'failed' && result.status !== 'timed-out' && result.status !== 'flaky') return false;
  if (result.serialGroupId !== undefined) return false;
  const attempt = analyzedAttempt(result);
  return attempt?.error !== undefined && attempt.error.category === 'test';
}

/** The attempt the analysis is about: the last one that failed. */
export function analyzedAttempt(result: ResultRecord): AttemptRecord | undefined {
  return result.attempts.findLast((attempt) => attempt.error !== undefined);
}

/** Builds the analyzer's view of one analyzable result, before any evidence provider ran. */
export async function buildFailureContext(
  result: AnalyzableResult,
  options: BuildFailureContextOptions,
): Promise<FailureContext> {
  const attempt = analyzedAttempt(result);
  if (attempt?.error === undefined) throw new Error('buildFailureContext requires a failed attempt');
  const failure = attempt.failure;
  const artifactById = new Map(attempt.artifacts.map((artifact) => [artifact.id, artifact] as const));

  const source = options.source ? await readSource(attempt.error, options.projectRoot) : undefined;
  const observation =
    failure?.screen === undefined
      ? undefined
      : await readObservation(artifactById.get(failure.screen), options.artifactsRoot);
  const screenshot =
    failure?.screenshot === undefined ? undefined : describeScreenshot(artifactById.get(failure.screenshot), options);

  return {
    test: { id: result.test.id, titlePath: result.test.titlePath, file: result.test.file },
    target: { name: result.target.name, platform: result.target.platform },
    agent: result.agent,
    status: result.status,
    attempts: result.attempts.map(toFailureAttempt),
    error: toFailureError(attempt.error),
    ...(source === undefined ? {} : { source }),
    ...(observation === undefined ? {} : { observation }),
    ...(failure?.url === undefined ? {} : { url: failure.url }),
    ...(screenshot === undefined ? {} : { screenshot }),
    artifacts: attempt.artifacts.flatMap((artifact) => toFailureArtifact(artifact, options.artifactsRoot)),
    evidence: [],
  };
}

function toFailureError(error: SerializedError): FailureContext['error'] {
  return {
    category: error.category,
    code: error.code,
    message: truncateUtf8(sanitizeText(error.message), MAX_MESSAGE_BYTES),
    ...(error.phase === undefined ? {} : { phase: error.phase }),
  };
}

function toFailureAttempt(attempt: AttemptRecord): FailureAttempt {
  return {
    index: attempt.index,
    status: attempt.status,
    ...(attempt.error === undefined ? {} : { error: toFailureError(attempt.error) }),
    steps: attempt.steps.map(toFailureStep),
  };
}

function toFailureStep(step: StepRecord): FailureStep {
  return {
    index: step.index,
    kind: step.kind,
    api: step.api,
    label: truncateUtf8(sanitizeText(step.label), MAX_MESSAGE_BYTES),
    status: step.status,
    durationMs: step.durationMs,
    ...(step.explanation === undefined
      ? {}
      : { explanation: truncateUtf8(sanitizeText(step.explanation), MAX_MESSAGE_BYTES) }),
    ...(step.cache === undefined
      ? {}
      : { cache: { mode: step.cache.mode, ...(step.cache.reason === undefined ? {} : { reason: step.cache.reason }) } }),
    ...(step.metrics === undefined
      ? {}
      : { metrics: { modelCalls: step.metrics.modelCalls, actionSteps: step.metrics.actionSteps } }),
    events: eventLines(step.events),
    ...(step.error === undefined
      ? {}
      : {
          error: {
            code: step.error.code,
            message: truncateUtf8(sanitizeText(step.error.message), MAX_MESSAGE_BYTES),
          },
        }),
  };
}

/**
 * The step's events as one line each, the way the live reporter shows them.
 * Polls and observations carry no story of their own and are left out; an
 * action's `detail`, a denied policy, and a failed engine call are what an
 * analyzer reads the flow from. Long steps keep their first and last lines.
 */
function eventLines(events: readonly StepEvent[]): string[] {
  const lines = events.flatMap((event) => {
    if (event.kind === 'poll' || event.kind === 'observation') return [];
    const parts: string[] = [event.kind];
    if (event.name !== undefined) parts.push(event.name);
    if (event.detail !== undefined) parts.push(truncateUtf8(sanitizeText(event.detail), 300));
    if (event.decision !== undefined) parts.push(event.decision);
    if (event.status !== 'passed') parts.push(event.status);
    if (event.code !== undefined) parts.push(event.code);
    return [parts.join(' ')];
  });
  if (lines.length <= MAX_EVENTS_PER_STEP) return lines;
  const head = Math.ceil(MAX_EVENTS_PER_STEP / 2);
  const tail = MAX_EVENTS_PER_STEP - head;
  return [...lines.slice(0, head), `… ${lines.length - MAX_EVENTS_PER_STEP} more`, ...lines.slice(-tail)];
}

function toFailureArtifact(artifact: ArtifactRecord, artifactsRoot: string): FailureArtifact[] {
  if (artifact.path === undefined) return [];
  return [
    {
      id: artifact.id,
      kind: artifact.kind,
      mediaType: artifact.mediaType,
      path: path.join(artifactsRoot, artifact.path),
      redaction: artifact.redaction,
    },
  ];
}

/**
 * The user's failing line with context, from the stack the record still
 * carries (the report drops stacks; the in-memory record does not). Plain
 * text, numbered, with the failing line marked, so a model reads it the way
 * the list reporter's code frame reads to a person.
 */
async function readSource(
  error: SerializedError,
  projectRoot: string,
): Promise<FailureContext['source'] | undefined> {
  const frame = userFrame(error.stack, projectRoot);
  if (frame === undefined) return undefined;
  let text: string;
  try {
    text = await readFile(frame.file, 'utf8');
  } catch {
    return undefined;
  }
  const lines = text.split('\n');
  const index = frame.line - 1;
  if (index < 0 || index >= lines.length) return undefined;
  // A frame from transpiled output without a source map lands on a column the
  // original line does not have. Showing the wrong line as the failing one
  // would mislead the analyzer, so no source beats a fabricated location.
  if (frame.column > (lines[index]?.length ?? 0) + 1) return undefined;
  const start = Math.max(0, index - SOURCE_CONTEXT_LINES);
  const end = Math.min(lines.length - 1, index + SOURCE_CONTEXT_LINES);
  const width = String(end + 1).length;
  const rows: string[] = [];
  for (let i = start; i <= end; i += 1) {
    const marker = i === index ? '>' : ' ';
    rows.push(`${marker} ${String(i + 1).padStart(width)} | ${truncateUtf8(sanitizeText(lines[i] ?? ''), 512)}`);
  }
  return {
    file: path.relative(projectRoot, frame.file).split(path.sep).join('/'),
    line: frame.line,
    column: frame.column,
    lines: rows,
  };
}

async function readObservation(
  artifact: ArtifactRecord | undefined,
  artifactsRoot: string,
): Promise<string | undefined> {
  if (artifact?.path === undefined) return undefined;
  try {
    const text = stripSnapshotHeader(await readFile(path.join(artifactsRoot, artifact.path), 'utf8'));
    const bounded = truncateUtf8(text, MAX_OBSERVATION_BYTES);
    return bounded === text ? text : `${bounded}\n[observation truncated for analysis]`;
  } catch {
    return undefined;
  }
}

/**
 * The screen file opens with a header block (url, revision, viewport, node
 * count) for a person reading it off disk; the context carries those facts as
 * fields, so the analyzer sees the tree alone.
 */
function stripSnapshotHeader(text: string): string {
  if (!text.startsWith(SCREEN_FILE_HEADER)) return text.trim();
  const blank = text.indexOf('\n\n');
  return (blank === -1 ? text : text.slice(blank + 2)).trim();
}

function describeScreenshot(
  artifact: ArtifactRecord | undefined,
  options: BuildFailureContextOptions,
): FailureContext['screenshot'] | undefined {
  if (artifact?.path === undefined) return undefined;
  return {
    path: path.join(options.artifactsRoot, artifact.path),
    mediaType: artifact.mediaType,
    // The capture takes no screenshot once a secret was filled, so a
    // screenshot that exists is untainted; the masking still has to be complete.
    modelInput: options.vision && artifact.redaction === 'complete',
  };
}
