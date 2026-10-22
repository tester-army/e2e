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
 *
 * A report from a version older than the latest release is refused, since the
 * problem may already be fixed. A bug without a deterministic reproduction
 * goes to GitHub instead, where the team can ask the reporter for one: the
 * command prints a prefilled issue link and sends nothing.
 */

import { uuidv7, timestamp } from '../internal/ids.ts';
import { createRedactor } from '../internal/redact.ts';
import { latestRelease, olderThan } from '../internal/release.ts';
import { MIN_SECRET_LENGTH, secretLength } from '../config/secrets.ts';
import { collectEnvironment, type TelemetryEnvironment } from '../telemetry/environment.ts';
import { postBatch, type PostHogEvent } from '../telemetry/posthog.ts';
import type { Telemetry, TelemetryDisabledBy } from '../telemetry/telemetry.ts';

export const FEEDBACK_TYPES = ['bug', 'docs', 'feature', 'other'] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

/** The most characters each text field may hold. */
export const FEEDBACK_LIMITS = {
  message: 2000,
  task: 1500,
  expected: 1500,
  actual: 1500,
  approach: 1500,
  repro: 1500,
  command: 200,
  agent: 200,
} as const;

export type FeedbackField = keyof typeof FEEDBACK_LIMITS;

/** The most characters an error code may hold. */
export const ERROR_CODE_LIMIT = 64;

export interface FeedbackReport extends Partial<Record<FeedbackField, string>> {
  readonly type: FeedbackType;
  readonly message: string;
  /** The e2e error code involved, such as `LOCATOR_AMBIGUOUS`. */
  readonly errorCode?: string;
}

export interface FeedbackOptions {
  readonly version: string;
  readonly telemetry: Telemetry;
  /** Print the event instead of sending it. */
  readonly dryRun?: boolean;
  /** Send even when a newer e2e release exists. */
  readonly allowOutdated?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly fetch?: typeof fetch;
}

const EVENT = 'e2e_feedback';
/** A person waits on this request, so it gets longer than the telemetry flush, but never hangs. */
const SEND_TIMEOUT_MS = 10_000;
const ISSUES_URL = 'https://github.com/tester-army/e2e/issues';
const NEW_BUG_URL = `${ISSUES_URL}/new`;
/** The registry check never holds the report up for long; a slow or failed one is skipped. */
const LATEST_TIMEOUT_MS = 3000;
/** GitHub rejects longer new-issue URLs. */
const MAX_ISSUE_URL_LENGTH = 8000;

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
function feedbackEvent(report: FeedbackReport, options: FeedbackOptions, environment: TelemetryEnvironment, redact: (text: string) => string): PostHogEvent {
  const id = uuidv7();
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
      ...environment,
      type: report.type,
      ...fields,
      error_code: report.errorCode === undefined ? null : redact(report.errorCode),
      // The telemetry id when telemetry is on, so a report can be read beside the sessions around it.
      distinct_id: options.telemetry.distinctId ?? `feedback:${id}`,
      $lib: 'e2e',
      $lib_version: options.version,
      $process_person_profile: false,
      $geoip_disable: true,
    },
  };
}

/**
 * A prefilled link to the repository's bug form. The report fills "What
 * happened" and "Versions"; the reproduction is left for the reporter.
 */
function bugIssueUrl(report: FeedbackReport, environment: TelemetryEnvironment, redact: (text: string) => string): string {
  const lines = [
    report.message,
    '',
    ...([
      ['Task', report.task],
      ['Expected', report.expected],
      ['Actual', report.actual],
      ['Error code', report.errorCode],
      ['Command', report.command],
      ['Tried', report.approach],
      ['Agent', report.agent],
    ] as const).flatMap(([label, value]) => (value === undefined ? [] : [`${label}: ${value}`])),
  ];
  const versions = `e2e ${environment.e2e_version}, node ${environment.node_version}, ${environment.os} ${environment.os_release}`;
  const url = (what: string): string => {
    const query = new URLSearchParams({ template: 'bug_report.yml', labels: 'bug', title: redact(report.message).slice(0, 120), what, versions });
    return `${NEW_BUG_URL}?${query.toString()}`;
  };
  let what = redact(lines.join('\n').trim());
  while (url(what).length > MAX_ISSUE_URL_LENGTH) what = `${[...what].slice(0, Math.floor([...what].length * 0.9)).join('')}…`;
  return url(what);
}

/** The variables that switch feedback off along with telemetry. */
const BLOCKING: ReadonlySet<TelemetryDisabledBy> = new Set(['E2E_TELEMETRY_DISABLED', 'DO_NOT_TRACK']);

/**
 * Sends the report, or prints it under `--dry-run` or `E2E_TELEMETRY_DEBUG`.
 * Exit 0 when PostHog accepted it or a bug without `--repro` got its GitHub
 * link, 2 when the installed e2e is outdated or an opt-out variable forbids
 * sending, 3 when PostHog did not confirm it: a timeout can follow delivery,
 * so the message names the reference and never claims nothing arrived.
 */
export async function feedback(report: FeedbackReport, options: FeedbackOptions): Promise<number> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const disabledBy = options.telemetry.disabledBy;
  const blocked = disabledBy !== undefined && BLOCKING.has(disabledBy);
  if (!blocked && options.allowOutdated !== true) {
    const latest = await latestRelease(fetchImpl, LATEST_TIMEOUT_MS);
    if (latest !== undefined && olderThan(options.version, latest)) {
      process.stderr.write(
        `feedback not sent: e2e ${options.version} is older than the latest release ${latest}, which may already fix this. Upgrade with e2e upgrade, check the problem still happens, and send it again; --allow-outdated sends it anyway.\n`,
      );
      return 2;
    }
  }
  const environment = collectEnvironment({ env, cwd: options.cwd ?? process.cwd(), version: options.version });
  const redact = feedbackRedactor(env);
  if (report.type === 'bug' && report.repro === undefined) {
    process.stdout.write(
      `Not sent: a bug without --repro goes to GitHub, where the e2e team can ask for a reproduction. Open this prefilled issue, add a minimal reproduction, and submit it:\n${bugIssueUrl(report, environment, redact)}\n`,
    );
    return 0;
  }
  const event = feedbackEvent(report, options, environment, redact);
  if (options.dryRun === true || options.telemetry.debug) {
    process.stdout.write(`${JSON.stringify(event, null, 2)}\n`);
    return 0;
  }
  if (blocked) {
    process.stderr.write(`feedback not sent: ${disabledBy} is set, which switches off everything e2e sends. Unset it for this command to send the report.\n`);
    return 2;
  }
  const sent = await postBatch([event], { signal: AbortSignal.timeout(SEND_TIMEOUT_MS), fetch: fetchImpl });
  if (!sent) {
    process.stderr.write(
      `feedback not confirmed: PostHog did not acknowledge report ${event.uuid}, so it may not have arrived. Try again, or open an issue: ${ISSUES_URL}\n`,
    );
    return 3;
  }
  process.stdout.write(`Feedback sent to the e2e team, thank you. Reference: ${event.uuid}\n`);
  return 0;
}
