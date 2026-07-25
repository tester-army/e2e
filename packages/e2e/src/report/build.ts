/** report-1 document construction (spec 13-reporting.md). */

import os from 'node:os';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.js';
import type { ErrorCategory, ErrorPhase, SerializedError } from '../internal/errors.js';
import { resultId, timestamp } from '../internal/ids.js';
import { packageVersion } from '../internal/package-version.js';
import type { SkipInfo } from '../collect/select.js';
import type {
  ArtifactRecord,
  AttemptRecord,
  ResultRecord,
  RunError,
  SerialAttemptRecord,
  SerialGroupRecord,
  SerialMemberRecord,
} from '../run/records.js';
import type { StepRecord } from '../run/steps.js';

export interface ReportSource {
  file: string;
  line: number;
  column: number;
}

export interface TargetProvenance {
  browserVersion: string;
  viewport: { width: number; height: number; scale: number };
  driver: { id: string; version: string; spiVersion: 1 };
  capabilities: string[];
  artifactCapabilities: ('screenshot' | 'trace' | 'video')[];
  stateCapability: boolean;
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
  trustNoticeShown: boolean;
}

// --- report-1 wire shapes (spec/schema/report-v1.schema.json) ---
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
  events: readonly never[];
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
  serialGroupId?: string | undefined;
  status: ResultRecord['status'];
  skip?: SkipInfo | undefined;
  attempts: readonly ReportAttempt[];
}

export interface ReportTarget {
  id: string;
  index: number;
  platform: string;
  browser: string | undefined;
  browserVersion: string;
  viewport: { width: number; height: number; scale: number };
  baseOrigin: string;
  environment: string;
  allowProduction: boolean;
  testIdAttribute: string;
  driver: { id: string; version: string; spiVersion: 1 };
  capabilities: readonly string[];
  artifactCapabilities: readonly string[];
  stateCapability: boolean;
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
    status: BuildReportOptions['status'];
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
    limits: typeof DEFAULT_LIMITS;
    usage: Record<string, number>;
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

/** Step source capture and events are not implemented yet (spec 13-reporting.md). */
const UNIMPLEMENTED_STEP_SOURCE: ReportSource = { file: 'unknown', line: 1, column: 1 };

function serializeStep(step: StepRecord): ReportStep {
  const { error, ...rest } = step;
  return {
    ...rest,
    source: UNIMPLEMENTED_STEP_SOURCE,
    events: [],
    error: error === undefined ? undefined : serializeErrorRecord(error),
  };
}

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
    skip: member.skip,
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
    memberTestIds: group.memberTestIds,
    status: group.status,
    skip: group.skip,
    attempts: group.attempts.map(serializeSerialAttempt),
  };
}

function serializeResult(config: ResolvedConfig | undefined, result: ResultRecord): ReportResult {
  return {
    id: resultId(result.test.id, result.target.name),
    testId: result.test.id,
    kind: result.test.kind,
    declarationIndex: result.test.declarationIndex,
    titlePath: result.test.titlePath,
    file: result.test.file,
    source: relativeSource(config, result.test.source, result.test.file),
    targetId: result.target.name,
    platform: result.target.platform,
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
  return {
    id: target.name,
    index: target.index,
    platform: target.platform,
    browser: target.browser,
    browserVersion: provenance?.browserVersion ?? 'unknown',
    viewport: provenance?.viewport ?? {
      width: target.viewport?.width ?? 1280,
      height: target.viewport?.height ?? 720,
      scale: 1,
    },
    baseOrigin: config.app.base.origin,
    environment: config.app.environment,
    allowProduction: config.app.allowProduction,
    testIdAttribute: config.testIdAttribute,
    driver: provenance?.driver ?? { id: 'playwright', version: 'unknown', spiVersion: 1 },
    capabilities: provenance?.capabilities ?? ['web'],
    artifactCapabilities: provenance?.artifactCapabilities ?? ['screenshot', 'trace'],
    stateCapability: provenance?.stateCapability ?? true,
  };
}

/** Computes report-1 summary counts from results. */
export function computeSummary(results: readonly ResultRecord[]): ReportSummary {
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

const DEFAULT_LIMITS = {
  maxDiscoveredResults: 100_000,
  maxCacheBytes: 262_144,
  maxTerminalFieldBytes: 8_192,
  maxAgentContextBytes: 16_384,
  maxLedgerBytes: 8_192,
  maxObservationBytes: 1_048_576,
  maxArtifactBytes: 104_857_600,
  maxArtifactTotalBytes: 1_073_741_824,
  maxDownloadBytes: 104_857_600,
  maxDownloads: 10,
  maxReportBytes: 52_428_800,
  maxEventsPerStep: 1_000,
  maxModelTokensPerCall: 64_000,
  maxModelCallsPerStep: 25,
  maxActionStepsPerStep: 25,
};

/** Builds the complete report-1 document. */
export function buildReport(options: BuildReportOptions): Report1Document {
  const { config } = options;
  const targets =
    config === undefined
      ? []
      : config.targets.map((target) =>
          serializeTarget(config, target, options.targetProvenance.get(target.name)),
        );

  const results = [...options.results]
    .sort(compareResults)
    .map((result) => serializeResult(config, result));

  const summary = computeSummary(options.results);
  const artifactBytes = options.results
    .flatMap((result) => result.attempts)
    .flatMap((attempt) => attempt.artifacts)
    .reduce((total, artifact) => total + (artifact.size ?? 0), 0);

  return {
    schemaVersion: 'report-1',
    run: {
      id: options.runId,
      specVersion: '0.1',
      runner: {
        name: 'e2e',
        version: packageVersion(import.meta.url, '../../package.json', '0.0.0'),
      },
      status: options.status,
      exitCode: options.exitCode,
      startedAt: options.startedAt,
      finishedAt: timestamp(),
      project: {
        id: config?.projectId ?? 'unknown',
        configDigest: config?.configDigest ?? '0'.repeat(64),
      },
      environment: {
        ci: config?.ci ?? false,
        trustNoticeShown: options.trustNoticeShown,
        os: `${os.platform()} ${os.release()}`,
        arch: os.arch(),
        runtime: `node ${process.version}`,
      },
      targets,
      serialGroups: options.serialGroups.map(serializeSerialGroup),
      results,
      errors: options.runErrors.map((runError) => serializeErrorRecord(runError.error)),
      summary,
      limits: DEFAULT_LIMITS,
      usage: {
        discoveredResults: summary.discovered,
        maxCacheEntryBytes: 0,
        maxTerminalFieldBytes: 0,
        maxAgentContextBytes: 0,
        maxLedgerBytes: 0,
        maxObservationBytes: 0,
        artifactBytes,
        downloads: 0,
        reportBytes: 0,
        events: 0,
        modelTokens: 0,
        maxModelCallsInStep: 0,
        maxActionStepsInStep: 0,
      },
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
