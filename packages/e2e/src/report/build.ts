/** report-1 document construction (spec 13-reporting.md). */

import { createRequire } from 'node:module';
import os from 'node:os';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.js';
import type { SerializedError } from '../internal/errors.js';
import { resultId, timestamp } from '../internal/ids.js';
import type {
  ArtifactRecord,
  AttemptRecord,
  ResultRecord,
  RunError,
  SerialGroupRecord,
} from '../run/execute.js';
import type { StepRecord } from '../run/steps.js';

const require = createRequire(import.meta.url);

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

interface JsonRecord {
  [key: string]: unknown;
}

function runnerVersion(): string {
  try {
    return (require('../../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

function relativeSource(config: ResolvedConfig | undefined, source: { file: string; line: number; column: number } | undefined, fallbackFile: string): ReportSource {
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

function serializeStep(step: StepRecord): JsonRecord {
  return {
    id: step.id,
    index: step.index,
    kind: step.kind,
    api: step.api,
    label: step.label,
    source: { file: 'unknown', line: 1, column: 1 },
    status: step.status,
    startedAt: step.startedAt,
    durationMs: step.durationMs,
    events: [],
    ...(step.error !== undefined ? { error: serializeErrorRecord(step.error) } : {}),
    artifacts: step.artifacts,
  };
}

function serializeErrorRecord(error: SerializedError): JsonRecord {
  return {
    category: error.category,
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.phase !== undefined ? { phase: error.phase } : {}),
    ...(error.scopeId !== undefined ? { scopeId: error.scopeId } : {}),
  };
}

function serializeArtifact(artifact: ArtifactRecord): JsonRecord {
  return {
    id: artifact.id,
    kind: artifact.kind,
    mediaType: artifact.mediaType,
    ...(artifact.path !== undefined ? { path: artifact.path } : {}),
    ...(artifact.size !== undefined ? { size: artifact.size } : {}),
    ...(artifact.sha256 !== undefined ? { sha256: artifact.sha256 } : {}),
    redaction: artifact.redaction,
    producer: artifact.producer,
  };
}

function serializeAttempt(attempt: AttemptRecord): JsonRecord {
  return {
    id: attempt.id,
    index: attempt.index,
    status: attempt.status,
    startedAt: attempt.startedAt,
    durationMs: attempt.durationMs,
    steps: attempt.steps.map(serializeStep),
    artifacts: attempt.artifacts.map(serializeArtifact),
    ...(attempt.error !== undefined ? { error: serializeErrorRecord(attempt.error) } : {}),
    secondaryErrors: attempt.secondaryErrors.map(serializeErrorRecord),
    cleanup: attempt.cleanup,
  };
}

/** Computes report-1 summary counts from results. */
export function computeSummary(results: readonly ResultRecord[]): {
  discovered: number;
  selected: number;
  executed: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
} {
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
export function buildReport(options: BuildReportOptions): JsonRecord {
  const { config } = options;
  const targets = (config?.targets ?? []).map((target: ResolvedTarget) => {
    const provenance = options.targetProvenance.get(target.name);
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
      baseOrigin: config?.app.base.origin ?? 'http://localhost',
      environment: config?.app.environment ?? 'test',
      allowProduction: config?.app.allowProduction ?? false,
      testIdAttribute: config?.testIdAttribute ?? 'data-testid',
      driver: provenance?.driver ?? { id: 'playwright', version: 'unknown', spiVersion: 1 as const },
      capabilities: provenance?.capabilities ?? ['web'],
      artifactCapabilities: provenance?.artifactCapabilities ?? ['screenshot', 'trace'],
      stateCapability: provenance?.stateCapability ?? true,
    };
  });

  const sortedResults = [...options.results].sort(compareResults);
  const results = sortedResults.map((result) => {
    const source = relativeSource(config, result.test.source, result.test.file);
    return {
      id: resultId(result.test.id, result.target.name),
      testId: result.test.id,
      kind: result.test.kind,
      declarationIndex: result.test.declarationIndex,
      titlePath: result.test.titlePath,
      file: result.test.file,
      source,
      targetId: result.target.name,
      platform: result.target.platform,
      ...(result.serialGroupId !== undefined ? { serialGroupId: result.serialGroupId } : {}),
      status: result.status,
      ...(result.status === 'skipped' && result.skip !== undefined
        ? {
            skip: {
              cause: result.skip.cause,
              reason: result.skip.reason,
              ...(result.skip.relatedId !== undefined ? { relatedId: result.skip.relatedId } : {}),
            },
          }
        : {}),
      attempts: result.serialGroupId !== undefined ? [] : result.attempts.map(serializeAttempt),
    };
  });

  const serialGroups = options.serialGroups.map((group) => ({
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
    ...(group.skip !== undefined ? { skip: group.skip } : {}),
    attempts: group.attempts.map((attempt) => ({
      id: attempt.id,
      index: attempt.index,
      status: attempt.status,
      startedAt: attempt.startedAt,
      durationMs: attempt.durationMs,
      members: attempt.members.map((member) => ({
        id: member.id,
        index: member.index,
        testId: member.testId,
        status: member.status,
        startedAt: member.startedAt,
        durationMs: member.durationMs,
        steps: member.status === 'skipped' ? [] : member.steps.map(serializeStep),
        ...(member.error !== undefined ? { error: serializeErrorRecord(member.error) } : {}),
        ...(member.skip !== undefined ? { skip: member.skip } : {}),
        secondaryErrors: member.secondaryErrors.map(serializeErrorRecord),
      })),
      artifacts: attempt.artifacts.map(serializeArtifact),
      ...(attempt.error !== undefined ? { error: serializeErrorRecord(attempt.error) } : {}),
      secondaryErrors: attempt.secondaryErrors.map(serializeErrorRecord),
      cleanup: attempt.cleanup,
    })),
  }));

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
      runner: { name: 'e2e', version: runnerVersion() },
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
      serialGroups,
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
