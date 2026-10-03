/**
 * The events e2e sends, built from facts the CLI already holds. Every
 * property is a count, a duration, a version, or a short token. The builders
 * copy no title, file, URL, instruction, message, or stack out of the report,
 * the config, or an MCP session; the one look at a message, in
 * `failure-kind.ts`, yields a token from a closed list.
 * The names a project declares for its engines, platforms, and model, and the
 * name an MCP client gives itself, pass through when they are plain tokens,
 * so a homegrown engine counts as itself; a name shaped like a path, a URL,
 * or a sentence folds to `other`, and an error code that is not an upper-case
 * token, the shape of every runner code, folds to `OTHER`. The unit tests
 * hold the payload to that promise.
 */

import { GRAMMAR_ACTION_NAMES, GRAMMAR_TOOL_NAMES, PROJECT_TOOL_EVENT_PREFIX } from '../agent/action-names.ts';
import { modelLabel } from '../config/agent.ts';
import type { ResolvedConfig } from '../config/resolve.ts';
import type { McpClient } from '../mcp/server.ts';
import type { McpSessionSummary } from '../mcp/usage.ts';
import type { Report1Document, ReportError, ReportExplore, ReportStep, ReportUsage } from '../report/build.ts';
import { STEP_KINDS } from '../run/steps.ts';
import type { JsonValue } from '../types.ts';
import { failureKind } from './failure-kind.ts';
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
/** One per `open_session` an `e2e mcp` server served, sent when the session closes or its open fails. */
export const EVENT_MCP_SESSION = 'e2e_mcp_session';
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
/** Distinct error codes, and distinct failure kinds, a run event lists. */
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

/** `web@0.6.1`, and a project's own engine the same way; a name that is not a plain token is `other` alone. */
function engineLabel(engine: { readonly name: string; readonly version: string }): string {
  const name = plainToken(engine.name);
  if (name === 'other') return name;
  return `${name}@${SEMVER.test(engine.version) ? engine.version : 'unversioned'}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].toSorted();
}

/** Counts keyed in sorted order, so equal counts serialize equally. */
function sortedCounts(counts: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries([...counts].toSorted());
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

/** The scope's verdict, then the steps that led there, then what cleanup added. */
function errorsOf(scope: ReportScope): ReportError[] {
  return [
    ...(scope.error === undefined ? [] : [scope.error]),
    ...(scope.steps ?? []).flatMap((step) => (step.error === undefined ? [] : [step.error])),
    ...scope.secondaryErrors,
  ];
}

const GRAMMAR_ACTIONS: ReadonlySet<string> = new Set(GRAMMAR_ACTION_NAMES);

/**
 * How often the agent took each action, by the runner's own names. A
 * project's tools count together under `tool` and anything else under
 * `other`, so the keys are a closed set and never a project's vocabulary.
 */
function agentActions(steps: readonly ReportStep[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const step of steps) {
    if (step.kind !== 'agent') continue;
    for (const event of step.events) {
      if (event.kind !== 'engine' || event.name === undefined) continue;
      const name = GRAMMAR_ACTIONS.has(event.name) ? event.name : event.name.startsWith(PROJECT_TOOL_EVENT_PREFIX) ? 'tool' : 'other';
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return sortedCounts(counts);
}

/** Whether anyone priced the model calls: a gateway that did, nobody, or no calls to price. */
function costSource(usage: ReportUsage, modelCalls: number): 'provider' | 'none' | null {
  if (usage.estimatedCostUsd !== undefined) return 'provider';
  return modelCalls > 0 ? 'none' : null;
}

function durationMs(startedAt: string, finishedAt: string): number | null {
  const duration = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) ? Math.max(0, duration) : null;
}

/** What the CLI knows of a run beyond its report. */
export interface RunContext {
  /** `run` or `explore`. */
  readonly command: string;
  /** The flag names given, never their values. */
  readonly flags: readonly string[];
  /** The config the run resolved; undefined when it failed to load. */
  readonly config: ResolvedConfig | undefined;
}

/**
 * Which config features a run used: counts, booleans, and the runner's own
 * option ids, never a name, a path, or a value the project wrote.
 */
function configFeatures(config: ResolvedConfig): Record<string, JsonValue> {
  const agents = [...config.agents.values()];
  return {
    config_workers: config.workers,
    config_retries: config.retries,
    config_agents: config.agents.size,
    config_custom_executor: agents.some((agent) => agent.executor !== undefined),
    config_separate_judge: agents.some(
      (agent) => agent.judge !== undefined && (agent.model === undefined || modelLabel(agent.judge) !== modelLabel(agent.model)),
    ),
    config_project_tools: new Set(agents.flatMap((agent) => Object.keys(agent.tools))).size,
    config_credentials: config.credentials.size,
    config_secrets: config.secrets.size,
    config_cache_mode: config.cache.mode,
    config_cache_store: config.cache.store === undefined ? 'file' : 'custom',
    config_cache_strict: config.cache.strict !== false,
    config_reporters: unique(config.reporters),
    config_custom_reporters: config.customReporters.length,
    config_artifact_store: config.artifactStore !== undefined,
    config_video_modes: unique(config.targets.map((target) => target.video.mode)),
    config_app_commands: config.targets.filter((target) => target.app.command !== undefined).length,
    config_environments: unique(config.targets.map((target) => target.app.environment)),
  };
}

const EXPLORE_STEP_STATUSES = ['passed', 'failed', 'blocked', 'exhausted'] as const;
const SEVERITIES = [1, 2, 3, 4, 5] as const;

/** What `e2e explore` was given and found, by count: never the goal, a step's charter, or a finding's words. */
function exploreProperties(explore: ReportExplore): Record<string, JsonValue> {
  return {
    explore_ended: explore.ended,
    explore_max_steps: explore.budgets.maxSteps,
    explore_timeout_ms: explore.budgets.timeoutMs,
    explore_steps: explore.steps.length,
    ...Object.fromEntries(
      EXPLORE_STEP_STATUSES.map((status): [string, number] => [`explore_steps_${status}`, explore.steps.filter((step) => step.status === status).length]),
    ),
    explore_assessed: explore.summary !== undefined,
    explore_issues: explore.findings.filter((finding) => finding.kind === 'issue').length,
    explore_warnings: explore.findings.filter((finding) => finding.kind === 'warning').length,
    explore_findings_by_severity: Object.fromEntries(
      SEVERITIES.map((severity): [string, number] => [String(severity), explore.findings.filter((finding) => finding.severity === severity).length]),
    ),
  };
}

export function runCompletedEvent(report: Report1Document, context: RunContext): TelemetryEvent {
  const { run } = report;
  const recorded = [...scopes(report)];
  const steps = recorded.flatMap((scope) => scope.steps ?? []);
  const models = steps.flatMap((step) => (step.model === undefined ? [] : [step.model]));
  const first = models[0];
  const firstModel = first === undefined ? undefined : splitModel(first);
  // Run-level first, then each scope's in the order it recorded them: the first is the one that decided the status.
  const errors = [...run.errors, ...recorded.flatMap(errorsOf)];
  const primary = errors[0];
  const attempts = [...run.results, ...run.serialGroups].map((unit) => unit.attempts.length);

  return {
    name: EVENT_RUN_COMPLETED,
    at: run.finishedAt,
    properties: {
      command: context.command,
      status: run.status,
      exit_code: run.exitCode,
      duration_ms: durationMs(run.startedAt, run.finishedAt),
      flags: [...context.flags],
      tests_discovered: run.summary.discovered,
      tests_selected: run.summary.selected,
      tests_executed: run.summary.executed,
      tests_passed: run.summary.passed,
      tests_failed: run.summary.failed,
      tests_interrupted: run.summary.interrupted,
      tests_flaky: run.summary.flaky,
      tests_skipped: run.summary.skipped,
      attempts_total: attempts.reduce((total, count) => total + count, 0),
      tests_retried: attempts.filter((count) => count > 1).length,
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
      agent_actions: agentActions(steps),
      model_gateway: first?.provider ?? null,
      model_provider: firstModel?.provider ?? null,
      model_id: firstModel === undefined ? null : plainToken(firstModel.id),
      model_calls: models.reduce((total, model) => total + model.calls, 0),
      model_tokens: run.usage.modelTokens,
      model_cached_tokens: run.usage.modelCachedTokens ?? null,
      estimated_cost_usd: run.usage.estimatedCostUsd ?? null,
      cost_source: costSource(run.usage, models.length),
      artifact_bytes: run.usage.artifactBytes,
      errors: run.errors.length,
      primary_error_code: primary === undefined ? null : errorCodeToken(primary.code),
      error_codes: unique(errors.map((error) => errorCodeToken(error.code))).slice(0, MAX_ERROR_CODES),
      error_kinds: unique(errors.flatMap(failureKind)).slice(0, MAX_ERROR_CODES),
      // A run whose config never loaded has no features to report.
      ...(context.config === undefined ? {} : configFeatures(context.config)),
      ...(run.explore === undefined ? {} : exploreProperties(run.explore)),
    },
  };
}

/**
 * The catalog tools an MCP session serves itself, by name: the grammar and
 * the session's own (`createSessionCatalog`). A project's tools arrive
 * counted together; any name outside this set folds to `other`.
 */
const SESSION_TOOLS: ReadonlySet<string> = new Set([...GRAMMAR_TOOL_NAMES, 'locate', 'start_recording', 'stop_recording']);

/** One MCP session: the client, the target's platform and engine, how it ended, and its calls by the runner's tool names. */
export function mcpSessionEvent(summary: McpSessionSummary, client: McpClient | undefined): TelemetryEvent {
  const calls = new Map<string, number>();
  for (const [name, count] of summary.toolCalls) {
    const key = SESSION_TOOLS.has(name) ? name : 'other';
    calls.set(key, (calls.get(key) ?? 0) + count);
  }
  if (summary.projectToolCalls > 0) calls.set('tool', summary.projectToolCalls);
  const codes = new Map<string, number>();
  for (const [code, count] of summary.errorCodes) {
    const key = errorCodeToken(code);
    codes.set(key, (codes.get(key) ?? 0) + count);
  }
  return {
    name: EVENT_MCP_SESSION,
    properties: {
      client: client === undefined ? null : plainToken(client.name),
      client_version: client === undefined ? null : plainToken(client.version),
      outcome: summary.outcome,
      ended_by: summary.endedBy ?? null,
      error_code: summary.openErrorCode === undefined ? null : errorCodeToken(summary.openErrorCode),
      platform: summary.platform === undefined ? null : plainToken(summary.platform),
      engine: summary.engine === undefined ? null : engineLabel(summary.engine),
      headed: summary.headed,
      duration_ms: Math.max(0, Math.round(summary.durationMs)),
      sessions_open: summary.concurrent,
      calls_total: [...calls.values()].reduce((total, count) => total + count, 0),
      calls_failed: summary.failedCalls,
      calls: sortedCounts(calls),
      error_codes: sortedCounts(new Map([...codes].toSorted().slice(0, MAX_ERROR_CODES))),
    },
  };
}
