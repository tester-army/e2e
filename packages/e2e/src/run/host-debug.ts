/** Immutable hosted-session report and SDK-recorded evidence manifest. */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ENGINE_ERROR_CODES } from '../engine/contract.ts';
import { sanitizeText } from '../internal/errors.ts';
import { bound } from '../internal/text.ts';
import type { Report1Document, ReportError, ReportStep } from '../report/build.ts';
import { anchorArtifactFile, artifactAnchorCurrent, originalArtifactFile, relativeArtifactPath } from './artifact-path.ts';
import type { AttemptArtifacts } from './artifacts.ts';
import type { ArtifactRecord } from './records.ts';

/** JSON report data, recursively read-only at compile time and frozen at runtime. */
export type ImmutableReport = Immutable<Report1Document>;

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;

export interface DebugArtifact {
  readonly id: string;
  readonly kind: ArtifactRecord['kind'];
  readonly mediaType: string;
  readonly stepIds: readonly string[];
  /** Explicit SDK-owned checkpoint identity; absent for ordinary captures. IDs are nonempty, control-free, at most 1024 UTF-8 bytes, never inferred or clipped. */
  readonly checkpoint?: { readonly id: string; readonly phase: 'before' | 'after'; readonly observationId: string | null };
  /** Actual registered capture revision, at most 1024 UTF-8 bytes; null when unknown or unproven. */
  readonly observationRevision: string | null;
  readonly evidence: { readonly status: 'available'; readonly path: string; readonly size: number; readonly sha256: string }
    | { readonly status: 'missing' | 'withheld'; readonly reason: 'not-retained' | 'unsafe-path' | 'changed-file' | 'incomplete-redaction' | 'non-sdk-evidence' | 'read-failed' };
}

export interface SessionDebugBundle {
  readonly schemaVersion: 'session-debug-1';
  readonly report: ImmutableReport;
  /** Paths resolve against E2ESession.artifactsDir, not cwd or the report's results root. */
  readonly artifacts: readonly DebugArtifact[];
  readonly evidence: readonly {
    readonly stepId: string;
    readonly semantic: 'summary' | 'not-recorded';
    readonly reasoning: 'recorded' | 'not-recorded';
    readonly turns: 'recorded' | 'not-recorded';
    readonly checkpoints: 'recorded' | 'not-recorded';
  }[];
  readonly trace: 'written' | 'failed';
}

/** Closed engine taxonomy and SDK-hosted failure codes, never freeform error text. */
const HOST_ERROR_CODES = new Set<string>([...ENGINE_ERROR_CODES, 'ACTION_FAILED', 'APP_NOT_OPEN', 'ASSERTION_FAILED', 'CLEANUP_TIMEOUT', 'ERROR', 'LOCATOR_AMBIGUOUS', 'LOCATOR_NOT_FOUND', 'POLICY_DENIED', 'TEST_TIMEOUT', 'WORKER_PROTOCOL']);

/** Hosted report-1 enum/constant locations. Only these declared tokens bypass prose redaction. */
const STRUCTURAL_REPORT_TOKENS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['.run.runner.name', new Set(['e2e'])],
  ['.run.errors[].category', new Set(['configuration', 'infrastructure', 'internal', 'interrupted', 'test'])],
  ['.run.errors[].phase', new Set(['afterAll', 'afterEach', 'beforeAll', 'beforeEach', 'body', 'cleanup', 'collection', 'config', 'launch', 'report'])],
  ['.run.results[].attempts[].appLog[].level', new Set(['error', 'info', 'warning'])],
  ['.run.results[].attempts[].appLog[].source', new Set(['console', 'error', 'network', 'system'])],
  ['.run.results[].attempts[].artifacts[].kind', new Set(['download', 'log', 'other', 'screenshot', 'video'])],
  ['.run.results[].attempts[].artifacts[].producer.kind', new Set(['attempt', 'step'])],
  ['.run.results[].attempts[].artifacts[].redaction', new Set(['complete', 'incomplete'])],
  ['.run.results[].attempts[].cleanup', new Set(['complete', 'failed', 'forced'])],
  ['.run.results[].attempts[].error.category', new Set(['configuration', 'infrastructure', 'internal', 'interrupted', 'test'])],
  ['.run.results[].attempts[].error.phase', new Set(['afterAll', 'afterEach', 'beforeAll', 'beforeEach', 'body', 'cleanup', 'collection', 'config', 'launch', 'report'])],
  ['.run.results[].attempts[].hostedOutcome.external.actual', new Set(['failed', 'interrupted', 'passed', 'skipped', 'timed-out'])],
  ['.run.results[].attempts[].hostedOutcome.external.expected', new Set(['failed', 'interrupted', 'passed', 'skipped', 'timed-out'])],
  ['.run.results[].attempts[].hostedOutcome.sdkStatus', new Set(['failed', 'interrupted', 'passed', 'skipped', 'timed-out'])],
  ['.run.results[].attempts[].hostedOutcome.status', new Set(['failed', 'interrupted', 'passed', 'skipped', 'timed-out'])],
  ['.run.results[].attempts[].secondaryErrors[].category', new Set(['configuration', 'infrastructure', 'internal', 'interrupted', 'test'])],
  ['.run.results[].attempts[].secondaryErrors[].phase', new Set(['afterAll', 'afterEach', 'beforeAll', 'beforeEach', 'body', 'cleanup', 'collection', 'config', 'launch', 'report'])],
  ['.run.results[].attempts[].skip.cause', new Set(['capability-unavailable', 'explicit', 'failure-limit', 'filtered', 'hook-failed', 'infrastructure-unavailable', 'platform-unavailable', 'serial-predecessor-failed', 'setup-failed'])],
  ['.run.results[].attempts[].status', new Set(['failed', 'interrupted', 'passed', 'skipped', 'timed-out'])],
  ['.run.results[].attempts[].steps[].cache.derived', new Set(['date', 'minted-token', 'pixels', 'whole-node'])],
  ['.run.results[].attempts[].steps[].cache.mode', new Set(['agent-concluded', 'missed', 'self-finalized'])],
  ['.run.results[].attempts[].steps[].cache.notRecorded', new Set(['param-collision'])],
  ['.run.results[].attempts[].steps[].cache.reason', new Set(['action-failed', 'action-uncertain', 'end-mismatch', 'gap', 'invalid-entry', 'no-entry', 'retry', 'target-ambiguous', 'target-not-found', 'truncated', 'viewport-changed', 'wrong-context'])],
  ['.run.results[].attempts[].steps[].cache.write', new Set(['evicted', 'kept', 'no-change', 'not-written', 'saved', 'unconfirmed'])],
  ['.run.results[].attempts[].steps[].error.category', new Set(['configuration', 'infrastructure', 'internal', 'interrupted', 'test'])],
  ['.run.results[].attempts[].steps[].error.phase', new Set(['afterAll', 'afterEach', 'beforeAll', 'beforeEach', 'body', 'cleanup', 'collection', 'config', 'launch', 'report'])],
  ['.run.results[].attempts[].steps[].events[].decision', new Set(['allowed', 'denied'])],
  ['.run.results[].attempts[].steps[].events[].kind', new Set(['engine', 'model', 'navigation', 'observation', 'policy', 'poll', 'schema', 'tool-proposal'])],
  ['.run.results[].attempts[].steps[].events[].status', new Set(['cancelled', 'failed', 'passed'])],
  ['.run.results[].attempts[].steps[].kind', new Set(['agent', 'app', 'assertion', 'locator', 'resource', 'screen', 'session'])],
  ['.run.results[].attempts[].steps[].model.endpoint', new Set(['local', 'provider-default'])],
  ['.run.results[].attempts[].steps[].model.tokenAccounting', new Set(['adapter-upper-bound', 'provider'])],
  ['.run.results[].attempts[].steps[].phase', new Set(['afterEach', 'beforeEach'])],
  ['.run.results[].attempts[].steps[].status', new Set(['blocked', 'cancelled', 'failed', 'passed', 'timed-out'])],
  ['.run.results[].attempts[].steps[].visionDegraded', new Set(['MASKING_UNPROVEN', 'PIXEL_TAINTED', 'UNSUPPORTED_CAPABILITY'])],
  ['.run.results[].kind', new Set(['setup', 'test'])],
  ['.run.results[].skip.cause', new Set(['capability-unavailable', 'explicit', 'failure-limit', 'filtered', 'hook-failed', 'infrastructure-unavailable', 'platform-unavailable', 'serial-predecessor-failed', 'setup-failed'])],
  ['.run.results[].status', new Set(['failed', 'flaky', 'interrupted', 'passed', 'skipped', 'timed-out'])],
  ['.run.specVersion', new Set(['0.1'])],
  ['.run.status', new Set(['blocked', 'error', 'failed', 'interrupted', 'passed'])],
  ['.run.targets[].artifactCapabilities[]', new Set(['screenshot', 'video'])],
  ['.run.targets[].capabilities[]', new Set(['observation', 'actions', 'location', 'pointer', 'keyboard', 'state', 'artifacts'])],
  ['.run.targets[].environment', new Set(['production', 'staging', 'test'])],
  ['.schemaVersion', new Set(['report-1'])],
  ...['.run.errors[]', '.run.results[].attempts[].error', '.run.results[].attempts[].secondaryErrors[]', '.run.results[].attempts[].steps[].error'].map((location) => [location + '.code', HOST_ERROR_CODES] as const),
]);

/** Timestamps and derived digests are schema-shaped facts, not user prose. */
const STRUCTURAL_REPORT_FACTS: ReadonlySet<string> = new Set([
  '.run.finishedAt',
  '.run.project.configDigest',
  '.run.results[].attempts[].appLog[].at',
  '.run.results[].attempts[].artifacts[].sha256',
  '.run.results[].attempts[].artifacts[].startedAt',
  '.run.results[].attempts[].startedAt',
  '.run.results[].attempts[].steps[].cache.entry',
  '.run.results[].attempts[].steps[].events[].startedAt',
  '.run.results[].attempts[].steps[].startedAt',
  '.run.startedAt',
  '.run.vcs.commit',
]);

/** Copies report JSON, sanitizes prose without rewriting wire constants, and freezes every nested value. */
export function immutableReport(report: Report1Document, redact: (text: string) => string, options: { providerSecrets?: boolean; unresolvedSecrets?: boolean; prospectiveSecrets?: boolean; artifacts?: AttemptArtifacts } = {}): ImmutableReport {
  const projected = {
    ...report,
    run: {
      ...report.run,
      results: report.run.results.map((result) => ({
        ...result,
        attempts: result.attempts.map((attempt) => ({
          ...attempt,
          error: attempt.error === undefined ? undefined : reportError(attempt.error),
          secondaryErrors: attempt.secondaryErrors.map(reportError),
          steps: attempt.steps.map(reportStep),
          appLog: attempt.appLog?.map((line) => pick(line, ['source', 'level', 'text', 'at', 'step'])),
        })),
      })),
    },
  };
  const detached = JSON.parse(JSON.stringify(projected)) as Report1Document;
  // A masked URI is neither its original address nor a truthful new endpoint.
  // endpoint is required inside the optional model record, so omit that record.
  const unsafeUri = (uri: string): boolean => options.unresolvedSecrets === true || options.prospectiveSecrets === true || sanitizeText(redact(uri)) !== uri;
  for (const target of detached.run.targets) {
    if (target.baseOrigin !== undefined && unsafeUri(target.baseOrigin)) delete target.baseOrigin;
  }
  for (const result of detached.run.results) for (const attempt of result.attempts) {
    for (const step of attempt.steps) {
      const endpoint = step.model?.endpoint;
      if (endpoint !== undefined && endpoint !== 'local' && endpoint !== 'provider-default' && unsafeUri(endpoint)) delete step.model;
    }
  }
  const facts = new Map<string, string>();
  for (const [resultIndex, result] of detached.run.results.entries()) for (const [attemptIndex, attempt] of result.attempts.entries()) {
    const removed = new Set<string>();
    attempt.artifacts = attempt.artifacts.filter((artifact) => {
      const media = registeredMedia(artifact, options.artifacts);
      if (media !== undefined && media === artifact.mediaType) return true;
      if (options.unresolvedSecrets === true || options.prospectiveSecrets === true || sanitizeText(redact(artifact.mediaType)) !== artifact.mediaType) {
        removed.add(artifact.id);
        return false;
      }
      return true;
    });
    for (const [index, artifact] of attempt.artifacts.entries()) {
      if (sdkUnavailableFacts(artifact, options.artifacts)) {
        const association = options.artifacts!.debugCheckpoints.get(artifact.id)!;
        const step = attempt.steps.find((candidate) => artifact.producer.kind === 'step' && candidate.id === artifact.producer.stepId);
        const relative = options.artifacts!.debugPaths.get(artifact.id);
        const original = options.artifacts!.records.find((candidate) => candidate.id === artifact.id);
        if (step !== undefined && relative === `debug/step-${step.index}-${association.phase}.json` &&
            artifact.path !== undefined && artifact.path === original?.path && relativeArtifactPath(artifact.path) && sanitizeText(redact(artifact.path)) === artifact.path) {
          facts.set(`.run.results[${resultIndex}].attempts[${attemptIndex}].artifacts[${index}].path`, artifact.path);
        }
      }
      if (registeredMedia(artifact, options.artifacts) === artifact.mediaType) {
        facts.set(`.run.results[${resultIndex}].attempts[${attemptIndex}].artifacts[${index}].mediaType`, artifact.mediaType);
      }
    }
    if (removed.size > 0) {
      for (const step of attempt.steps) step.artifacts = step.artifacts.filter((id) => !removed.has(id));
      if (attempt.failure?.screen !== undefined && removed.has(attempt.failure.screen)) delete attempt.failure.screen;
      if (attempt.failure?.screenshot !== undefined && removed.has(attempt.failure.screenshot)) delete attempt.failure.screenshot;
    }
  }
  // Index facts only after removing unsafe optional artifact rows.
  for (const [location, value] of reportIdentityFacts(detached)) facts.set(location, value);
  return freeze(redactReportText(detached, '', redact, options, facts) as Report1Document);
}

/** Binds media facts to the actual measured registration, not a borrowed artifact ID. */
function registeredMedia(artifact: ArtifactRecord, artifacts: AttemptArtifacts | undefined): string | undefined {
  const original = artifacts?.records.find((record) => record.id === artifact.id);
  if (original === undefined || original.kind !== artifact.kind || original.size !== artifact.size ||
      original.sha256 !== artifact.sha256 || original.producer.kind !== artifact.producer.kind ||
      original.producer.kind === 'step' && (artifact.producer.kind !== 'step' || original.producer.stepId !== artifact.producer.stepId)) return undefined;
  return artifacts?.debugMediaType(artifact.id);
}

/**
 * Carries only the distinct original SDK unavailable ticket. Actual step joins,
 * null capture association and verified JSON bytes are required; public claims
 * and identity shape cannot manufacture this privilege.
 */
function sdkUnavailableFacts(artifact: ArtifactRecord, artifacts: AttemptArtifacts | undefined): boolean {
  if (artifacts?.debugUnavailableProven(artifact.id) !== true || registeredMedia(artifact, artifacts) !== 'application/json' || artifact.kind !== 'log') return false;
  const original = artifacts.records.find((candidate) => candidate.id === artifact.id);
  const association = artifacts.debugCheckpoints.get(artifact.id);
  return original?.producer.kind === 'step' && artifact.producer.kind === 'step' && original.producer.stepId === artifact.producer.stepId &&
    association !== undefined && association.observationId === null && association.observationRevision === null &&
    association.checkpointId === `${original.producer.stepId}:checkpoint:${association.phase}`;
}

/**
 * Public step/progress consumers hold recorder objects. Project their closed
 * fields rather than letting accidental extra properties carry pixels or causes.
 */
function reportStep(step: ReportStep): ReportStep {
  return {
    ...pick(step, ['id', 'index', 'kind', 'api', 'label', 'status', 'startedAt', 'durationMs', 'observationRevision', 'explanation', 'visionInput', 'visionDegraded', 'visionOnly', 'agent', 'phase', 'artifacts']),
    source: pick(step.source, ['file', 'line', 'column']),
    viewport: step.viewport === undefined ? undefined : pick(step.viewport, ['width', 'height', 'scale']),
    metrics: step.metrics === undefined ? undefined : reportMetrics(step.metrics),
    model: step.model === undefined ? undefined : pick(step.model, ['provider', 'model', 'endpoint', 'adapterVersion', 'policyVersion', 'calls', 'tokenAccounting', 'peakTokensPerCall', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'estimatedCostUsd']),
    cache: step.cache === undefined ? undefined : pick(step.cache, ['mode', 'reason', 'derived', 'notRecorded', 'replayedActions', 'totalActions', 'entry', 'detail', 'write']),
    screen: step.screen === undefined ? undefined : pick(step.screen, ['location', 'nodes', 'since', 'changes', 'more']),
    events: step.events.map((event) => pick(event, ['kind', 'startedAt', 'durationMs', 'status', 'name', 'count', 'inputTokens', 'outputTokens', 'bytes', 'decision', 'code', 'detail', 'reasoning'])),
    turns: step.turns?.map((turn) => pick(turn, ['index', 'calls', 'outcome'])),
    error: step.error === undefined ? undefined : reportError(step.error),
  };
}

/** Forwards declared image totals only when bounded, without requiring sibling public types. */
function reportMetrics(metrics: NonNullable<ReportStep['metrics']>): NonNullable<ReportStep['metrics']> {
  const total = 'modelImageBytes' in metrics ? metrics.modelImageBytes : undefined;
  return {
    ...pick(metrics, ['modelCalls', 'actionSteps', 'observationBytes', 'contextBytes', 'ledgerBytes', 'pixelBytes']),
    ...(typeof total === 'number' && Number.isSafeInteger(total) && total >= 0 ? { modelImageBytes: total } : {}),
  };
}

/** Only the report error's closed fields cross out; stacks and external causes never do. */
function reportError(error: ReportError): ReportError {
  return {
    ...pick(error, ['category', 'code', 'message', 'retryable', 'phase', 'scopeId']),
    source: error.source === undefined ? undefined : pick(error.source, ['file', 'line', 'column']),
    scope: error.scope === undefined ? undefined : pick(error.scope, ['file', 'targetId', 'titlePath']),
    details: error.details === undefined ? undefined : pick(error.details, ['locator', 'expected', 'observed', 'matches', 'role', 'name', 'testId', 'waitedMs']),
  };
}

/** Copies known fields without spreading unknown consumer properties. */
function pick<T extends object>(value: T, keys: readonly (keyof T)[]): T {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])) as T;
}

const UUID_V7 = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;

/**
 * Only SDK-owned protocol locations retain identity. Step/artifact references
 * must join their actual attempt, not merely resemble a UUID or digest.
 * Target names, external test IDs, error details and unknown data never qualify.
 */
function reportIdentityFacts(report: Report1Document): Map<string, string> {
  const facts = new Map<string, string>();
  const add = (location: string, value: string, valid: boolean): void => { if (valid) facts.set(location, value); };
  add('.run.id', report.run.id, UUID_V7.test(report.run.id));
  for (const [root, results] of [['.run', report.run.results], ['.run.carried', report.run.carried?.results ?? []]] as const) {
    for (const [resultIndex, result] of results.entries()) {
      const base = `${root}.results[${resultIndex}]`;
      add(base + '.id', result.id, DIGEST.test(result.id));
      for (const [attemptIndex, attempt] of result.attempts.entries()) {
        const prefix = `${base}.attempts[${attemptIndex}]`;
        const ownedAttempt = UUID_V7.test(attempt.id);
        add(prefix + '.id', attempt.id, ownedAttempt);
        if (root === '.run' && ownedAttempt && result.testId === `host:${attempt.id}`) facts.set(base + '.testId', result.testId);
        const steps = new Set(attempt.steps.filter((step) => ownedAttempt && step.id === `${attempt.id}:${step.index}` && Number.isSafeInteger(step.index) && step.index >= 0).map((step) => step.id));
        const artifacts = new Set(attempt.artifacts.filter((artifact) => ownedAttempt && artifact.id.startsWith(`${attempt.id}:artifact:`) && /^(0|[1-9][0-9]*)$/.test(artifact.id.slice(attempt.id.length + 10))).map((artifact) => artifact.id));
        for (const [index, step] of attempt.steps.entries()) {
          const location = `${prefix}.steps[${index}]`;
          add(location + '.id', step.id, steps.has(step.id));
          for (const [reference, id] of step.artifacts.entries()) add(`${location}.artifacts[${reference}]`, id, artifacts.has(id));
        }
        for (const [index, artifact] of attempt.artifacts.entries()) {
          const location = `${prefix}.artifacts[${index}]`;
          add(location + '.id', artifact.id, artifacts.has(artifact.id));
          if (artifact.producer.kind === 'step') add(location + '.producer.stepId', artifact.producer.stepId, steps.has(artifact.producer.stepId));
        }
        for (const key of ['screen', 'screenshot'] as const) {
          const id = attempt.failure?.[key];
          if (id !== undefined) add(prefix + '.failure.' + key, id, artifacts.has(id));
        }
      }
    }
  }
  return facts;
}

/** Hosted report-1 prose bounds. Redaction can expand even an already bounded record. */
const REPORT_TEXT_BOUNDS: ReadonlyMap<string, number> = new Map([
  ['.run.project.id', 256],
  ['.run.vcs.branch', 512],
  ['.run.targets[].engine.name', 256],
  ['.run.targets[].engine.version', 128],
  ['.run.results[].attempts[].appLog[].text', 300],
  ['.run.results[].attempts[].hostedOutcome.external.testId', 256],
  ...([
    ['label', 8192], ['observationRevision', 256], ['explanation', 8192],
    ['events[].name', 256], ['events[].code', 128],
    ['events[].detail', 300], ['events[].reasoning', 600],
    ['cache.detail', 600], ['screen.changes[]', 200],
    ['turns[].calls[]', 512], ['turns[].outcome', 2048],
  ] as [string, number][]).map(([field, limit]) => ['.run.results[].attempts[].steps[].' + field, limit] as const),
  ['.run.results[].attempts[].artifacts[].url', 2048],
  ['.run.results[].attempts[].failure.url', 2048],
  ['.run.results[].attempts[].failure.screen', 128],
  ['.run.results[].attempts[].failure.screenshot', 128],
  ['.run.results[].attempts[].failure.candidates[]', 1024],
  ['.run.results[].attempts[].skip.reason', 8192],
  ['.run.results[].skip.reason', 8192],
  ...['.run.errors[]', '.run.results[].attempts[].error', '.run.results[].attempts[].secondaryErrors[]', '.run.results[].attempts[].steps[].error'].flatMap((error) => [
    [error + '.code', 128], [error + '.message', 8192], [error + '.scopeId', 1024],
    ...['locator', 'expected', 'observed', 'role', 'name', 'testId'].map((field) => [error + '.details.' + field, 2048] as [string, number]),
  ] as [string, number][]),
]);

/** Only arrays declared unique by report-1 lose collisions; ordered evidence retains repetitions. */
const UNIQUE_REPORT_ARRAYS: ReadonlySet<string> = new Set([
  '.run.targets[].capabilities',
  '.run.targets[].artifactCapabilities',
  '.run.results[].tags',
  '.run.serialGroups[].memberTestIds',
  '.run.carried.results[].tags',
  '.run.carried.serialGroups[].memberTestIds',
]);

const WITHHELD_PENDING_TEXT = '[text withheld: secret resolution unproven]';
const WITHHELD_CUT_TEXT = '[text withheld: truncated before final redaction]';
/** Existing recorder/engine cut notices can occur inside a quoted tool call, not only at its end. */
const CUT_TEXT = /…|\.{3}|\[[^\]\n]*(?:truncated|cut)[^\]\n]*\]/iu;

/**
 * A provider can resolve after text was cut. Its unknown suffix was never
 * retained, so neither whole-value matching nor a minimum-size fragment
 * matcher proves that even a one-character prefix is safe. Withhold it.
 * Error serializers cut UTF-8 without a notice; a boundary within three
 * bytes of their cap is equally unproven. No raw text or public provenance
 * is added to recover those cuts.
 */
function unprovenCut(value: string, location: string, limit: number | undefined): boolean {
  if (CUT_TEXT.test(value)) return true;
  const errorText = location.endsWith('.message') || location.includes('.details.');
  return errorText && limit !== undefined && Buffer.byteLength(value, 'utf8') >= limit - 3;
}

/** Redacts data text; schema tokens and generated join identities are facts, not secret-bearing prose. */
function redactReportText(value: unknown, location: string, redact: (text: string) => string, options: { providerSecrets?: boolean; unresolvedSecrets?: boolean; prospectiveSecrets?: boolean }, facts: ReadonlyMap<string, string>): unknown {
  const schemaLocation = location.replace(/\[[0-9]+\]/g, '[]');
  if (typeof value === 'string') {
    if (facts.get(location) === value || STRUCTURAL_REPORT_FACTS.has(schemaLocation) || STRUCTURAL_REPORT_TOKENS.get(schemaLocation)?.has(value) === true) return value;
    const limit = REPORT_TEXT_BOUNDS.get(schemaLocation);
    const text = sanitizeText(redact(options.unresolvedSecrets === true ? WITHHELD_PENDING_TEXT
      : options.providerSecrets === true && unprovenCut(value, schemaLocation, limit) ? WITHHELD_CUT_TEXT
      : options.prospectiveSecrets === true ? WITHHELD_PENDING_TEXT : value));
    return limit === undefined ? text : bound(text, limit);
  }
  if (Array.isArray(value)) {
    const items = value.map((item, index) => redactReportText(item, `${location}[${index}]`, redact, options, facts));
    return UNIQUE_REPORT_ARRAYS.has(schemaLocation) ? [...new Set(items)] : items;
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => {
      // Unknown JSON keys cannot spoof a declared path with dots or brackets.
      const child = /^[a-zA-Z][a-zA-Z0-9]*$/.test(name) ? location + '.' + name : location + '[' + JSON.stringify(name) + ']';
      return [name, redactReportText(item, child, redact, options, facts)];
    }));
  }
  return value;
}

/** Builds an allowlist from registrations alone. No consumer files, URLs, store refs, or filename-derived provenance. */
export async function buildDebugBundle(options: {
  report: ImmutableReport;
  artifacts: AttemptArtifacts;
  resultsDir: string;
  trace: SessionDebugBundle['trace'];
  redact: (text: string) => string;
  unresolvedSecrets?: boolean;
}): Promise<SessionDebugBundle> {
  const report = JSON.parse(JSON.stringify(options.report)) as Report1Document;
  const attempt = report.run.results[0]!.attempts[0]!;
  const manifest: DebugArtifact[] = [];
  const records: ArtifactRecord[] = [];
  const checkpointSteps = new Set<string>();
  // Byte/media admission can remove a report row. Recordedness still comes from
  // its original owned registration and actual attempt step, never a filename.
  for (const original of options.artifacts.records) {
    if (original.producer.kind === 'step' && options.artifacts.debugEvidence.has(original.id) &&
        options.artifacts.debugCheckpoints.has(original.id) && attempt.steps.some((step) => original.producer.kind === 'step' && step.id === original.producer.stepId)) {
      checkpointSteps.add(original.producer.stepId);
    }
  }
  for (const artifact of attempt.artifacts) {
    const stepIds = [...new Set(attempt.steps.filter((step) => step.artifacts.includes(artifact.id) || (artifact.producer.kind === 'step' && artifact.producer.stepId === step.id)).map((step) => step.id))];
    const capture = checkpointAssociation(artifact, stepIds, options);
    if (capture.recorded && artifact.producer.kind === 'step') checkpointSteps.add(artifact.producer.stepId);
    const evidence = capture.unsafe ? { status: 'withheld' as const, reason: 'incomplete-redaction' as const } : await artifactEvidence(artifact, options);
    manifest.push({ id: artifact.id, kind: artifact.kind, mediaType: artifact.mediaType, stepIds,
      ...(capture.checkpoint === undefined ? {} : { checkpoint: capture.checkpoint }),
      observationRevision: capture.revision, evidence });
    const { path: file, url, ref, size, sha256, ...identity } = artifact;
    void file; void url; void ref; void size; void sha256;
    // report-1 permits an unavailable artifact only with incomplete redaction.
    records.push(evidence.status === 'available'
      ? { ...identity, path: artifact.path!, size: evidence.size, sha256: evidence.sha256 }
      : { ...identity, redaction: 'incomplete' });
  }
  attempt.artifacts = records;
  return freeze({
    schemaVersion: 'session-debug-1', report, artifacts: manifest, trace: options.trace,
    evidence: attempt.steps.map((step) => ({
      stepId: step.id, semantic: step.screen === undefined ? 'not-recorded' : 'summary',
      reasoning: step.events.some((event) => event.reasoning !== undefined) ? 'recorded' : 'not-recorded',
      turns: step.turns === undefined || step.turns.length === 0 ? 'not-recorded' : 'recorded', checkpoints: checkpointSteps.has(step.id) ? 'recorded' : 'not-recorded',
    })),
  });
}

/**
 * Projects only ticket-owned capture metadata joined to the original step.
 * A registered checkpoint remains recorded when its file is missing or withheld.
 * Unsafe opaque identity is never redacted into a fabricated association.
 */
function checkpointAssociation(artifact: ArtifactRecord, stepIds: readonly string[], options: {
  artifacts: AttemptArtifacts; redact: (text: string) => string; unresolvedSecrets?: boolean;
}): { recorded: boolean; unsafe: boolean; checkpoint?: NonNullable<DebugArtifact['checkpoint']>; revision: string | null } {
  const absent = { recorded: false, unsafe: false, revision: null };
  const association = options.artifacts.debugCheckpoints.get(artifact.id);
  if (association === undefined) return absent;
  const original = options.artifacts.records.find((record) => record.id === artifact.id);
  if (!options.artifacts.debugEvidence.has(artifact.id) || original?.producer.kind !== 'step' ||
      artifact.producer.kind !== 'step' || original.producer.stepId !== artifact.producer.stepId ||
      !stepIds.includes(original.producer.stepId) || original.kind !== artifact.kind) return { ...absent, unsafe: true };
  const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
    Buffer.byteLength(value) <= 1024 && sanitizeText(value) === value && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  const safe = (value: string): boolean => options.redact(value) === value;
  const sdkFacts = sdkUnavailableFacts(artifact, options.artifacts);
  if ((options.unresolvedSecrets === true && !sdkFacts) || !identity(association.checkpointId) || !['before', 'after'].includes(association.phase) || (!sdkFacts && !safe(association.checkpointId))) {
    return { recorded: true, unsafe: true, revision: null };
  }
  const observationId = association.observationId;
  const revision = association.observationRevision;
  const paired = observationId === null && revision === null ||
    identity(observationId) && identity(revision) && safe(observationId) && safe(revision);
  const proven = options.artifacts.debugRedactionProven(artifact.id);
  return {
    recorded: true, unsafe: !paired,
    checkpoint: { id: association.checkpointId, phase: association.phase, observationId: proven && paired ? observationId : null },
    revision: proven && paired ? revision : null,
  };
}

/** Checks policy and the retained file's identity before exposing its relative path. */
async function artifactEvidence(artifact: ArtifactRecord, options: {
  artifacts: AttemptArtifacts; resultsDir: string; redact: (text: string) => string; unresolvedSecrets?: boolean;
}): Promise<DebugArtifact['evidence']> {
  // Pending values withhold content and pixels. Only the separately verified
  // SDK missing-evidence byte protocol can retain its owned metadata.
  if ((options.unresolvedSecrets === true && !sdkUnavailableFacts(artifact, options.artifacts)) || (options.artifacts.debugEvidence.has(artifact.id) && !options.artifacts.debugRedactionProven(artifact.id))) return { status: 'withheld', reason: 'incomplete-redaction' };
  const relative = options.artifacts.debugPaths.get(artifact.id);
  if (relative !== undefined && (!relativeArtifactPath(relative) || options.redact(relative) !== relative)) return { status: 'withheld', reason: 'unsafe-path' };
  let anchor;
  try {
    anchor = relative === undefined ? undefined : anchorArtifactFile(options.artifacts.dir, relative);
    if (relative !== undefined && anchor === undefined) return { status: 'withheld', reason: 'unsafe-path' };
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'missing', reason: 'not-retained' } : { status: 'withheld', reason: 'read-failed' };
  }
  if (artifact.redaction !== 'complete') return { status: 'withheld', reason: 'incomplete-redaction' };
  if (!options.artifacts.debugEvidence.has(artifact.id)) return { status: 'withheld', reason: 'non-sdk-evidence' };
  if (relative === undefined || anchor === undefined) return { status: 'missing', reason: 'not-retained' };
  if (artifact.path === undefined || artifact.size === undefined || artifact.sha256 === undefined) return { status: 'withheld', reason: 'read-failed' };
  if (registeredMedia(artifact, options.artifacts) !== artifact.mediaType) return { status: 'withheld', reason: 'non-sdk-evidence' };
  if (!relativeArtifactPath(artifact.path) || options.redact(artifact.path) !== artifact.path) return { status: 'withheld', reason: 'unsafe-path' };
  if (path.resolve(options.resultsDir, artifact.path) !== path.resolve(options.artifacts.dir, relative)) return { status: 'withheld', reason: 'unsafe-path' };
  try {
    const hash = createHash('sha256');
    const original = options.artifacts.debugFiles.get(artifact.id);
    if (original === undefined || !artifactAnchorCurrent(original)) return { status: 'withheld', reason: 'changed-file' };
    const file = await open(original.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!originalArtifactFile(info, original.info) || info.size !== artifact.size) return { status: 'withheld', reason: 'changed-file' };
      await pipeline(file.createReadStream({ autoClose: false }), hash);
      if (!originalArtifactFile(await file.stat(), info) || !artifactAnchorCurrent(original)) return { status: 'withheld', reason: 'changed-file' };
    } finally { await file.close(); }
    if (hash.digest('hex') !== artifact.sha256 || !artifactAnchorCurrent(original)) return { status: 'withheld', reason: 'changed-file' };
    if (!options.artifacts.debugRedactionProven(artifact.id)) return { status: 'withheld', reason: 'incomplete-redaction' };
    return { status: 'available', path: relative, size: artifact.size, sha256: artifact.sha256 };
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'missing', reason: 'not-retained' } : { status: 'withheld', reason: 'read-failed' };
  }
}

/** Freezes a detached JSON graph; it never traverses engine/session objects. */
function freeze<T>(value: T): Immutable<T> {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as Immutable<T>;
}
