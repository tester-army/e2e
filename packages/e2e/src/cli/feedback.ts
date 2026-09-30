/**
 * `e2e feedback`: one report about e2e itself, from a person or the coding
 * agent in their shell, sent to the e2e team as a single PostHog event.
 *
 * Feedback is not telemetry: it leaves the machine only when asked for, so a
 * saved `e2e telemetry disable` does not stop it, and it carries the words
 * someone typed. `E2E_TELEMETRY_DISABLED` and `DO_NOT_TRACK` do stop it: an
 * operator sets those on a CI job or a fleet to send nothing at all, and an
 * agent there may run the command without a person asking. What it attaches on its own is the anonymous machine facts every
 * telemetry event carries. Before anything is sent, the value of every
 * secret-named environment variable and every well-known token shape is
 * rewritten, so an error message pasted whole does not carry a key along.
 * `--dry-run` prints the event and sends nothing.
 */

import { uuidv7, timestamp } from '../internal/ids.ts';
import { createRedactor } from '../internal/redact.ts';
import { MIN_SECRET_LENGTH, secretLength } from '../config/secrets.ts';
import { collectEnvironment } from '../telemetry/environment.ts';
import { postBatch, type PostHogEvent } from '../telemetry/posthog.ts';
import type { Telemetry, TelemetryDisabledBy } from '../telemetry/telemetry.ts';

export const FEEDBACK_TYPES = ['bug', 'docs', 'feature', 'other'] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

/** The most characters each text field may hold. */
export const FEEDBACK_LIMITS = {
  message: 2000,
  task: 4000,
  expected: 4000,
  actual: 4000,
  approach: 4000,
  command: 200,
  agent: 200,
} as const;

export type FeedbackField = keyof typeof FEEDBACK_LIMITS;

export interface FeedbackReport extends Partial<Record<FeedbackField, string>> {
  readonly type: FeedbackType;
  readonly message: string;
}

export interface FeedbackOptions {
  readonly version: string;
  readonly telemetry: Telemetry;
  /** Print the event instead of sending it. */
  readonly dryRun?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly fetch?: typeof fetch;
}

const EVENT = 'e2e_feedback';
/** A person waits on this request, so it gets longer than the telemetry flush, but never hangs. */
const SEND_TIMEOUT_MS = 10_000;
const ISSUES_URL = 'https://github.com/tester-army/e2e/issues';

/** Environment variable names whose values are treated as secrets. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASS|_PWD|CREDENTIAL|AUTH|COOKIE|PRIVATE/i;

/** Token shapes rewritten wherever they appear, whether or not a variable holds them. */
const TOKEN_PATTERNS: readonly (readonly [pattern: RegExp, replacement: string])[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<redacted>'],
  // A credential holds a digit; the requirement spares prose such as "Basic authentication".
  [/\b(Bearer|Basic)\s+(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{12,}=*/g, '$1 <redacted>'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1<redacted>@'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '<redacted>'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '<redacted>'],
  [/\bvck_[A-Za-z0-9]{20,}/g, '<redacted>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '<redacted>'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '<redacted>'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '<redacted>'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<redacted>'],
];

/**
 * A redactor for this environment: each secret-named variable's value
 * becomes `<secret:NAME>`, then each token shape becomes `<redacted>`.
 */
function feedbackRedactor(env: NodeJS.ProcessEnv): (text: string) => string {
  const secrets = Object.entries(env).flatMap(([name, value]) =>
    value !== undefined && SECRET_NAME.test(name) && secretLength(value) >= MIN_SECRET_LENGTH ? [[name, value] as const] : [],
  );
  const redactSecrets = createRedactor(secrets);
  return (text) => TOKEN_PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), redactSecrets(text));
}

/** The event as PostHog receives it: the report redacted, the machine facts, and no person profile or location. */
function feedbackEvent(report: FeedbackReport, options: FeedbackOptions, env: NodeJS.ProcessEnv): PostHogEvent {
  const id = uuidv7();
  const redact = feedbackRedactor(env);
  const fields = Object.fromEntries(
    Object.keys(FEEDBACK_LIMITS).map((field) => {
      const value = report[field as FeedbackField];
      return [field, value === undefined ? null : redact(value)];
    }),
  );
  return {
    event: EVENT,
    uuid: id,
    timestamp: timestamp(),
    properties: {
      ...collectEnvironment({ env, cwd: options.cwd ?? process.cwd(), version: options.version }),
      type: report.type,
      ...fields,
      // The telemetry id when telemetry is on, so a report can be read beside the sessions around it.
      distinct_id: options.telemetry.distinctId ?? `feedback:${id}`,
      $lib: 'e2e',
      $lib_version: options.version,
      $process_person_profile: false,
      $geoip_disable: true,
    },
  };
}

/** The variables that switch feedback off along with telemetry. */
const BLOCKING: ReadonlySet<TelemetryDisabledBy> = new Set(['E2E_TELEMETRY_DISABLED', 'DO_NOT_TRACK']);

/**
 * Sends the report, or prints it under `--dry-run` or `E2E_TELEMETRY_DEBUG`.
 * Exit 0 when PostHog accepted it, 2 when an opt-out variable forbids
 * sending, 3 when it could not be delivered.
 */
export async function feedback(report: FeedbackReport, options: FeedbackOptions): Promise<number> {
  const env = options.env ?? process.env;
  const event = feedbackEvent(report, options, env);
  if (options.dryRun === true || options.telemetry.debug) {
    process.stdout.write(`${JSON.stringify(event, null, 2)}\n`);
    return 0;
  }
  const disabledBy = options.telemetry.disabledBy;
  if (disabledBy !== undefined && BLOCKING.has(disabledBy)) {
    process.stderr.write(`feedback not sent: ${disabledBy} is set, which switches off everything e2e sends. Unset it for this command to send the report.\n`);
    return 2;
  }
  const sent = await postBatch([event], { signal: AbortSignal.timeout(SEND_TIMEOUT_MS), fetch: options.fetch ?? fetch });
  if (!sent) {
    process.stderr.write(`feedback could not be delivered; nothing was sent. Try again, or open an issue: ${ISSUES_URL}\n`);
    return 3;
  }
  process.stdout.write(`Feedback sent to the e2e team, thank you. Reference: ${event.uuid}\n`);
  return 0;
}
