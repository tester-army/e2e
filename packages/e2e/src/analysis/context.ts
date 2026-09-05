/**
 * Assembles the evidence of one failed pair into the `FailureContext` an
 * analyzer receives. Everything here is read from records the worker already
 * produced and files it already wrote; nothing touches a live session, so it
 * can run in the runner process while other tests are still executing.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactRecord, AttemptRecord, ResultRecord } from '../run/records.ts';
import type { StepRecord } from '../run/steps.ts';
import type { SerializedError } from '../internal/errors.ts';
import { sanitizeText, truncateUtf8 } from '../internal/errors.ts';
import { userFrame } from '../report/code-frame.ts';
import type { FailureAttempt, FailureContext, FailureStep } from '../types.ts';

/** The observation snapshot is bounded for the model even when the artifact is not. */
const MAX_OBSERVATION_BYTES = 48 * 1024;
const MAX_MESSAGE_BYTES = 4096;
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

/** True for a result the runner analyzes: a test-category failure or timeout of an ordinary pair. */
export function isAnalyzable(result: ResultRecord): result is ResultRecord & {
  status: 'failed' | 'timed-out';
  attempts: [AttemptRecord, ...AttemptRecord[]];
} {
  if (result.status !== 'failed' && result.status !== 'timed-out') return false;
  // Serial members' attempts live on the group record; analyzing groups is a
  // later step, so a member (whose own record carries no attempts) is skipped.
  if (result.serialGroupId !== undefined) return false;
  const final = result.attempts.at(-1);
  return final?.error !== undefined && final.error.category === 'test';
}

/** Builds the analyzer's view of one analyzable result. */
export async function buildFailureContext(
  result: ResultRecord & { status: 'failed' | 'timed-out' },
  options: BuildFailureContextOptions,
): Promise<FailureContext> {
  const final = result.attempts.at(-1);
  if (final?.error === undefined) throw new Error('buildFailureContext requires a failed final attempt');
  const error = toFailureError(final.error);
  const evidence = final.evidence;
  const artifactById = new Map(final.artifacts.map((artifact) => [artifact.id, artifact] as const));

  const context: FailureContext = {
    test: { id: result.test.id, titlePath: result.test.titlePath, file: result.test.file },
    target: { name: result.target.name, platform: result.target.platform },
    status: result.status,
    attempts: result.attempts.map(toFailureAttempt),
    error,
  };

  const source = options.source ? await readSource(final.error, options.projectRoot) : undefined;
  const observation =
    evidence?.observation === undefined
      ? undefined
      : await readObservation(artifactById.get(evidence.observation), options.artifactsRoot);
  const screenshot =
    evidence?.screenshot === undefined
      ? undefined
      : describeScreenshot(artifactById.get(evidence.screenshot), options, evidence.pixelsTainted);

  return {
    ...context,
    ...(source === undefined ? {} : { source }),
    ...(observation === undefined ? {} : { observation }),
    ...(evidence?.url === undefined ? {} : { url: evidence.url }),
    ...(screenshot === undefined ? {} : { screenshot }),
  };
}

function toFailureError(error: SerializedError): NonNullable<FailureAttempt['error']> {
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
 * The snapshot file opens with a header block (url, viewport, revision) for a
 * person reading it off disk; the context carries those facts as fields, so
 * the analyzer sees the tree alone.
 */
function stripSnapshotHeader(text: string): string {
  if (!text.startsWith('# e2e failure observation')) return text.trim();
  const blank = text.indexOf('\n\n');
  return (blank === -1 ? text : text.slice(blank + 2)).trim();
}

function describeScreenshot(
  artifact: ArtifactRecord | undefined,
  options: BuildFailureContextOptions,
  pixelsTainted: boolean,
): FailureContext['screenshot'] | undefined {
  if (artifact?.path === undefined) return undefined;
  return {
    path: path.join(options.artifactsRoot, artifact.path),
    mediaType: artifact.mediaType,
    // Tainted pixels never become model input, whatever the config asks for.
    modelInput: options.vision && !pixelsTainted && artifact.redaction === 'complete',
  };
}
