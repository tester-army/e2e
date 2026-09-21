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
import { errorCodeToken, plainToken } from './token.ts';

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
/** One per `e2e init`, however it ended: what was chosen and whether anything was written. */
export const EVENT_INIT_COMPLETED = 'e2e_init_completed';
/** The session's error code for a flag or argument commander rejected; no runner code exists for it. */
export const USAGE_ERROR_CODE = 'CLI_USAGE';

/** How the invocation ended, known only once the command has returned or thrown. */
export interface SessionEnd {
  readonly exitCode: number;
  /** The runner code of the failure that ended the command before it could run; undefined when nothing did. */
  readonly errorCode: string | undefined;
  readonly elapsedMs: number;
}

/**
 * How `e2e init` ended. `scaffolded` wrote files, `already-initialized` found
 * nothing to write, `cancelled` stopped at a prompt, `install-failed` wrote
 * the files but the package manager failed, `not-interactive` had prompts and
 * no terminal, `invalid-project` could not start (a file for a directory, an
 * unreadable package.json, a bundled skill missing).
 */
export type InitResult =
  | 'scaffolded'
  | 'already-initialized'
  | 'cancelled'
  | 'install-failed'
  | 'not-interactive'
  | 'invalid-project';

/** What `e2e init` was asked and chose: the CLI's own option ids, never a path or an endpoint the user typed. */
export interface InitOutcome {
  readonly result: InitResult;
  readonly yes: boolean;
  /** Whether a config already existed, in which case no engine or gateway was asked. */
  readonly existingConfig: boolean;
  readonly engine: string | null;
  readonly gateway: string | null;
  /** Whether the agent skill, the MCP registration, and the install were chosen. */
  readonly skill: boolean;
  readonly mcp: boolean;
  readonly install: boolean;
}

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const MAX_ERROR_CODES = 20;

/** The session: the command and its flag names, and how it ended once that is known. */
export function cliSessionEvent(command: string, flags: readonly string[], ended?: SessionEnd): TelemetryEvent {
  return {
    name: EVENT_CLI_SESSION,
    properties: {
      command,
      flags: [...flags],
      ...(ended === undefined
        ? {}
        : {
            exit_code: ended.exitCode,
            error_code: ended.errorCode === undefined ? null : errorCodeToken(ended.errorCode),
            duration_ms: Math.max(0, Math.round(ended.elapsedMs)),
          }),
    },
  };
}

/** The init event: each choice as its option id. */
export function initCompletedEvent(outcome: InitOutcome): TelemetryEvent {
  return {
    name: EVENT_INIT_COMPLETED,
    properties: {
      result: outcome.result,
      yes: outcome.yes,
      existing_config: outcome.existingConfig,
      engine: outcome.engine,
      gateway: outcome.gateway,
      skill: outcome.skill,
      mcp: outcome.mcp,
      install: outcome.install,
    },
  };
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
    [...run.errors, ...recorded.flatMap(errorsOf)].map((error) => errorCodeToken(error.code)),
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
