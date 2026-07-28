/**
 * Live agent tracing for iterating on agentic tests: `E2E_DEBUG=agent` streams
 * every invocation phase, model selection, and locate-candidate outcome to
 * stderr as it happens, from whichever process runs the attempt. This is a
 * debugging aid, not telemetry: the report stays the canonical record.
 */

import { sanitizeText, truncateUtf8 } from './errors.ts';

const FLAGS = new Set(
  (process.env['E2E_DEBUG'] ?? '')
    .split(',')
    .map((flag) => flag.trim())
    .filter((flag) => flag !== ''),
);

export const agentTraceEnabled = FLAGS.has('agent') || FLAGS.has('all');

/** `E2E_DEBUG=observations` additionally dumps every observation the model sees. */
export const observationTraceEnabled = FLAGS.has('observations') || FLAGS.has('all');

/** Writes one bounded, sanitized trace line when agent tracing is on. */
export function agentTrace(message: string): void {
  if (!agentTraceEnabled) return;
  process.stderr.write(`[e2e agent] ${truncateUtf8(sanitizeText(message), 2_000)}\n`);
}

/**
 * Dumps one full observation as the model will receive it. The text is
 * already redacted and size-bounded by the observation pipeline, so the dump
 * needs no further truncation to stay safe.
 */
export function observationTrace(header: string, text: string): void {
  if (!observationTraceEnabled) return;
  process.stderr.write(`[e2e observation] ${header}\n${text}\n[e2e observation] end\n`);
}
