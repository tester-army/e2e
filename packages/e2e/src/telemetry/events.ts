/**
 * The events e2e sends, built from facts the CLI already holds. Every
 * property is a count, a duration, a version, or a short token. The builders
 * copy no title, file, URL, instruction, message, or stack out of the report.
 * The names a project declares for its engines, platforms, and model pass
 * through when they are plain tokens, so a homegrown engine counts as itself;
 * a name shaped like a path, a URL, or a sentence folds to `other`, and an
 * error code that is not an upper-case token, the shape of every runner
 * code, folds to `OTHER`. The unit tests hold the payload to that promise.
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

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
/**
 * The shape of a name worth sending as it is: an engine name, a platform, or
 * a public model id is a short token. A path, a URL, a sentence, or a
 * fine-tuned or routed model id is not, and folds to `other`.
 */
const PLAIN_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
/** The shape of every runner error code. A code shaped otherwise is a project's own and folds to `OTHER`. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/u;
const MAX_ERROR_CODES = 20;

export function cliSessionEvent(command: string, flags: readonly string[]): TelemetryEvent {
  return { name: EVENT_CLI_SESSION, properties: { command, flags: [...flags] } };
}

function plainToken(value: string): string {
  return PLAIN_TOKEN.test(value) ? value : 'other';
}

/**
 * The vendor and public id of a step's model. A gateway serves ids in the
 * `vendor/model` form and the report names the gateway as the provider, so
 * the vendor is the id's first segment; an AI SDK instance's provider is the
 * vendor already and its id has no such prefix.
 */
function splitModel(model: { readonly provider: string; readonly model: string }): { provider: string; id: string } {
  const separator = model.model.indexOf('/');
  if (separator <= 0) return { provider: model.provider, id: model.model };
  return { provider: plainToken(model.model.slice(0, separator)), id: model.model.slice(separator + 1) };
}

/** `playwright@0.6.1`, and a project's own engine the same way; a name that is not a plain token is `other` alone. */
function engineLabel(engine: { readonly name: string; readonly version: string }): string {
  const name = plainToken(engine.name);
  if (name === 'other') return name;
  return `${name}@${SEMVER.test(engine.version) ? engine.version : 'unversioned'}`;
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
  const firstModel = first === undefined ? undefined : splitModel(first);
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
      platforms: unique(run.targets.map((target) => plainToken(target.platform))),
      engines: unique(run.targets.map((target) => engineLabel(target.engine))),
      steps_total: steps.length,
      ...Object.fromEntries(
        STEP_KINDS.map((kind): [string, number] => [`steps_${kind}`, steps.filter((step) => step.kind === kind).length]),
      ),
      agent_steps_replayed: steps.filter((step) => step.cache?.mode === 'self-finalized').length,
      agent_steps_partial: steps.filter((step) => step.cache?.mode === 'agent-concluded').length,
      agent_steps_missed: steps.filter((step) => step.cache?.mode === 'missed').length,
      agent_steps_vision: steps.filter((step) => step.visionInput === true).length,
      model_gateway: first?.provider ?? null,
      model_provider: firstModel?.provider ?? null,
      model_id: firstModel === undefined ? null : plainToken(firstModel.id),
      model_calls: models.reduce((total, model) => total + model.calls, 0),
      model_tokens: run.usage.modelTokens,
      model_cached_tokens: run.usage.modelCachedTokens ?? null,
      estimated_cost_usd: run.usage.estimatedCostUsd ?? null,
      artifact_bytes: run.usage.artifactBytes,
      errors: run.errors.length,
      error_codes: codes.slice(0, MAX_ERROR_CODES),
    },
  };
}
