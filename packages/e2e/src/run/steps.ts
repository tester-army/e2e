/** Attempt-scoped step timeline. */

import { AsyncLocalStorage } from 'node:async_hooks';
import { isAgentError } from '../agent/error.ts';
import type { ReplayHandOffReason } from '../agent/executor.ts';
import type { CacheWrite } from '../cache/context.ts';
import type { TraceReplayMissReason } from '../cache/decide.ts';
import type { RecordedModel, DerivedReason } from '../cache/trace.ts';
import { bound } from '../internal/text.ts';
import { markAbandonedRejection, relocateStack } from '../internal/abandoned.ts';
import { withAiTraceStep } from '../internal/ai-trace.ts';
import { classifyError, serializeError, TestError, withHint, type E2EError, type SerializedError } from '../internal/errors.ts';
import { timestamp } from '../internal/ids.ts';
import { withAbort } from '../internal/time.ts';
import { sourceLocation, type SourceLocation } from '../internal/source.ts';
import type { AppLogEntry, AppLogSource } from '../engine/index.ts';
import { APP_LOG_LIMITS } from '../engine/session.ts';
import type { AppEvent } from '../engine/surface.ts';
import { compareScreens, type ScreenText, type StepScreen } from './step-screens.ts';

/** The closed step kind set; the type is derived from it, so the two cannot drift. */
export const STEP_KINDS = ['agent', 'locator', 'assertion', 'screen', 'app', 'session', 'resource'] as const;

export type StepKind = (typeof STEP_KINDS)[number];

/**
 * Child event of one public step: polls, model calls, policy decisions.
 * `tool-proposal` (report-1) belongs to the planning tier and is not emitted
 * by this milestone.
 */
export interface StepEvent {
  /** `navigation` is where the app went on its own (a navigation the engine did not start, a tab, a frame), in `detail`. */
  kind: 'poll' | 'observation' | 'model' | 'policy' | 'engine' | 'schema' | 'navigation';
  /**
   * When the event began, not when it was recorded. A `model` event carries
   * the moment the request went out even when the executor reports the turn
   * after the tool calls it made, so events sorted by `startedAt` are in
   * causal order while `events` itself is in recording order.
   */
  startedAt: string;
  durationMs: number;
  status: 'passed' | 'failed' | 'cancelled';
  name?: string;
  count?: number;
  /**
   * Prompt and completion tokens of one model call, when the provider
   * reported both; `count` is their sum. Lets a live reporter show the split.
   */
  inputTokens?: number;
  outputTokens?: number;
  bytes?: number;
  decision?: 'allowed' | 'denied';
  code?: string;
  /**
   * Redacted human prose for what the event did — `tap button "Approve"`,
   * `fill secret "password" into textbox "Password"`. Driver action events
   * carry one so a live reporter can render the act without a side lookup;
   * secret values never appear (the name stands in), and the text is bounded.
   */
  detail?: string;
  /**
   * Bounded, redacted excerpt of the reasoning a model turn produced, when
   * the provider returns one. Lets a live reporter show why the model acted,
   * not just that it did. Secrets never reach model input, and the attempt
   * redactor runs over the excerpt regardless; the full text lives in the AI
   * trace, never here.
   */
  reasoning?: string;
}

/** Required accounting for every agent step. */
export interface StepMetrics {
  modelCalls: number;
  actionSteps: number;
  observationBytes: number;
  contextBytes: number;
  ledgerBytes: number;
  /** Largest masked image sent to the model in this step, in bytes. */
  pixelBytes?: number;
}

/**
 * Why a vision step fell back to tree-only input. Pixel evidence degrades
 * rather than failing the step.
 */
export type VisionDegradation = 'PIXEL_TAINTED' | 'MASKING_UNPROVEN' | 'UNSUPPORTED_CAPABILITY';

/** Model provenance and usage for one model-backed step. */
export interface StepModelInfo {
  provider: string;
  model: string;
  endpoint: string;
  adapterVersion: string;
  policyVersion: string;
  calls: number;
  tokenAccounting: 'provider' | 'adapter-upper-bound';
  peakTokensPerCall: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * Input tokens the provider served from its prompt cache and wrote to it,
   * summed over the step's calls; present only when the provider reports the
   * split. Cached reads are part of `inputTokens`, not in addition to it.
   */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCostUsd?: number;
}

/**
 * How the trace cache participated in one agent step. `self-finalized` means
 * the full trace replayed and the step passed with zero model calls;
 * `agent-concluded` means a replayed prefix handed the step to the executor;
 * `missed` means the executor ran the step from the top.
 */
export interface StepCacheInfo {
  mode: 'self-finalized' | 'agent-concluded' | 'missed';
  /** The miss or hand-off reason token; absent on `self-finalized`. */
  reason?: TraceReplayMissReason | ReplayHandOffReason;
  /**
   * On a `gap` at a typed value: the rule that made the value this run's
   * data rather than the flow's. Absent for a gap at a project tool.
   */
  derived?: DerivedReason;
  /**
   * Why a passing step that ran live was still not recorded, when the cause
   * is the call itself: `param-collision` when a `unique()` value equals, is
   * spelled inside, or is the encoded form of another param's value, so the
   * recording could not tell which param a recorded input came from.
   */
  notRecorded?: 'param-collision';
  replayedActions: number;
  totalActions: number;
  /** The step's cache key, which names its entry file (`<cache.dir>/<entry>.json` in the file store). */
  entry?: string;
  /**
   * Why the replay missed or handed off, past what the reason token says:
   * the recorded action it stopped at and what went wrong there, or the
   * screen the recording started on against the one the step did.
   */
  detail?: string;
  /** Configured model when the consulted entry was recorded; absent on older entries. */
  recordedBy?: RecordedModel;
}

/** The cache detail as the report keeps it: what `agent.act()` returns, and what became of the recording once the attempt settled. */
export type StepCacheRecord = StepCacheInfo & {
  /** Set when the attempt ends, so a step's own `result.cache` never has it; see `CacheWrite`. */
  write?: CacheWrite;
};

/** Agent-specific step detail attached while the step is still running. */
export interface StepAgentDetails {
  metrics?: StepMetrics;
  model?: StepModelInfo;
  cache?: StepCacheInfo;
  /** Absent when the step failed before capturing an observation. */
  observationRevision?: string;
  /** Absent when capture failed before a judgment could be requested. */
  explanation?: string;
  /** True when masked pixel evidence was model input, not just an artifact. */
  visionInput?: boolean;
  visionDegraded?: VisionDegradation;
  /**
   * True when `vision: 'only'` withheld the semantic tree, leaving the masked
   * screenshot as the model's only evidence. `metrics.observationBytes` is then
   * zero, because the observation contributed nothing to the request.
   */
  visionOnly?: boolean;
  /** The step's last model turns, bounded; see `StepTurn`. */
  turns?: StepTurn[];
}

/**
 * One model turn of an agent step, as the report keeps it: the tool calls
 * the model made and what came back, each bounded. Enough to read why the
 * step ended where it did without the full transcript.
 */
export interface StepTurn {
  /** One-based turn number within the step. */
  index: number;
  /** `tap({"target":"n19"})`, one per tool call, arguments clipped. */
  calls: string[];
  /** The tool results of the turn, clipped; a screen diff reads as its first lines. */
  outcome: string;
}

/** One bounded piece of turn text, with its original clipping limit retained separately from its display string. */
export interface StepTurnTextSource {
  readonly text: string;
  readonly limit: number;
  readonly overflow: boolean;
}

/** The original bounded sources paired with one report turn during internal attachment. */
export interface StepTurnSources {
  readonly calls: readonly StepTurnTextSource[];
  readonly outcome: StepTurnTextSource;
  readonly notes?: StepTurnTextSource;
}

/** A built-in model turn paired with its bounded source text for late redaction. */
export interface StepTurnRecord {
  readonly turn: StepTurn;
  readonly sources: StepTurnSources;
}

/** Captures a bounded prefix and marks when the source exceeded its redaction margin. */
export function captureStepTurnText(text: string, limit: number): StepTurnTextSource {
  const sourceLimit = limit + REDACTION_SOURCE_MARGIN_CHARS;
  return { text: text.slice(0, sourceLimit), limit, overflow: text.length > sourceLimit };
}

export interface StepRecord {
  id: string;
  index: number;
  kind: StepKind;
  api: string;
  label: string;
  /** The test line the step was called from; absent when no project line was on the stack. */
  source?: SourceLocation;
  status: 'passed' | 'failed' | 'blocked' | 'timed-out' | 'cancelled';
  startedAt: string;
  durationMs: number;
  observationRevision?: string;
  explanation?: string;
  visionInput?: boolean;
  visionDegraded?: VisionDegradation;
  visionOnly?: boolean;
  viewport?: { width: number; height: number; scale: number };
  metrics?: StepMetrics;
  cache?: StepCacheRecord;
  events: StepEvent[];
  /** The model turns of an agent step, most recent last, bounded. */
  turns?: StepTurn[];
  model?: StepModelInfo;
  /** The configured agent an agent step ran with, by name. */
  agent?: string;
  /** The hook the step ran in; absent for a step of the test body. */
  phase?: StepPhase;
  /** How the last screen the step saw differs from the step before's; absent when it saw none. */
  screen?: StepScreen;
  error?: SerializedError;
  artifacts: string[];
}

/** The hooks a step can run in outside the test body. */
export type StepPhase = 'beforeEach' | 'afterEach';

/**
 * Live progress notification for one step, streamed to reporters as the step
 * runs. Derived from the same records the report persists; the report stays
 * the canonical record.
 */
/** The work a running agent step can be waiting on; see `StepProgress`. */
export type StepActivity = 'observe' | 'model' | 'action';

/** IDs join live progress to the report. Step indexes are local to each test or serial member. */
interface StepProgressIdentity {
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly stepId: string;
  readonly stepIndex: number;
}

/** One progress payload before the recorder attaches its identity. */
type StepProgressFact =
  | { readonly phase: 'start'; readonly kind: StepKind; readonly api: string; readonly label: string }
  | {
      readonly phase: 'end';
      readonly kind: StepKind;
      readonly api: string;
      readonly label: string;
      readonly status: StepRecord['status'];
      readonly durationMs: number;
      readonly modelCalls: number;
      /** The same redacted error the finished step records. */
      readonly error?: SerializedError;
      readonly explanation?: string;
    }
  | { readonly phase: 'event'; readonly api: string; readonly event: StepEvent }
  /**
   * What the running step is waiting on right now: a device or browser being
   * read (`observe`), an action landing (`action`), or a model turn
   * (`model`). Emitted as each begins; the matching `event` reports its end.
   * On a device a snapshot or a tap takes seconds, so between events the
   * model is not always the one working.
   */
  | { readonly phase: 'activity'; readonly api: string; readonly activity: StepActivity }
  /**
   * The trace cache took the step (`active`), or handed it to the model after
   * a replay that could not finish it; a step the replay finishes ends while
   * the cache has it. While the cache has the step, recorded actions execute
   * with no model in the loop, so the wait between events is on the app
   * settling, not on a model turn.
   */
  | { readonly phase: 'replay'; readonly api: string; readonly active: boolean };

/** Every runner-produced phase carries identity; optional for consumers of older event streams. */
export type StepProgress = StepProgressFact & { readonly identity?: StepProgressIdentity };

/** Per-step options for `StepRecorder.run`. */
export interface StepRunOptions {
  /**
   * Whether the step checks state rather than producing it: a deterministic
   * assertion, a locator wait, or an agent judgment. Only such a step passing
   * can confirm a staged action trace (cache/context.ts) — an `agent.act`
   * passing is the executor's opinion of its own work, and an `app` or
   * `locator` action passing proves only that the action could be performed.
   * Declared where the step is minted, so the rule cannot drift from the api
   * names.
   */
  readonly verifies?: boolean;
  /** The configured agent an agent step runs with, recorded on the step. */
  readonly agent?: string | undefined;
}

export interface StepRecorderOptions {
  /** The report-owning attempt; serial members share their group's attempt identity. */
  readonly attempt?: { readonly id: string; readonly index: number };
  /** Caps events retained per step (resolved limits.maxEventsPerStep). */
  readonly maxEventsPerStep?: number;
  /** Live progress sink; omitted in contexts with no reporter to feed. */
  readonly onProgress?: (progress: StepProgress) => void;
  /** The project root; with it, every step and step error names the test line it came from. */
  readonly projectRoot?: string;
  /** Redaction that can identify when its session ledger gains another value. */
  readonly redactor?: StepTextRedactor;
  /** Cuts every running step when it aborts: the step fails with the signal's error and its body is abandoned. */
  readonly signal?: AbortSignal;
}

/** One session's current text redactor and the revision of its secret ledger. */
export interface StepTextRedactor {
  redact(text: string): string;
  revision(): number;
  maxFormLength(): number;
}

interface StoredText {
  readonly source: string;
  readonly initial: string;
  readonly revision: number;
  readonly limit: number | undefined;
  readonly overflow: boolean;
  readonly style: 'plain' | 'bound' | 'turn';
}

interface StoredTurn {
  readonly index: number;
  readonly calls: readonly StoredText[];
  readonly outcome: StoredText;
  readonly notes?: StoredText;
}

interface StepSources {
  readonly label: StoredText;
  error?: E2EError;
  cacheDetail?: StoredText;
  explanation?: StoredText;
  turns?: readonly StoredTurn[];
  screen?: {
    readonly metadata: Omit<StepScreen, 'location' | 'changes'>;
    readonly location?: StoredText;
    readonly changes: readonly StoredText[];
  };
  readonly eventDetails: Map<number, StoredText>;
}

interface SafeRecordCache {
  readonly recordVersion: number;
  readonly redactorRevision: number;
  readonly value: StepRecord;
}

interface SafeLogCache {
  readonly redactorRevision: number;
  readonly value: AppLogRecord;
}

/** Frames kept when a step captures where it was called from; the user's line is a few frames up. */
const STEP_STACK_FRAMES = 20;

/**
 * The stack at a step's start, or nothing without a project root to read it
 * against. Every step pays the capture, since the failing one is not known
 * until it fails, and a report that names the line is worth it. The stack
 * outlives the source it yields: a step the body abandoned reports its
 * failure from the line it was called on.
 */
function stepStack(projectRoot: string | undefined): string | undefined {
  if (projectRoot === undefined) return undefined;
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = STEP_STACK_FRAMES;
  try {
    return new Error().stack;
  } finally {
    Error.stackTraceLimit = limit;
  }
}

/**
 * One line the app logged during an attempt, redacted and bounded: where it
 * came from, how bad it was, when, and the index of the step that was running
 * (else the one that started last); absent before the attempt's first step.
 */
export interface AppLogRecord {
  readonly source: AppLogSource;
  readonly level: AppLogEntry['level'];
  readonly text: string;
  readonly at: string;
  readonly step?: number;
}
/** Characters of an event's detail the report admits. */
export const MAX_EVENT_DETAIL_CHARS = 300;
const REDACTION_SOURCE_MARGIN_CHARS = MAX_EVENT_DETAIL_CHARS;
const MAX_UNBOUNDED_SOURCE_CHARS = 16_384;
const REDACTION_OMITTED = '[text omitted after redaction source limit]';

/** Characters of a step label an error message quotes before clipping it. */
const MAX_QUOTED_LABEL_CHARS = 80;

function quoted(label: string): string {
  return `"${label.length > MAX_QUOTED_LABEL_CHARS ? `${label.slice(0, MAX_QUOTED_LABEL_CHARS - 3)}...` : label}"`;
}

export class StepRecorder {
  private readonly attempt: { readonly id: string; readonly index: number };
  private readonly steps: StepRecord[] = [];
  private readonly scope = new AsyncLocalStorage<StepRecord>();
  /** The hook steps run in from now on; undefined while the test body runs. */
  phase: StepPhase | undefined = undefined;
  /** IDs of steps whose bodies are still executing. */
  private readonly running = new Set<string>();
  /** The promise each running step returned to its caller, to observe when the caller did not. */
  private readonly pending = new Map<string, Promise<unknown>>();
  /** The stack each running step was started from, for the error a step abandoned by the body carries. */
  private readonly stacks = new Map<string, string>();
  /** Steps the body returned without awaiting: recorded as failed already, whatever they do next. */
  private readonly abandoned = new Set<string>();
  /** The promises of abandoned steps, for the wait before teardown. */
  private readonly abandonedPromises: Promise<unknown>[] = [];
  /** Highest timeline index among passed verification steps, or -1 when none has. */
  private lastVerified = -1;
  /** What the app logged this attempt, within `APP_LOG_LIMITS`. */
  private readonly logged: AppLogRecord[] = [];
  /** Raw text used only to build a current, bounded safe snapshot. */
  private readonly sources = new Map<string, StepSources>();
  private readonly safeRecords = new Map<string, SafeRecordCache>();
  private readonly recordVersions = new Map<string, number>();
  private readonly logSources = new Map<number, StoredText>();
  private readonly safeLogs = new Map<number, SafeLogCache>();
  /** App log entries of each kind `APP_LOG_LIMITS` counts, kept so far. */
  private readonly loggedCounts = { errorsAndWarnings: 0, info: 0 };
  /** The last screen each running step saw, read only when the step ends. */
  private readonly seenScreens = new Map<string, () => ScreenText | undefined>();
  /** The last screen a finished step saw, the one the next step's is compared with. */
  private lastScreen: { readonly step: number; readonly screen: ScreenText } | undefined;
  /** Where the app went before the attempt's first step, told under it once it starts. */
  private readonly earlyNavigations: { line: string; at: string }[] = [];
  private readonly maxEventsPerStep: number;
  private readonly onProgress: ((progress: StepProgress) => void) | undefined;
  private readonly projectRoot: string | undefined;
  private readonly redactor: StepTextRedactor | undefined;
  private readonly signal: AbortSignal | undefined;

  constructor(
    private readonly attemptId: string,
    options: StepRecorderOptions = {},
  ) {
    this.attempt = options.attempt ?? { id: attemptId, index: 0 };
    this.maxEventsPerStep = options.maxEventsPerStep ?? 1_000;
    this.onProgress = options.onProgress;
    this.projectRoot = options.projectRoot;
    this.redactor = options.redactor;
    this.signal = options.signal;
  }

  /** Replaces secret values in text the way every record is redacted; identity without a redactor. */
  redactText(text: string): string {
    return this.redactor?.redact(text) ?? text;
  }

  /** The step currently executing, when inside StepRecorder.run. */
  get currentStepId(): string | undefined {
    return this.current()?.id;
  }

  /** Timeline index of the currently executing step. */
  get currentStepIndex(): number | undefined {
    return this.current()?.index;
  }

  /** Highest timeline index among passed verification steps, or -1 when none has. */
  get lastVerifiedStepIndex(): number {
    return this.lastVerified;
  }

  /** Runs one public API call as a recorded top-level step. */
  run<T>(
    kind: StepKind,
    api: string,
    rawLabel: string,
    body: () => Promise<T>,
    options: StepRunOptions = {},
  ): Promise<T> {
    const labelSource = this.captureText(rawLabel, undefined, 'plain');
    const label = labelSource.initial;
    const index = this.steps.length;
    const startedAt = timestamp();
    const stack = stepStack(this.projectRoot);
    const source = sourceLocation(stack, this.projectRoot);
    const record: StepRecord = {
      id: `${this.attemptId}:${index}`,
      index,
      kind,
      api,
      label,
      ...(source === undefined ? {} : { source }),
      status: 'passed',
      startedAt,
      durationMs: 0,
      events: [],
      ...(options.agent === undefined ? {} : { agent: options.agent }),
      ...(this.phase === undefined ? {} : { phase: this.phase }),
      artifacts: [],
    };
    this.sources.set(record.id, { label: labelSource, eventDetails: new Map() });
    this.invalidate(record);
    this.steps.push(record);
    this.running.add(record.id);
    for (const { line, at } of this.earlyNavigations.splice(0)) this.fileNavigation(record, line, at);
    if (stack !== undefined) this.stacks.set(record.id, stack);
    this.publish(record, { phase: 'start', kind, api, label });
    const promise = this.execute(record, body, options);
    this.pending.set(record.id, promise);
    return promise;
  }

  private async execute<T>(record: StepRecord, body: () => Promise<T>, options: StepRunOptions): Promise<T> {
    const startedMs = Date.now();
    try {
      // Model calls made inside the body are attributed to this step.
      const work = this.scope.run(record, () => withAiTraceStep(record.api, record.label, body));
      const result = await (this.signal === undefined ? work : withAbort(work, this.signal, () => new TestError('CANCELLED', `${record.api} cancelled`)));
      if (this.abandoned.has(record.id)) return result;
      record.durationMs = Date.now() - startedMs;
      if (options.verifies === true) this.lastVerified = Math.max(this.lastVerified, record.index);
      return result;
    } catch (cause) {
      if (this.abandoned.has(record.id)) {
        markAbandonedRejection(cause);
        throw cause;
      }
      record.durationMs = Date.now() - startedMs;
      const error = classifyError(cause);
      // A blocked verdict is a distinct outcome, not a product failure: the
      // step's error names what stood in the way, and the report says so.
      record.status =
        error.code === 'CANCELLED'
          ? 'cancelled'
          : isAgentError(cause) && cause.blocked
            ? 'blocked'
            : 'failed';
      this.sources.get(record.id)!.error = error;
      record.error = serializeError(error, { projectRoot: this.projectRoot, redact: (text) => this.redactText(text) });
      this.invalidate(record);
      throw cause;
    } finally {
      this.running.delete(record.id);
      this.pending.delete(record.id);
      this.stacks.delete(record.id);
      // An abandoned step reported its end when the body returned; what it did since is not the test's.
      if (this.abandoned.delete(record.id)) {
        this.seenScreens.delete(record.id);
      } else {
        this.settleScreen(record);
        this.invalidate(record);
        this.publishEnd(record);
      }
    }
  }

  /**
   * Fails every step still running once the test body has settled, and
   * returns the error that names them, or nothing when every step was
   * awaited. Each such step is recorded as failed at the line it was called
   * on, its later outcome is dropped, and its rejection is observed here: a
   * step the body abandoned must not take the worker down as an unhandled
   * rejection.
   */
  abandonRunning(): TestError | undefined {
    const running = this.steps.filter((step) => this.running.has(step.id) && !this.abandoned.has(step.id));
    let first: TestError | undefined;
    for (const step of running) {
      const more = first === undefined && running.length > 1 ? ` and ${running.length - 1} more` : '';
      const error = new TestError(
        'STEP_NOT_AWAITED',
        withHint(`the test body returned before ${step.api} ${quoted(step.label)}${more} finished`, 'put `await` in front of every step call'),
      );
      relocateStack(error, this.stacks.get(step.id));
      first ??= error;
      this.abandoned.add(step.id);
      step.status = 'failed';
      step.durationMs = Math.max(0, Date.now() - Date.parse(step.startedAt));
      this.sources.get(step.id)!.error = error;
      step.error = serializeError(error, { projectRoot: this.projectRoot, redact: (text) => this.redactText(text) });
      this.invalidate(step);
      const promise = this.pending.get(step.id);
      if (promise !== undefined) {
        promise.catch(() => undefined);
        this.abandonedPromises.push(promise);
      }
      this.publishEnd(step);
    }
    return first;
  }

  /** Resolves once every abandoned step has settled, however it did; the caller bounds the wait. */
  async settleAbandoned(): Promise<void> {
    await Promise.allSettled(this.abandonedPromises);
  }

  private publishEnd(record: StepRecord): void {
    const safe = this.safeRecord(record);
    this.publish(record, {
      phase: 'end',
      kind: safe.kind,
      api: safe.api,
      label: safe.label,
      status: safe.status,
      durationMs: safe.durationMs,
      modelCalls: safe.events.filter((event) => event.kind === 'model').length,
      ...(safe.error === undefined ? {} : { error: safe.error }),
      ...(safe.explanation === undefined ? {} : { explanation: safe.explanation }),
    });
  }

  /**
   * Attaches an artifact ID to the running step, or to the most recent step
   * when none is running. The running step wins so a step that ran a nested
   * step (a fixture call that clicked a link, say) still owns what it produced.
   */
  attachArtifact(artifactId: string): void {
    // Cleanup outside a scope may attach to the last step. Work inherited
    // from a closed scope must never attach to a newer step.
    const target = this.scope.getStore() === undefined
      ? this.steps[this.steps.length - 1]
      : this.current();
    if (target !== undefined) {
      target.artifacts.push(artifactId);
      this.invalidate(target);
    }
  }

  /** Records one child event of the running step. */
  recordEvent(event: StepEvent): void {
    const current = this.current();
    if (current === undefined) return;
    this.push(current, event);
  }

  /**
   * Keeps one thing the app did on its own, with the step running in this
   * async context, else the step that started last: an engine reports from
   * its own event callbacks, outside any step's context, so a request that
   * fails after a tap resolved lands with the tap. A log line goes to the
   * attempt's app log (`appLog`), within `APP_LOG_LIMITS`; where the app went
   * is an event of the step, and one before the first step waits for it.
   */
  recordAppEvent(event: AppEvent, at: string = timestamp()): void {
    const target = this.current() ?? this.steps.at(-1);
    if (event.kind === 'navigation') {
      if (target === undefined) {
        // A step takes no more events than this, so no more wait for one.
        if (this.earlyNavigations.length < this.maxEventsPerStep) this.earlyNavigations.push({ line: event.line, at });
      }
      else this.fileNavigation(target, event.line, at);
      return;
    }
    const { entry } = event;
    const counted = entry.level === 'info' ? 'info' : 'errorsAndWarnings';
    if (this.loggedCounts[counted] >= APP_LOG_LIMITS[counted]) return;
    this.loggedCounts[counted] += 1;
    const normalized = entry.text.replace(/\s+/g, ' ').trim();
    const source = this.captureText(normalized, MAX_EVENT_DETAIL_CHARS, 'bound');
    const index = this.logged.length;
    this.logged.push({ source: entry.source, level: entry.level, text: source.initial, at, ...(target === undefined ? {} : { step: target.index }) });
    this.logSources.set(index, source);
    this.safeLogs.delete(index);
  }

  /** What the app logged this attempt, oldest first. */
  appLog(): readonly AppLogRecord[] {
    return this.logged.map((record, index) => this.safeLog(index, record));
  }

  /**
   * Notes a screen the running step saw; the newest one stands. `read`
   * renders it, redacted, and runs once, when the step ends, so a step that
   * observes many times pays for one. A screen no step is running for (the
   * failure evidence, a launch) is the trace's only through the screen at failure.
   */
  recordScreen(read: () => ScreenText | undefined): void {
    const target = this.current();
    if (target !== undefined) this.seenScreens.set(target.id, read);
  }

  /** Compares the last screen a step saw with the one before it, once the step has ended. */
  private settleScreen(record: StepRecord): void {
    const read = this.seenScreens.get(record.id);
    if (read === undefined) return;
    this.seenScreens.delete(record.id);
    let screen: ScreenText | undefined;
    try {
      screen = read();
    } catch {
      return;
    }
    if (screen === undefined) return;
    const next = compareScreens(this.lastScreen, screen, { includeRawChanges: true });
    const { location, changes, rawChanges = changes, ...metadata } = next;
    const sources = this.sources.get(record.id)!;
    sources.screen = {
      metadata,
      ...(location === undefined ? {} : { location: this.captureText(location, undefined, 'plain') }),
      changes: rawChanges.map((change) => this.captureText(change, 200, 'bound')),
    };
    record.screen = { ...metadata, changes: [] };
    this.lastScreen = { step: record.index, screen };
    this.invalidate(record);
  }

  private fileNavigation(target: StepRecord, line: string, at: string): void {
    this.push(target, { kind: 'navigation', startedAt: at, durationMs: 0, status: 'passed', detail: line.replace(/\s+/g, ' ').trim() });
  }

  /** Appends an event to a step, its prose redacted, within the per-step cap. */
  private push(step: StepRecord, event: StepEvent): void {
    if (step.events.length >= this.maxEventsPerStep) return;
    const source = event.detail === undefined ? undefined : this.captureText(event.detail, MAX_EVENT_DETAIL_CHARS, 'bound');
    const redacted = source === undefined ? event : { ...event, detail: source.initial };
    const index = step.events.length;
    step.events.push(redacted);
    if (source !== undefined) this.sources.get(step.id)!.eventDetails.set(index, source);
    this.invalidate(step);
    this.publish(step, { phase: 'event', api: step.api, event: redacted });
  }

  /**
   * Tells reporters the trace cache has the running step (`true`), or has
   * handed it to the model (`false`). Nothing is recorded: the step's `cache`
   * detail says how the replay went. Outside a running step this is a no-op,
   * as `recordEvent` is.
   */
  replaying(active: boolean): void {
    const current = this.current();
    if (current === undefined) return;
    this.publish(current, { phase: 'replay', api: current.api, active });
  }

  /**
   * Tells reporters what the running step waits on now; the phase's `event`
   * later reports how it went. Nothing is recorded. Outside a running step
   * this is a no-op, as `recordEvent` is.
   */
  activity(activity: StepActivity): void {
    const current = this.current();
    if (current === undefined) return;
    this.publish(current, { phase: 'activity', api: current.api, activity });
  }

  /** Merges agent metrics, provenance, and judgment detail into the running step. */
  attachAgentDetails(details: StepAgentDetails): void {
    const current = this.current();
    if (current === undefined) return;
    if (details.metrics !== undefined) current.metrics = details.metrics;
    if (details.model !== undefined) current.model = details.model;
    if (details.cache !== undefined) {
      const { detail, ...cache } = details.cache;
      current.cache = cache;
      if (detail === undefined) delete this.sources.get(current.id)!.cacheDetail;
      else this.sources.get(current.id)!.cacheDetail = this.captureText(detail, undefined, 'plain');
    }
    if (details.observationRevision !== undefined) {
      current.observationRevision = details.observationRevision;
    }
    if (details.explanation !== undefined) {
      const source = this.captureText(details.explanation, undefined, 'plain');
      this.sources.get(current.id)!.explanation = source;
      current.explanation = source.initial;
    }
    if (details.visionInput !== undefined) current.visionInput = details.visionInput;
    if (details.visionDegraded !== undefined) current.visionDegraded = details.visionDegraded;
    if (details.visionOnly !== undefined) current.visionOnly = details.visionOnly;
    if (details.turns !== undefined) this.attachTurns(details.turns);
    this.invalidate(current);
  }

  /** Stores the built-in executor's turns as bounded raw sources and a safe report view. */
  attachTurns(turns: readonly StepTurn[]): void {
    const current = this.current();
    if (current === undefined || turns.length === 0) return;
    this.storeTurns(current, turns.map((turn) => this.captureTurn(turn, undefined)));
  }

  /** Stores source-aware turns from the built-in executor. */
  attachTurnRecords(turns: readonly StepTurnRecord[]): void {
    const current = this.current();
    if (current === undefined || turns.length === 0) return;
    const captured = turns.map(({ turn, sources }) => this.captureTurn(turn, sources));
    this.storeTurns(current, captured);
  }

  /** Saves private sources and updates the currently visible turn view. */
  private storeTurns(current: StepRecord, captured: StoredTurn[]): void {
    this.sources.get(current.id)!.turns = captured;
    current.turns = captured.map((turn) => this.renderTurn(turn));
    this.invalidate(current);
  }

  /** Records the viewport a step established. */
  attachViewport(viewport: { width: number; height: number; scale: number }): void {
    const current = this.current();
    if (current !== undefined) {
      current.viewport = viewport;
      this.invalidate(current);
    }
  }

  all(): readonly StepRecord[] {
    return this.steps.map((step) => this.safeRecord(step));
  }

  /** Steps whose execution has finished, e.g. as prior-step prompt context. */
  completed(): readonly StepRecord[] {
    return this.steps.filter((step) => !this.running.has(step.id)).map((step) => this.safeRecord(step));
  }

  /** Keeps a bounded private source and its safe initial display form. */
  private captureText(
    text: string,
    limit: number | undefined,
    style: StoredText['style'],
    inputOverflow = false,
  ): StoredText {
    const sourceLimit = limit === undefined ? MAX_UNBOUNDED_SOURCE_CHARS : limit + REDACTION_SOURCE_MARGIN_CHARS;
    const overflow = inputOverflow || text.length > sourceLimit;
    const source = text.slice(0, sourceLimit);
    const revision = this.redactor?.revision() ?? 0;
    const initial = overflow && !this.canRenderOverflow(limit)
      ? this.omittedText(limit, style)
      : this.clipText(this.redactText(source), limit, style);
    return { source, initial, revision, limit, overflow, style };
  }

  /** Captures a turn's report sources without exposing the private originals. */
  private captureTurn(turn: StepTurn, sources: StepTurnSources | undefined): StoredTurn {
    const calls = sources === undefined
      ? turn.calls.map((text) => this.captureText(text, text.length, 'turn'))
      : sources.calls.map((source) => this.captureText(source.text, source.limit, 'turn', source.overflow));
    const outcome = sources === undefined
      ? this.captureText(turn.outcome, turn.outcome.length, 'turn')
      : this.captureText(sources.outcome.text, sources.outcome.limit, 'turn', sources.outcome.overflow);
    const notes = sources?.notes === undefined
      ? undefined
      : this.captureText(sources.notes.text, sources.notes.limit, 'turn', sources.notes.overflow);
    return { index: turn.index, calls, outcome, ...(notes === undefined ? {} : { notes }) };
  }

  /** Builds a report turn from the current redaction ledger. */
  private renderTurn(turn: StoredTurn): StepTurn {
    const outcome = this.renderText(turn.outcome);
    const notes = turn.notes === undefined ? undefined : this.renderText(turn.notes);
    return {
      index: turn.index,
      calls: turn.calls.map((call) => this.renderText(call)),
      outcome: notes === undefined ? outcome : `${outcome}\n${notes}`,
    };
  }

  /** Re-redacts a retained source after the session learns another secret. */
  private renderText(source: StoredText): string {
    const revision = this.redactor?.revision() ?? 0;
    if (revision === source.revision) return source.initial;
    if (source.overflow && !this.canRenderOverflow(source.limit)) return this.omittedText(source.limit, source.style);
    return this.clipText(this.redactText(source.source), source.limit, source.style);
  }

  /** Returns whether the retained margin is long enough to redact a source that was cut upstream. */
  private canRenderOverflow(limit: number | undefined): boolean {
    return limit !== undefined && (this.redactor?.maxFormLength() ?? 0) <= REDACTION_SOURCE_MARGIN_CHARS;
  }

  /** Applies the display limit after redaction. */
  private clipText(text: string, limit: number | undefined, style: StoredText['style']): string {
    if (limit === undefined || text.length <= limit) return text;
    return style === 'bound' ? bound(text, limit) : `${text.slice(0, limit)}…[truncated]`;
  }

  /** Returns the bounded omission marker for a source that cannot be safely re-redacted. */
  private omittedText(limit: number | undefined, style: StoredText['style']): string {
    if (limit === undefined) return REDACTION_OMITTED;
    return this.clipText(REDACTION_OMITTED, limit, style);
  }

  /** Returns a cached safe record, rebuilding it when the record or ledger changes. */
  private safeRecord(record: StepRecord): StepRecord {
    const revision = this.redactor?.revision() ?? 0;
    const recordVersion = this.recordVersions.get(record.id) ?? 0;
    const cached = this.safeRecords.get(record.id);
    if (cached !== undefined && cached.recordVersion === recordVersion && cached.redactorRevision === revision) return cached.value;

    const sources = this.sources.get(record.id);
    const events = record.events.map((event, index) => {
      const detail = sources?.eventDetails.get(index);
      return detail === undefined ? event : { ...event, detail: this.renderText(detail) };
    });
    const error = sources?.error === undefined
      ? record.error
      : serializeError(sources.error, { projectRoot: this.projectRoot, redact: (text) => this.redactText(text) });
    const screen = sources?.screen === undefined
      ? record.screen
      : {
          ...sources.screen.metadata,
          ...(sources.screen.location === undefined ? {} : { location: this.renderText(sources.screen.location) }),
          changes: sources.screen.changes.map((change) => this.renderText(change)),
        };
    const safe: StepRecord = {
      ...record,
      label: sources === undefined ? record.label : this.renderText(sources.label),
      events,
      ...(sources?.cacheDetail === undefined || record.cache === undefined
        ? {}
        : { cache: { ...record.cache, detail: this.renderText(sources.cacheDetail) } }),
      ...(screen === undefined ? {} : { screen }),
      ...(sources?.explanation === undefined ? {} : { explanation: this.renderText(sources.explanation) }),
      ...(sources?.turns === undefined ? {} : { turns: sources.turns.map((turn) => this.renderTurn(turn)) }),
      ...(error === undefined ? {} : { error }),
    };
    this.safeRecords.set(record.id, { recordVersion, redactorRevision: revision, value: safe });
    return safe;
  }

  private safeLog(index: number, record: AppLogRecord): AppLogRecord {
    const revision = this.redactor?.revision() ?? 0;
    const cached = this.safeLogs.get(index);
    if (cached !== undefined && cached.redactorRevision === revision) return cached.value;
    const source = this.logSources.get(index);
    const safe = source === undefined ? record : { ...record, text: this.renderText(source) };
    this.safeLogs.set(index, { redactorRevision: revision, value: safe });
    return safe;
  }

  private invalidate(record: StepRecord): void {
    this.recordVersions.set(record.id, (this.recordVersions.get(record.id) ?? 0) + 1);
    this.safeRecords.delete(record.id);
  }

  private current(): StepRecord | undefined {
    const record = this.scope.getStore();
    return record !== undefined && this.running.has(record.id) && !this.abandoned.has(record.id) ? record : undefined;
  }

  /** Publishes a phase with the owning record's identity, including nested and finishing steps. */
  private publish(record: StepRecord, progress: StepProgressFact): void {
    this.onProgress?.({
      ...progress,
      identity: {
        attemptId: this.attempt.id,
        attemptIndex: this.attempt.index,
        stepId: record.id,
        stepIndex: record.index,
      },
    });
  }
}
