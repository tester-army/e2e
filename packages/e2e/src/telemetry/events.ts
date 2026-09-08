/**
 * The events e2e sends, built from facts the CLI already holds. Every
 * property is a closed enumeration, a count, a duration, or a version. The
 * builders copy no title, file, URL, instruction, message, or stack out of
 * the report, and they fold what a project chose for itself — an engine
 * name, a platform, a model id — into `other`, so a project's own words stay
 * home. An error code passes when it has the shape every runner code has, an
 * upper-case token, and folds to `OTHER` otherwise. The unit tests hold the
 * payload to that promise.
 */

import type { Report1Document, ReportError, ReportStep } from '../report/build.ts';
import { STEP_KINDS } from '../run/steps.ts';
import type { JsonValue } from '../types.ts';

export interface TelemetryEvent {
  readonly name: string;
  readonly properties: Readonly<Record<string, JsonValue>>;
  /** When the event happened, RFC 3339; the flush time when absent. */
  readonly at?: string;
}

/** One per CLI invocation: which command, with which flags. */
export const EVENT_CLI_SESSION = 'e2e_cli_session';
/** One per `e2e run`, from the report the run wrote. */
export const EVENT_RUN_COMPLETED = 'e2e_run_completed';

/** Engines this repository publishes, and `none` for a target without one; any other name is a project's own. */
const FIRST_PARTY_ENGINES: ReadonlySet<string> = new Set(['playwright', 'agent-device', 'none']);
/** The platforms those engines drive; any other platform is a project's own. */
const KNOWN_PLATFORMS: ReadonlySet<string> = new Set(['web', 'ios', 'android']);
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
/** The shape of every runner error code. A code shaped otherwise is a project's own and folds to `OTHER`. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/u;
/** Public model ids: no slashes, colons, or spaces, which fine-tunes and routes carry. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MAX_ERROR_CODES = 20;

export function cliSessionEvent(command: string, flags: readonly string[]): TelemetryEvent {
  return { name: EVENT_CLI_SESSION, properties: { command, flags: [...flags] } };
}

function fold(value: string, known: ReadonlySet<string>): string {
  return known.has(value) ? value : 'other';
}

function engineLabel(engine: { readonly name: string; readonly version: string }): string {
  if (!FIRST_PARTY_ENGINES.has(engine.name)) return 'other';
  return `${engine.name}@${SEMVER.test(engine.version) ? engine.version : 'unversioned'}`;
}

function publicModelId(model: string): string {
  return MODEL_ID.test(model) ? model : 'other';
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].toSorted();
}

/** What carries steps and errors: a plain attempt, a serial attempt, or one of its members. */
interface ReportScope {
  readonly steps?: readonly ReportStep[];
  readonly error?: ReportError | undefined;
  readonly secondaryErrors: readonly ReportError[];
}

/** Every scope the run recorded, across plain results and serial groups. */
function* scopes(report: Report1Document): Generator<ReportScope> {
  for (const result of report.run.results) yield* result.attempts;
  for (const group of report.run.serialGroups) {
    for (const attempt of group.attempts) {
      yield attempt;
      yield* attempt.members;
    }
  }
}

/** The scope's own errors, then its steps'. */
function errorsOf(scope: ReportScope): ReportError[] {
  return [
    ...(scope.error === undefined ? [] : [scope.error]),
    ...scope.secondaryErrors,
    ...(scope.steps ?? []).flatMap((step) => (step.error === undefined ? [] : [step.error])),
  ];
}

function durationMs(startedAt: string, finishedAt: string): number | null {
  const duration = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) ? Math.max(0, duration) : null;
}

export function runCompletedEvent(report: Report1Document, flags: readonly string[]): TelemetryEvent {
  const { run } = report;
  const recorded = [...scopes(report)];
  const steps = recorded.flatMap((scope) => scope.steps ?? []);
  const models = steps.flatMap((step) => (step.model === undefined ? [] : [step.model]));
  const first = models[0];
  const codes = unique(
    [...run.errors, ...recorded.flatMap(errorsOf)].map((error) => (ERROR_CODE.test(error.code) ? error.code : 'OTHER')),
  );

  return {
    name: EVENT_RUN_COMPLETED,
    at: run.finishedAt,
    properties: {
      status: run.status,
      exit_code: run.exitCode,
      duration_ms: durationMs(run.startedAt, run.finishedAt),
      flags: [...flags],
      tests_discovered: run.summary.discovered,
      tests_selected: run.summary.selected,
      tests_executed: run.summary.executed,
      tests_passed: run.summary.passed,
      tests_failed: run.summary.failed,
      tests_flaky: run.summary.flaky,
      tests_skipped: run.summary.skipped,
      targets: run.targets.length,
      platforms: unique(run.targets.map((target) => fold(target.platform, KNOWN_PLATFORMS))),
      engines: unique(run.targets.map((target) => engineLabel(target.engine))),
      steps_total: steps.length,
      ...Object.fromEntries(
        STEP_KINDS.map((kind): [string, number] => [`steps_${kind}`, steps.filter((step) => step.kind === kind).length]),
      ),
      agent_steps_replayed: steps.filter((step) => step.cache?.mode === 'self-finalized').length,
      agent_steps_partial: steps.filter((step) => step.cache?.mode === 'agent-concluded').length,
      agent_steps_missed: steps.filter((step) => step.cache?.mode === 'missed').length,
      agent_steps_vision: steps.filter((step) => step.visionInput === true).length,
      model_provider: first?.provider ?? null,
      model_id: first === undefined ? null : publicModelId(first.model),
      model_calls: models.reduce((total, model) => total + model.calls, 0),
      model_tokens: run.usage.modelTokens,
      estimated_cost_usd: run.usage.estimatedCostUsd ?? null,
      artifact_bytes: run.usage.artifactBytes,
      errors: run.errors.length,
      error_codes: codes.slice(0, MAX_ERROR_CODES),
    },
  };
}
