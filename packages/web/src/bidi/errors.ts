/** Error classification for the BiDi driver, and the one place it drops an error on purpose. */

import { EngineError, TestError } from 'e2e/engine';
import { isClassified, message } from '../support.ts';
import { BidiError } from './connection.ts';
import { ScriptError } from './script.ts';

/** BiDi codes and browser words that mean the element, frame, or document is gone. */
const STALE_PATTERN = /no such node|no such frame|stale element|no such element|detached|execution context was destroyed|cannot find context|context with specified id|document unloaded|target navigated or closed/i;

/** What a failure says about itself, the BiDi method name left out: a navigation command's failure is no stale node. */
function ownWords(cause: unknown): string | undefined {
  if (cause instanceof BidiError) return `${cause.error} ${cause.detail}`;
  if (cause instanceof ScriptError) return cause.message;
  return undefined;
}

/** Maps a failure onto the engine error contract: classified errors pass, a gone node or document is retryable `NODE_STALE`. */
export function classify(cause: unknown, label: string): Error {
  if (isClassified(cause)) return cause;
  const text = message(cause);
  if (STALE_PATTERN.test(ownWords(cause) ?? '')) {
    return new EngineError('NODE_STALE', `${label}: ${text}`, { retryable: true, cause });
  }
  return new EngineError('ENGINE_FAILURE', `${label}: ${text}`, { retryable: false, cause });
}

/** Codes a failure after input went out can carry while the input may have reached the app. */
const UNCERTAIN = new Set(['OPERATION_TIMEOUT', 'NODE_STALE', 'ENGINE_FAILURE', 'CANCELLED']);

/**
 * A classified failure of an input operation: once its input was dispatched,
 * a timeout, a gone node, or a fault leaves it uncertain whether the app
 * took it (`ACTION_MAY_HAVE_COMMITTED`, never retried blindly). A sensitive
 * fill's value is scrubbed from the message and its cause dropped, so the
 * plaintext never leaves the engine.
 */
export function afterDispatch(error: Error, label: string, dispatched: boolean, sensitive?: string): Error {
  const code = error instanceof EngineError || error instanceof TestError ? error.code : undefined;
  const scrub = (text: string): string => (sensitive === undefined || sensitive === '' ? text : text.replaceAll(sensitive, '[redacted]'));
  if (dispatched && code !== undefined && UNCERTAIN.has(code)) {
    return new EngineError('ACTION_MAY_HAVE_COMMITTED', `${label} failed after its input was dispatched: ${scrub(error.message)}`, {
      retryable: false,
      ...(sensitive === undefined ? { cause: error } : {}),
    });
  }
  if (sensitive === undefined || error.message.indexOf(sensitive) === -1) return sensitive === undefined ? error : withoutCause(error);
  return new EngineError(error instanceof EngineError ? error.code : 'ENGINE_FAILURE', scrub(error.message), { retryable: false });
}

/** A sensitive fill's error without the raw cause, whose stack a report would print. */
function withoutCause(error: Error): Error {
  if (!(error instanceof EngineError) || error.cause === undefined) return error;
  return new EngineError(error.code, error.message, { retryable: error.retryable });
}

/** Whether `cause` classifies as a gone node or document. */
export function isStale(cause: unknown): boolean {
  const error = classify(cause, '');
  return error instanceof EngineError && error.code === 'NODE_STALE';
}

/** `work`'s result, or `fallback` when the node or document it read is gone; any other failure propagates. */
export async function unlessStale<T>(work: Promise<T>, fallback: T): Promise<T> {
  try {
    return await work;
  } catch (cause) {
    if (isStale(cause)) return fallback;
    throw cause;
  }
}

/**
 * Runs cleanup whose failure changes nothing for the caller: releasing a
 * subscription, intercept, collector, or preload script that the browser
 * drops with its context or session anyway. Never for work whose outcome
 * the caller reads.
 */
export async function releaseQuietly(work: Promise<unknown> | undefined): Promise<void> {
  try {
    await work;
  } catch {
    return;
  }
}
