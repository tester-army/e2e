/**
 * The events e2e sends, built from facts the CLI already holds. Every
 * property is a closed enumeration, a count, a duration, or a version. The
 * builders copy no title, file, URL, instruction, message, or stack out of
 * the report, and they fold what a project chose for itself — an engine
 * name, a platform, a model id, an error code outside the runner's
 * vocabulary — into `other`, so a project's own words stay home. The unit
 * tests hold the payload to that promise.
 */

import type { Report1Document, ReportStep } from '../report/build.ts';
import type { StepKind } from '../run/steps.ts';
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

/** Engines this repository publishes; any other name is a project's own. */
const FIRST_PARTY_ENGINES: ReadonlySet<string> = new Set(['playwright', 'agent-device', 'cua', 'none']);
const KNOWN_PLATFORMS: ReadonlySet<string> = new Set(['web', 'ios', 'android', 'macos', 'windows', 'linux']);
const STEP_KINDS: readonly StepKind[] = ['agent', 'locator', 'assertion', 'screen', 'app', 'session', 'resource'];
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
/** The runner's error codes are SCREAMING_SNAKE tokens; anything else is a project's. */
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

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].toSorted();
}

/** Every step the run recorded, across plain results and serial groups. */
function* steps(report: Report1Document): Generator<ReportStep> {
  for (const result of report.run.results) {
    for (const attempt of result.attempts) yield* attempt.steps;
  }
  for (const group of report.run.serialGroups) {
    for (const attempt of group.attempts) {
      for (const member of attempt.members) yield* member.steps;
    }
  }
}

/** Every error code the run recorded, at the run, attempt, member, and step level. */
function* errorCodes(report: Report1Document): Generator<string> {
  for (const error of report.run.errors) yield error.code;
  for (const result of report.run.results) {
    for (const attempt of result.attempts) {
      if (attempt.error !== undefined) yield attempt.error.code;
      for (const error of attempt.secondaryErrors) yield error.code;
      for (const step of attempt.steps) if (step.error !== undefined) yield step.error.code;
    }
  }
  for (const group of report.run.serialGroups) {
    for (const attempt of group.attempts) {
      if (attempt.error !== undefined) yield attempt.error.code;
      for (const error of attempt.secondaryErrors) yield error.code;
      for (const member of attempt.members) {
        if (member.error !== undefined) yield member.error.code;
        for (const error of member.secondaryErrors) yield error.code;
        for (const step of member.steps) if (step.error !== undefined) yield step.error.code;
      }
    }
  }
}

function durationMs(startedAt: string, finishedAt: string): number | null {
  const duration = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) ? Math.max(0, duration) : null;
}

export function runCompletedEvent(report: Report1Document, flags: readonly string[]): TelemetryEvent {
  const { run } = report;
  const stepCounts: Record<string, number> = {};
  for (const kind of STEP_KINDS) stepCounts[`steps_${kind}`] = 0;
  let stepsTotal = 0;
  let replayed = 0;
  let partial = 0;
  let missed = 0;
  let vision = 0;
  let modelCalls = 0;
  let modelProvider: string | null = null;
  let modelId: string | null = null;
  for (const step of steps(report)) {
    stepsTotal += 1;
    const key = `steps_${step.kind}`;
    stepCounts[key] = (stepCounts[key] ?? 0) + 1;
    if (step.cache !== undefined) {
      if (step.cache.mode === 'self-finalized') replayed += 1;
      else if (step.cache.mode === 'agent-concluded') partial += 1;
      else missed += 1;
    }
    if (step.visionInput === true) vision += 1;
    if (step.model !== undefined) {
      modelCalls += step.model.calls;
      modelProvider ??= step.model.provider;
      modelId ??= MODEL_ID.test(step.model.model) ? step.model.model : 'other';
    }
  }

  const codes = unique([...errorCodes(report)].map((code) => (ERROR_CODE.test(code) ? code : 'OTHER')));

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
      steps_total: stepsTotal,
      ...stepCounts,
      agent_steps_replayed: replayed,
      agent_steps_partial: partial,
      agent_steps_missed: missed,
      agent_steps_vision: vision,
      model_provider: modelProvider,
      model_id: modelId,
      model_calls: modelCalls,
      model_tokens: run.usage.modelTokens,
      estimated_cost_usd: run.usage.estimatedCostUsd ?? null,
      artifact_bytes: run.usage.artifactBytes,
      errors: run.errors.length,
      error_codes: codes.slice(0, MAX_ERROR_CODES),
    },
  };
}
