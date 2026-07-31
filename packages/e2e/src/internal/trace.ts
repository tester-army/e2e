/**
 * Live agent tracing for iterating on agentic tests: `--debug`, or
 * `E2E_DEBUG=agent`, streams every invocation phase, planning decision, and
 * locate-candidate outcome to stderr as it happens, from whichever process runs
 * the attempt. This is a debugging aid, not telemetry: the report stays the
 * canonical record.
 */

import { sanitizeText, truncateUtf8 } from './errors.ts';

/**
 * Parsed on first use, not at import, so tests and embedders can set
 * `E2E_DEBUG` after this module loads but before the first trace call.
 */
let cachedFlags: ReadonlySet<string> | undefined;

/**
 * Flags turned on in process rather than through the environment, for `--debug`.
 * Kept separate from the parsed environment so enabling one never discards what
 * `E2E_DEBUG` asked for.
 */
const forced = new Set<string>();

/** Turns on trace flags for this process. Workers receive them through env. */
export function enableTraceFlags(names: readonly string[]): void {
  for (const name of names) forced.add(name);
}

function flags(): ReadonlySet<string> {
  cachedFlags ??= new Set(
    (process.env['E2E_DEBUG'] ?? '')
      .split(',')
      .map((flag) => flag.trim())
      .filter((flag) => flag !== ''),
  );
  return cachedFlags;
}

function agentTraceEnabled(): boolean {
  return enabledFlag('agent');
}

function enabledFlag(name: string): boolean {
  return forced.has(name) || forced.has('all') || flags().has(name) || flags().has('all');
}

/** `E2E_DEBUG=observations` additionally dumps every observation the model sees. */
function observationTraceEnabled(): boolean {
  return enabledFlag('observations');
}

/**
 * Writes one per-phase timing line, for `E2E_DEBUG=phases`.
 *
 * Separate from decision tracing because the two answer different questions and
 * one drowns the other: every planning round emits an observation, a model call,
 * and a driver dispatch, so seven lines of timing surrounded the one line saying
 * what the agent actually decided. `--debug` turns on decisions; timings are
 * opt-in on top.
 */
export function phaseTrace(message: () => string): void {
  if (!enabledFlag('phases')) return;
  process.stderr.write(`[e2e phase] ${truncateUtf8(sanitizeText(message()), 2_000)}\n`);
}

/**
 * Writes one bounded, sanitized trace line when agent tracing is on. Takes a
 * thunk so call sites in polling loops pay nothing while tracing is off.
 */
export function agentTrace(message: () => string): void {
  if (!agentTraceEnabled()) return;
  process.stderr.write(`[e2e agent] ${truncateUtf8(sanitizeText(message()), 2_000)}\n`);
}

/**
 * Dumps one full observation as the model will receive it. The text is
 * already redacted and size-bounded by the observation pipeline, so the dump
 * needs no further truncation to stay safe.
 */
export function observationTrace(header: () => string, text: string): void {
  if (!observationTraceEnabled()) return;
  process.stderr.write(`[e2e observation] ${header()}\n${text}\n[e2e observation] end\n`);
}
