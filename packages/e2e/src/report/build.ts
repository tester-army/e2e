/** report-1 document construction. */

import os from 'node:os';
import { ENGINE_SPI_VERSION, type EngineSpiVersion } from '../engine/contract.ts';
import { BLOCKABLE_CODES } from '../agent/executor.ts';
import { DEFAULT_OBSERVATION_BYTES, resolveLimits } from '../config/agent.ts';
import type { ResolvedConfig, ResolvedLimits, ResolvedTarget } from '../config/resolve.ts';
import type { AgentErrorCode, ConfiguredArtifactKind } from '../types.ts';
import type { ErrorCategory, ErrorPhase, SerializedError } from '../internal/errors.ts';
import { resultId, timestamp } from '../internal/ids.ts';
import { obj } from '../internal/objects.ts';
import { packageVersion } from '../internal/package-version.ts';
import type { SkipInfo } from '../collect/select.ts';
import type {
  ArtifactRecord,
  AttemptRecord,
  ResultRecord,
  RunError,
  SerialAttemptRecord,
  SerialGroupRecord,
  SerialMemberRecord,
} from '../run/records.ts';
import type {
  StepCacheInfo,
  StepEvent,
  StepMetrics,
  StepModelInfo,
  StepRecord,
  VisionDegradation,
} from '../run/steps.ts';

export interface ReportSource {
  file: string;
  line: number;
  column: number;
}

export interface TargetProvenance {
  engine: { name: string; version: string; spiVersion: EngineSpiVersion };
  capabilities: string[];
  artifactCapabilities: ConfiguredArtifactKind[];
  stateCapability: boolean;
}

/**
 * What a target's engine declaration says about it: the one description the
 * runner grades against and the report records. A target without an engine is
 * agent-tools-only and honestly reports no capabilities.
 */
export function describeTarget(target: ResolvedTarget): TargetProvenance {
  const engine = target.engine;
  const artifactCapabilities: TargetProvenance['artifactCapabilities'] = [];
  if (engine?.artifacts !== undefined) {
    artifactCapabilities.push('screenshot');
    if (engine.artifacts.startTrace !== undefined) artifactCapabilities.push('trace');
    if (engine.artifacts.startVideo !== undefined) artifactCapabilities.push('video');
  }
  return {
    engine: {
      name: engine?.name ?? 'none',
      version: engine?.version ?? 'unversioned',
      spiVersion: engine?.spiVersion ?? ENGINE_SPI_VERSION,
    },
    capabilities: [...(engine?.capabilities ?? [])].toSorted(),
    artifactCapabilities,
    stateCapability: engine?.state !== undefined,
  };
}

export interface BuildReportOptions {
  runId: string;
  config: ResolvedConfig | undefined;
  startedAt: string;
  status: 'passed' | 'failed' | 'error' | 'interrupted';
  exitCode: 0 | 1 | 2 | 3 | 4 | 130;
  results: readonly ResultRecord[];
  serialGroups: readonly SerialGroupRecord[];
  runErrors: readonly RunError[];
  targetProvenance: ReadonlyMap<string, TargetProvenance>;
  /** The exploration record of an `e2e explore` run; absent for a test run. */
  explore?: ReportExplore | undefined;
}

/** One finding `e2e explore` recorded through its `report_finding` tool. */
export interface ReportExploreFinding {
  id: string;
  index: number;
  /** One-based exploration step the finding was reported in; absent when reported between steps. */
  step?: number | undefined;
  /** An `issue` fails the run; a `warning` is recorded and does not. */
  kind: 'issue' | 'warning';
  /** 5 = a core journey is impossible or data is wrong, 1 = a polish item. */
  severity: 1 | 2 | 3 | 4 | 5;
  title: string;
  expected: string;
  actual: string;
  reproduction: readonly string[];
  /** Redacted location when the engine reports one. */
  path?: string | undefined;
  observationRevision?: string | undefined;
  reportedAt: string;
  /** The attempt's `screenshot` artifact holding the evidence, by id, when pixels were granted. */
  artifactId?: string | undefined;
}

/** One exploration step: a charter the agent planned and then executed as an `agent.act` step. */
export interface ReportExploreStep {
  index: number;
  title: string;
  instruction: string;
  /** `exhausted`: the step ended at its action or time budget, which is not a failure. */
  status: 'passed' | 'failed' | 'blocked' | 'exhausted';
  summary?: string | undefined;
  errorCode?: string | undefined;
  startedAt: string;
  durationMs: number;
}

/** The `run.explore` block: what `e2e explore` was asked, did, and found. */
export interface ReportExplore {
  goal: string;
  budgets: { maxSteps: number; timeoutMs: number };
  /** Why exploration stopped. */
  ended: 'finished' | 'step-limit' | 'time' | 'stuck' | 'aborted';
  /** The agent's closing assessment, when it gave one. */
  summary?: string | undefined;
  steps: readonly ReportExploreStep[];
  findings: readonly ReportExploreFinding[];
}

// --- report-1 wire shapes (schema/report-v1.schema.json) ---
// Explicit `| undefined` marks fields JSON serialization drops when absent;
// Ajv treats undefined-valued keys as missing.

/** SerializedError minus the stack, which never enters the report. */
export interface ReportError {
  category: ErrorCategory;
  code: string;
  message: string;
  retryable: boolean;
  phase?: ErrorPhase | undefined;
  scopeId?: string | undefined;
}

export interface ReportStep {
  id: string;
  index: number;
  kind: StepRecord['kind'];
  api: string;
  label: string;
  source: ReportSource;
  status: StepRecord['status'];
  startedAt: string;
  durationMs: number;
  observationRevision?: string | undefined;
  explanation?: string | undefined;
  visionInput?: boolean | undefined;
  visionDegraded?: VisionDegradation | undefined;
  visionOnly?: boolean | undefined;
  viewport?: { width: number; height: number; scale: number } | undefined;
  metrics?: StepMetrics | undefined;
  cache?: StepCacheInfo | undefined;
  events: readonly StepEvent[];
  model?: StepModelInfo | undefined;
  /** The configured agent an agent step ran with, by name. */
  agent?: string | undefined;
  error?: ReportError | undefined;
  artifacts: readonly string[];
}

interface ReportAttemptBase {
  id: string;
  index: number;
  status: AttemptRecord['status'];
  startedAt: string;
  durationMs: number;
  artifacts: readonly ArtifactRecord[];
  error?: ReportError | undefined;
  secondaryErrors: readonly ReportError[];
  cleanup: AttemptRecord['cleanup'];
}

export interface ReportAttempt extends ReportAttemptBase {
  steps: readonly ReportStep[];
}

export interface ReportSerialMember {
  id: string;
  index: number;
  testId: string;
  status: SerialMemberRecord['status'];
  startedAt: string;
  durationMs: number;
  steps: readonly ReportStep[];
  error?: ReportError | undefined;
  skip?: SkipInfo | undefined;
  secondaryErrors: readonly ReportError[];
}

export interface ReportSerialAttempt extends ReportAttemptBase {
  members: readonly ReportSerialMember[];
}

export interface ReportSerialGroup {
  id: string;
  serialId: string;
  declarationIndex: number;
  file: string;
  source: ReportSource;
  titlePath: readonly string[];
  targetId: string;
  platform: string;
  /** The configured agent this variant of the group ran as. */
  agent: string;
  memberTestIds: readonly string[];
  status: SerialGroupRecord['status'];
  skip?: SkipInfo | undefined;
  attempts: readonly ReportSerialAttempt[];
}

export interface ReportResult {
  id: string;
  testId: string;
  kind: 'test' | 'setup';
  declarationIndex: number;
  titlePath: readonly string[];
  file: string;
  source: ReportSource;
  targetId: string;
  platform: string;
  /**
   * The configured agent the test ran as. A test pinned to several agents,
   * or a run with several `--agent` names, yields one result per agent, each
   * with its own `id`.
   */
  agent: string;
  serialGroupId?: string | undefined;
  status: ResultRecord['status'];
  skip?: SkipInfo | undefined;
  attempts: readonly ReportAttempt[];
}

export interface ReportTarget {
  id: string;
  index: number;
  platform: string;
  /** Origin of the engine's declared app URL; absent for a surface without one. */
  baseOrigin?: string;
  environment: string;
  testIdAttribute: string;
  engine: { name: string; version: string; spiVersion: EngineSpiVersion };
  capabilities: readonly string[];
  artifactCapabilities: readonly string[];
  stateCapability: boolean;
}

/**
 * The report's `limits` block is the resolved limits verbatim; JSON
 * serialization drops the absent cost ceiling.
 */
export type ReportLimits = ResolvedLimits;

export interface ReportUsage {
  discoveredResults: number;
  maxAgentContextBytes: number;
  maxLedgerBytes: number;
  maxObservationBytes: number;
  artifactBytes: number;
  downloads: number;
  events: number;
  modelTokens: number;
  /** Input tokens served from provider prompt caches; present once any step reports the split. */
  modelCachedTokens?: number;
  maxModelCallsInStep: number;
  maxActionStepsInStep: number;
  estimatedCostUsd?: number;
}

export interface ReportSummary {
  discovered: number;
  selected: number;
  executed: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
}

export interface Report1Document {
  schemaVersion: 'report-1';
  run: {
    id: string;
    specVersion: '0.1';
    runner: { name: 'e2e'; version: string };
    status: BuildReportOptions['status'] | 'blocked';
    exitCode: BuildReportOptions['exitCode'];
    startedAt: string;
    finishedAt: string;
    project: { id: string; configDigest: string };
    environment: {
      ci: boolean;
      trustNoticeShown: boolean;
      os: string;
      arch: string;
      runtime: string;
    };
    targets: readonly ReportTarget[];
    serialGroups: readonly ReportSerialGroup[];
    results: readonly ReportResult[];
    errors: readonly ReportError[];
    summary: ReportSummary;
    limits: ReportLimits;
    usage: ReportUsage;
    /** Present on an `e2e explore` run only. */
    explore?: ReportExplore | undefined;
  };
}

function relativeSource(
  config: ResolvedConfig | undefined,
  source: { file: string; line: number; column: number } | undefined,
  fallbackFile: string,
): ReportSource {
  if (source === undefined) return { file: fallbackFile, line: 1, column: 1 };
  let file = source.file;
  if (config !== undefined && file.startsWith(config.projectRoot)) {
    file = file.slice(config.projectRoot.length).replace(/^[/\\]/, '').split('\\').join('/');
  }
  if (file.startsWith('/') || /^[A-Za-z]:/.test(file)) {
    file = fallbackFile;
  }
  return { file, line: Math.max(1, source.line), column: Math.max(1, source.column) };
}

/** Step source capture is not implemented yet. */
const UNIMPLEMENTED_STEP_SOURCE: ReportSource = { file: 'unknown', line: 1, column: 1 };

function serializeStep(step: StepRecord): ReportStep {
  const { error, ...rest } = step;
  return {
    ...rest,
    source: UNIMPLEMENTED_STEP_SOURCE,
    error: error === undefined ? undefined : serializeErrorRecord(error),
  };
}

/** SerializedError minus the stack, which never enters the report. */
function serializeErrorRecord(error: SerializedError): ReportError {
  const { stack, ...report } = error;
  void stack;
  return report;
}

function serializeAttemptBase(attempt: AttemptRecord | SerialAttemptRecord): ReportAttemptBase {
  return {
    id: attempt.id,
    index: attempt.index,
    status: attempt.status,
    startedAt: attempt.startedAt,
    durationMs: attempt.durationMs,
    artifacts: attempt.artifacts,
    error: attempt.error === undefined ? undefined : serializeErrorRecord(attempt.error),
    secondaryErrors: attempt.secondaryErrors.map(serializeErrorRecord),
    cleanup: attempt.cleanup,
  };
}

function serializeAttempt(attempt: AttemptRecord): ReportAttempt {
  return { ...serializeAttemptBase(attempt), steps: attempt.steps.map(serializeStep) };
}

function serializeSerialMember(member: SerialMemberRecord): ReportSerialMember {
  return {
    id: member.id,
    index: member.index,
    testId: member.testId,
    status: member.status,
    startedAt: member.startedAt,
    durationMs: member.durationMs,
    steps: member.status === 'skipped' ? [] : member.steps.map(serializeStep),
    error: member.error === undefined ? undefined : serializeErrorRecord(member.error),
    skip: member.status === 'skipped' ? member.skip : undefined,
    secondaryErrors: member.secondaryErrors.map(serializeErrorRecord),
  };
}

function serializeSerialAttempt(attempt: SerialAttemptRecord): ReportSerialAttempt {
  return { ...serializeAttemptBase(attempt), members: attempt.members.map(serializeSerialMember) };
}

function serializeSerialGroup(group: SerialGroupRecord): ReportSerialGroup {
  return {
    id: group.id,
    serialId: group.serialId,
    declarationIndex: group.declarationIndex,
    file: group.file,
    source: { file: group.file, line: 1, column: 1 },
    titlePath: group.titlePath,
    targetId: group.targetId,
    platform: group.platform,
    agent: group.agent,
    memberTestIds: group.memberTestIds,
    status: group.status,
    skip: group.status === 'skipped' ? group.skip : undefined,
    attempts: group.attempts.map(serializeSerialAttempt),
  };
}

function serializeResult(config: ResolvedConfig | undefined, result: ResultRecord): ReportResult {
  return {
    id: resultId(result.test.id, result.target.name, result.agent),
    testId: result.test.id,
    kind: result.test.kind,
    declarationIndex: result.test.declarationIndex,
    titlePath: result.test.titlePath,
    file: result.test.file,
    source: relativeSource(config, result.test.source, result.test.file),
    targetId: result.target.name,
    platform: result.target.platform,
    agent: result.agent,
    serialGroupId: result.serialGroupId,
    status: result.status,
    skip: result.status === 'skipped' ? result.skip : undefined,
    attempts: result.serialGroupId !== undefined ? [] : result.attempts.map(serializeAttempt),
  };
}

function serializeTarget(
  config: ResolvedConfig,
  target: ResolvedTarget,
  provenance: TargetProvenance | undefined,
): ReportTarget {
  // Provenance exists for every selected target; an unselected one is
  // described from its declaration the same way.
  return {
    ...obj({
      id: target.name,
      index: target.index,
      platform: target.platform,
      baseOrigin: target.app.base?.origin,
      environment: target.app.environment,
      testIdAttribute: config.testIdAttribute,
    }),
    ...(provenance ?? describeTarget(target)),
  };
}

/** Computes report-1 summary counts from results. */
function computeSummary(results: readonly ResultRecord[]): ReportSummary {
  let selected = 0;
  let executed = 0;
  let passed = 0;
  let failed = 0;
  let flaky = 0;
  let skipped = 0;
  for (const result of results) {
    if (result.selected) selected += 1;
    if (result.attempts.length > 0 || (result.serialGroupId !== undefined && result.status !== 'skipped')) {
      executed += 1;
    }
    switch (result.status) {
      case 'passed':
        passed += 1;
        break;
      case 'flaky':
        flaky += 1;
        break;
      case 'failed':
      case 'timed-out':
      case 'interrupted':
        failed += 1;
        break;
      case 'skipped':
        skipped += 1;
        break;
    }
  }
  return { discovered: results.length, selected, executed, passed, failed, flaky, skipped };
}

/**
 * A run is `blocked` — not failed — when it did not pass and *every*
 * non-passing result carries a blockable error code: credentials, the
 * environment, or the agent's own budget prevented a product verdict, and
 * nothing contradicts that. One genuine failure keeps the run failed, and so
 * does any run-level error (a launch that never came up, a cleanup or report
 * write that failed): it is its own fact about the run, not a blocked step,
 * and it must stay visible to a host reading the status. Derivation requires
 * positive evidence, never absence of it.
 */
function deriveRunStatus(
  status: BuildReportOptions['status'],
  results: readonly ResultRecord[],
  serialGroups: readonly SerialGroupRecord[],
  runErrors: readonly RunError[],
): BuildReportOptions['status'] | 'blocked' {
  if (status !== 'failed' && status !== 'error') return status;
  if (runErrors.length > 0) return status;
  // Serial members carry no attempts of their own; their failing error lives
  // on the group's last attempt (or its failing member).
  const groupCode = new Map<string, string | undefined>();
  for (const group of serialGroups) {
    const attempt = group.attempts.at(-1);
    const member = attempt?.members.find(
      (candidate) => candidate.status !== 'passed' && candidate.status !== 'skipped',
    );
    groupCode.set(group.id, member?.error?.code ?? attempt?.error?.code);
  }
  let sawFailure = false;
  for (const result of results) {
    if (
      result.status !== 'failed' &&
      result.status !== 'timed-out' &&
      result.status !== 'interrupted'
    ) {
      continue;
    }
    sawFailure = true;
    const code =
      result.serialGroupId === undefined
        ? result.attempts.at(-1)?.error?.code
        : groupCode.get(result.serialGroupId);
    if (code === undefined || !BLOCKABLE_CODES.has(code as AgentErrorCode)) return status;
  }
  return sawFailure ? 'blocked' : status;
}

/**
 * Fallback limits used when the run failed before config resolution: the
 * resolver's own defaults, so the report never disagrees with the config.
 */
const DEFAULT_LIMITS: ReportLimits = {
  ...resolveLimits({}),
  maxObservationBytes: DEFAULT_OBSERVATION_BYTES,
};

/** Aggregates observed usage against the resolved limits. */
function computeUsage(options: {
  results: readonly ResultRecord[];
  serialGroups: readonly SerialGroupRecord[];
  discovered: number;
}): ReportUsage {
  const usage: ReportUsage = {
    discoveredResults: options.discovered,
    maxAgentContextBytes: 0,
    maxLedgerBytes: 0,
    maxObservationBytes: 0,
    artifactBytes: 0,
    downloads: 0,
    events: 0,
    modelTokens: 0,
    maxModelCallsInStep: 0,
    maxActionStepsInStep: 0,
  };
  let cost = 0;
  let costSeen = false;
  let cachedTokens: number | undefined;

  const countStep = (step: StepRecord): void => {
    usage.events += step.events.length;
    const metrics = step.metrics;
    if (metrics !== undefined) {
      usage.maxAgentContextBytes = Math.max(usage.maxAgentContextBytes, metrics.contextBytes);
      usage.maxLedgerBytes = Math.max(usage.maxLedgerBytes, metrics.ledgerBytes);
      usage.maxObservationBytes = Math.max(usage.maxObservationBytes, metrics.observationBytes);
      usage.maxModelCallsInStep = Math.max(usage.maxModelCallsInStep, metrics.modelCalls);
      usage.maxActionStepsInStep = Math.max(usage.maxActionStepsInStep, metrics.actionSteps);
    }
    const model = step.model;
    if (model !== undefined) {
      usage.modelTokens = Math.min(Number.MAX_SAFE_INTEGER, usage.modelTokens + model.inputTokens + model.outputTokens);
      if (model.cacheReadTokens !== undefined) {
        cachedTokens = Math.min(Number.MAX_SAFE_INTEGER, (cachedTokens ?? 0) + model.cacheReadTokens);
      }
      if (model.estimatedCostUsd !== undefined) {
        cost += model.estimatedCostUsd;
        costSeen = true;
      }
    }
  };

  const countArtifacts = (artifacts: readonly ArtifactRecord[]): void => {
    for (const artifact of artifacts) {
      usage.artifactBytes += artifact.size ?? 0;
      if (artifact.kind === 'download') usage.downloads += 1;
    }
  };

  for (const result of options.results) {
    for (const attempt of result.attempts) {
      countArtifacts(attempt.artifacts);
      for (const step of attempt.steps) countStep(step);
    }
  }
  for (const group of options.serialGroups) {
    for (const attempt of group.attempts) {
      countArtifacts(attempt.artifacts);
      for (const member of attempt.members) {
        for (const step of member.steps) countStep(step);
      }
    }
  }

  return {
    ...usage,
    ...(cachedTokens === undefined ? {} : { modelCachedTokens: cachedTokens }),
    ...(costSeen && Number.isFinite(cost) ? { estimatedCostUsd: cost } : {}),
  };
}

/** Builds the complete report-1 document. */
export function buildReport(options: BuildReportOptions): Report1Document {
  const { config } = options;
  const targets =
    config === undefined
      ? []
      : config.targets.map((target) =>
          serializeTarget(config, target, options.targetProvenance.get(target.name)),
        );

  const results = options.results
    .toSorted(compareResults)
    .map((result) => serializeResult(config, result));

  const targetIndex = new Map<string, number>();
  for (const target of config?.targets ?? []) targetIndex.set(target.name, target.index);
  const serialGroups = options.serialGroups
    .toSorted((a, b) => compareSerialGroups(a, b, targetIndex))
    .map(serializeSerialGroup);

  const summary = computeSummary(options.results);

  return {
    schemaVersion: 'report-1',
    run: {
      id: options.runId,
      specVersion: '0.1',
      runner: {
        name: 'e2e',
        version: packageVersion(import.meta.url, '../../package.json', '0.0.0'),
      },
      status: deriveRunStatus(options.status, options.results, options.serialGroups, options.runErrors),
      exitCode: options.exitCode,
      startedAt: options.startedAt,
      finishedAt: timestamp(),
      project: {
        id: config?.projectId ?? 'unknown',
        configDigest: config?.configDigest ?? '0'.repeat(64),
      },
      environment: {
        ci: config?.ci ?? false,
        // The trust model is documented and report-recorded, never printed.
        trustNoticeShown: false,
        os: `${os.platform()} ${os.release()}`,
        arch: os.arch(),
        runtime: `node ${process.version}`,
      },
      targets,
      serialGroups,
      results,
      errors: options.runErrors.map((runError) => serializeErrorRecord(runError.error)),
      summary,
      limits: config?.limits ?? DEFAULT_LIMITS,
      usage: computeUsage({
        results: options.results,
        serialGroups: options.serialGroups,
        discovered: summary.discovered,
      }),
      ...(options.explore === undefined ? {} : { explore: options.explore }),
    },
  };
}

function compareResults(a: ResultRecord, b: ResultRecord): number {
  if (a.test.file !== b.test.file) return a.test.file < b.test.file ? -1 : 1;
  if (a.test.declarationIndex !== b.test.declarationIndex) {
    return a.test.declarationIndex - b.test.declarationIndex;
  }
  return a.target.index - b.target.index;
}

/** Report order is completion-time independent. */
function compareSerialGroups(
  a: SerialGroupRecord,
  b: SerialGroupRecord,
  targetIndex: ReadonlyMap<string, number>,
): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.declarationIndex !== b.declarationIndex) return a.declarationIndex - b.declarationIndex;
  return (targetIndex.get(a.targetId) ?? 0) - (targetIndex.get(b.targetId) ?? 0);
}
