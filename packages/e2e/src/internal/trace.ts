/**
 * Live agent tracing for iterating on agentic tests: `E2E_DEBUG=agent` streams
 * every invocation phase, model selection, and locate-candidate outcome to
 * stderr as it happens, from whichever process runs the attempt. This is a
 * debugging aid, not telemetry: the report stays the canonical record.
 */

import { sanitizeText, truncateUtf8 } from './errors.ts';

/**
 * Parsed on first use, not at import, so tests and embedders can set
 * `E2E_DEBUG` after this module loads but before the first trace call.
 */
let cachedFlags: ReadonlySet<string> | undefined;

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
  return flags().has('agent') || flags().has('all');
}

/** `E2E_DEBUG=observations` additionally dumps every observation the model sees. */
function observationTraceEnabled(): boolean {
  return flags().has('observations') || flags().has('all');
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
