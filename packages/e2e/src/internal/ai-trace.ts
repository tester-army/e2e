/**
 * AI trace recording for `e2e run --ai-trace`: every model round trip the
 * run makes, in the AI SDK devtools database shape (`{ runs[], steps[] }`)
 * that trace viewers such as unbox-ai already read.
 *
 * This is a debugging aid, not a report: the report stays the canonical
 * record and the trace is written next to it only on request. The recorder
 * is an AI SDK telemetry integration, so it sees the exact prompt, tool
 * definitions, response, and usage of each generation — including calls a
 * custom executor makes through its own `ai` import, because the SDK
 * resolves registered integrations process-wide. What the model saw is
 * already redacted and size-bounded by the observation pipeline; what the
 * model said is not, so every record passes the process secret ledger as it
 * closes: a tool call that echoes a secret value, an assistant message, an
 * error, or provider metadata lands in the file redacted, as the report's
 * turns do. `redactAiTraceDocument` applies the ledger once more, when a
 * worker ships its records and when the file is written, for a value that
 * became a secret after a record closed.
 *
 * Attribution comes from an async-local scope the run layer enters per
 * attempt and per step, so no model call site needs to know it is traced.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Telemetry } from 'ai';
import { redactLeaves } from './redact.ts';

/** Longest step label quoted in a run name before truncation. */
const MAX_LABEL_CHARS = 80;

/** A run record: one `generateText` call, which for `agent.act` is one whole step. */
export interface AiTraceRun {
  readonly id: string;
  readonly started_at: string;
  readonly parent_run_id: string | null;
  readonly parent_step_id: string | null;
  /** Human-readable run name: test title, agent API, and step label. */
  readonly function_id: string | null;
  /** e2e attribution beyond what the devtools shape carries. */
  readonly e2e: AiTraceScope | undefined;
}

/** A step record: one model round trip inside a run, JSON columns as strings. */
export interface AiTraceStep {
  readonly id: string;
  readonly run_id: string;
  readonly step_number: number;
  readonly type: 'generate';
  readonly model_id: string;
  readonly provider: string | null;
  readonly started_at: string;
  readonly duration_ms: number | null;
  readonly input: string;
  readonly output: string | null;
  readonly usage: string | null;
  readonly error: string | null;
}

/** The on-disk document: exactly what `@ai-sdk/devtools` writes. */
export interface AiTraceDocument {
  readonly runs: AiTraceRun[];
  readonly steps: AiTraceStep[];
}

/** Records drained from one worker since its previous drain. */
export type AiTraceSnapshot = AiTraceDocument;

/** What the run layer knows about the code that is calling the model. */
export interface AiTraceScope {
  readonly test: string;
  readonly testId: string;
  readonly target: string;
  /** The configured agent the attempt runs as. */
  readonly agent: string;
  /** Zero-based attempt index. */
  readonly attempt: number;
  readonly api?: string;
  readonly label?: string;
}

const scopeStorage = new AsyncLocalStorage<AiTraceScope>();

/** Runs `work` with `scope` as the attribution for every model call inside. */
export function withAiTraceScope<T>(scope: AiTraceScope, work: () => Promise<T>): Promise<T> {
  return scopeStorage.run(scope, work);
}

/**
 * Narrows the current attempt scope to one public API step. Outside an
 * attempt scope there is nothing to narrow, and the work runs as is.
 */
export function withAiTraceStep<T>(api: string, label: string, work: () => Promise<T>): Promise<T> {
  const parent = scopeStorage.getStore();
  if (parent === undefined) return work();
  return scopeStorage.run({ ...parent, api, label }, work);
}

/** The scope of the calling async context, when inside an attempt. */
function currentAiTraceScope(): AiTraceScope | undefined {
  return scopeStorage.getStore();
}

// --- telemetry event shapes ---
//
// Structural views of the AI SDK events, naming only what the recorder
// reads. The SDK's own types are generic over tool sets and runtime
// contexts; reading through these keeps the recorder stable across SDK
// patch releases exactly as the devtools integration itself does.

interface StartEvent {
  readonly callId: string;
  readonly operationId: string;
  readonly functionId?: string | undefined;
}

interface StepStartEvent {
  readonly callId: string;
  readonly stepNumber: number;
  readonly provider: string;
  readonly modelId: string;
  readonly instructions: unknown;
  readonly messages: unknown[];
  readonly toolChoice?: unknown;
}

interface ModelCallStartEvent {
  readonly callId: string;
  readonly instructions?: unknown;
  readonly messages?: unknown[];
  readonly tools?: ReadonlyArray<Record<string, unknown>> | undefined;
  readonly toolChoice?: unknown;
}

interface ModelCallEndEvent {
  readonly callId: string;
  readonly performance?: { readonly responseTimeMs?: number } | undefined;
}

interface StepEndEvent {
  readonly callId: string;
  readonly stepNumber: number;
  readonly content: unknown;
  readonly finishReason: unknown;
  readonly usage: unknown;
  readonly providerMetadata?: unknown;
  readonly response: {
    readonly id?: string;
    readonly modelId?: string;
    readonly timestamp?: Date | string;
    readonly messages?: unknown[];
  };
}

interface EndEvent {
  readonly callId: string;
}

interface ErrorEvent {
  readonly callId?: string;
  readonly error?: unknown;
}

/** One open step, kept as objects until it closes and gets serialized. */
interface OpenStep {
  readonly id: string;
  readonly runId: string;
  /** Zero-based position within the run, across every generation in it. */
  readonly stepNumber: number;
  readonly modelId: string;
  readonly provider: string | null;
  readonly startedAt: string;
  readonly startedMs: number;
  prompt: unknown[];
  tools: unknown[] | undefined;
  toolChoice: unknown;
  /** Model-side latency, when the SDK reported one; wall time otherwise. */
  responseTimeMs: number | undefined;
}

interface CallState {
  readonly runId: string;
  /** Open steps by the SDK's per-generation step index. */
  readonly openSteps: Map<number, OpenStep>;
  /** The run's step allocator, shared by every generation in the run. */
  readonly run: RunCounter;
}

/**
 * Per-run step allocation. Numbers are taken when a step starts, not
 * reserved when a generation starts, so generations a custom executor
 * overlaps inside one step interleave without ever sharing a number.
 */
interface RunCounter {
  readonly runId: string;
  steps: number;
}

/** The generation and step a tool is executing under, for nested runs. */
interface ToolAncestry {
  readonly runId: string;
  readonly stepId: string | undefined;
}

export interface AiTraceRecorderOptions {
  /**
   * Replaces secret values in every record before it is kept: the live
   * process ledger, so a value registered mid-run is covered from then on.
   * Records are kept verbatim without one; tests that drive the recorder
   * alone do that.
   */
  readonly redact?: (text: string) => string;
}

/**
 * Collects one process's model calls. Registered once with the AI SDK via
 * `registerTelemetry`; `drain()` hands the completed records to the run
 * layer, which ships them to the runner over the worker channel.
 */
export class AiTraceRecorder {
  private readonly calls = new Map<string, CallState>();
  /**
   * One run per agent step: every generation made under the same step scope
   * — a `waitFor` poll, a judgment repair round — continues the step's run
   * rather than starting its own, so a viewer's run list reads as the test's
   * step list. Keyed by scope identity, which is fresh per step.
   */
  private readonly stepRuns = new WeakMap<AiTraceScope, RunCounter>();
  private runs: AiTraceRun[] = [];
  private steps: AiTraceStep[] = [];
  /**
   * The tool a generation is being made from, carried by async context so
   * tools that execute in parallel each see only their own ancestry.
   */
  private readonly toolAncestry = new AsyncLocalStorage<ToolAncestry>();
  private readonly redact: (text: string) => string;
  private disposed = false;

  constructor(options: AiTraceRecorderOptions = {}) {
    this.redact = options.redact ?? ((text) => text);
  }

  /** The integration object to hand to `registerTelemetry`. */
  readonly telemetry: Telemetry = {
    onStart: (event) => this.onStart(event as unknown as StartEvent),
    onStepStart: (event) => this.onStepStart(event as unknown as StepStartEvent),
    onLanguageModelCallStart: (event) =>
      this.onModelCallStart(event as unknown as ModelCallStartEvent),
    onLanguageModelCallEnd: (event) => this.onModelCallEnd(event as unknown as ModelCallEndEvent),
    onStepEnd: (event) => this.onStepEnd(event as unknown as StepEndEvent),
    onEnd: (event) => this.onEnd(event as unknown as EndEvent),
    onError: (event) => this.onError(event as ErrorEvent | undefined),
    executeTool: ({ callId, execute }) => {
      const state = this.calls.get(callId);
      if (state === undefined) return execute();
      const open = [...state.openSteps.values()].at(-1);
      return this.toolAncestry.run({ runId: state.runId, stepId: open?.id }, () => execute());
    },
  };

  /**
   * Stops recording. The SDK offers no unregister, so a disposed recorder
   * simply ignores every later event; the entry it leaves in the global
   * integration list is removed when that list is where the SDK keeps it.
   */
  dispose(): void {
    this.disposed = true;
    const registry = (globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown })
      .AI_SDK_TELEMETRY_INTEGRATIONS;
    if (Array.isArray(registry)) {
      const index = registry.indexOf(this.telemetry);
      if (index >= 0) registry.splice(index, 1);
    }
  }

  /**
   * Returns every run created and every step closed since the previous
   * drain. Open steps stay until they close, so a step that finishes after a
   * unit boundary is never reported half-written; `drain({ all: true })` at
   * shutdown takes them as they are.
   */
  drain(options: { all?: boolean } = {}): AiTraceSnapshot {
    const snapshot: AiTraceSnapshot = { runs: this.runs, steps: this.steps };
    this.runs = [];
    this.steps = [];
    if (options.all === true) {
      for (const state of this.calls.values()) {
        for (const open of state.openSteps.values()) {
          snapshot.steps.push(this.closeStep(open, { error: 'run ended before the model answered' }));
        }
      }
      this.calls.clear();
    }
    return snapshot;
  }

  /** True while any step has started and not yet ended; useful in tests. */
  get pending(): boolean {
    return [...this.calls.values()].some((state) => state.openSteps.size > 0);
  }

  private onStart(event: StartEvent): void {
    if (this.disposed) return;
    if (event.operationId !== 'ai.generateText' && event.operationId !== 'ai.streamText') return;
    const parent = this.toolAncestry.getStore();
    const scope = currentAiTraceScope();
    // A generation made inside a tool is its own nested run, never a
    // continuation of the step's run, so the parent link stays meaningful.
    const stepScope =
      scope !== undefined && scope.api !== undefined && parent === undefined ? scope : undefined;
    const existing = stepScope === undefined ? undefined : this.stepRuns.get(stepScope);
    if (existing !== undefined) {
      this.calls.set(event.callId, { runId: existing.runId, openSteps: new Map(), run: existing });
      return;
    }
    const run: RunCounter = { runId: randomUUID(), steps: 0 };
    if (stepScope !== undefined) this.stepRuns.set(stepScope, run);
    const runId = run.runId;
    this.calls.set(event.callId, { runId, openSteps: new Map(), run });
    // The test title and the step label are test-authored text: redacted
    // like every other record, the scope object itself left as the key.
    const name = runName(scope, event.functionId);
    this.runs.push({
      id: runId,
      started_at: new Date().toISOString(),
      parent_run_id: parent?.runId ?? null,
      parent_step_id: parent?.stepId ?? null,
      function_id: name === null ? null : this.redact(name),
      e2e: scope === undefined ? undefined : redactLeaves(scope, this.redact),
    });
  }

  private onStepStart(event: StepStartEvent): void {
    const state = this.calls.get(event.callId);
    if (state === undefined) return;
    const stepNumber = state.run.steps;
    state.run.steps += 1;
    const open: OpenStep = {
      id: randomUUID(),
      runId: state.runId,
      stepNumber,
      modelId: event.modelId,
      provider: event.provider,
      startedAt: new Date().toISOString(),
      startedMs: Date.now(),
      prompt: promptMessages(event.instructions, event.messages),
      tools: undefined,
      toolChoice: event.toolChoice,
      responseTimeMs: undefined,
    };
    state.openSteps.set(event.stepNumber, open);
  }

  /**
   * The request as actually sent: after `prepareStep`, with the prepared tool
   * definitions carrying their JSON schemas. This supersedes the step-start
   * view, which predates per-step message compaction and tool filtering.
   */
  private onModelCallStart(event: ModelCallStartEvent): void {
    const open = this.newestOpen(event.callId);
    if (open === undefined) return;
    if (Array.isArray(event.messages)) {
      open.prompt = promptMessages(event.instructions, event.messages);
    }
    if (event.tools !== undefined) {
      open.tools = event.tools.map((tool) => ({
        name: tool['name'],
        ...(tool['description'] === undefined ? {} : { description: tool['description'] }),
        ...(tool['inputSchema'] === undefined ? {} : { parameters: tool['inputSchema'] }),
      }));
    }
    if (event.toolChoice !== undefined) open.toolChoice = event.toolChoice;
  }

  private onModelCallEnd(event: ModelCallEndEvent): void {
    const open = this.newestOpen(event.callId);
    if (open === undefined) return;
    const responseTimeMs = event.performance?.responseTimeMs;
    if (typeof responseTimeMs === 'number') open.responseTimeMs = responseTimeMs;
  }

  private onStepEnd(event: StepEndEvent): void {
    const state = this.calls.get(event.callId);
    const open = state?.openSteps.get(event.stepNumber);
    if (state === undefined || open === undefined) return;
    state.openSteps.delete(event.stepNumber);
    const response = event.response;
    this.steps.push(
      this.closeStep(open, {
        output: {
          content: event.content,
          finishReason: event.finishReason,
          response: {
            id: response.id,
            modelId: response.modelId,
            timestamp: response.timestamp,
            messages: traceMessages(response.messages),
          },
          ...(event.providerMetadata === undefined ? {} : { providerMetadata: event.providerMetadata }),
        },
        usage: event.usage,
      }),
    );
  }

  private onEnd(event: EndEvent): void {
    const state = this.calls.get(event.callId);
    if (state === undefined) return;
    // Steps that never reported an end (aborted mid-flight) close here so
    // nothing dangles once the generation itself is over.
    for (const open of state.openSteps.values()) {
      this.steps.push(this.closeStep(open, { error: 'the generation ended before this step did' }));
    }
    this.calls.delete(event.callId);
  }

  private onError(event: ErrorEvent | undefined): void {
    const callId = event?.callId;
    if (callId === undefined) return;
    const state = this.calls.get(callId);
    if (state === undefined) return;
    const cause = event?.error;
    const message = cause instanceof Error ? cause.message : String(cause ?? 'unknown error');
    for (const open of state.openSteps.values()) {
      this.steps.push(this.closeStep(open, { error: message }));
    }
    this.calls.delete(callId);
  }

  private newestOpen(callId: string): OpenStep | undefined {
    const state = this.calls.get(callId);
    if (state === undefined) return undefined;
    return [...state.openSteps.values()].at(-1);
  }

  /**
   * The one place a step record is finalized. String leaves are redacted
   * before serialization, so keys and JSON structure survive a secret that
   * is itself JSON punctuation or a property name: a viewer can still parse
   * every column.
   */
  private closeStep(
    open: OpenStep,
    outcome: { output?: unknown; usage?: unknown; error?: string },
  ): AiTraceStep {
    return {
      id: open.id,
      run_id: open.runId,
      step_number: open.stepNumber + 1,
      type: 'generate',
      model_id: open.modelId,
      provider: open.provider,
      started_at: open.startedAt,
      duration_ms: open.responseTimeMs ?? Date.now() - open.startedMs,
      input: stringify(
        redactLeaves(
          {
            prompt: traceMessages(open.prompt),
            ...(open.tools === undefined ? {} : { tools: open.tools }),
            ...(open.toolChoice === undefined ? {} : { toolChoice: open.toolChoice }),
          },
          this.redact,
        ),
      ),
      output: outcome.output === undefined ? null : stringify(redactLeaves(outcome.output, this.redact)),
      usage: outcome.usage === undefined ? null : stringify(redactLeaves(outcome.usage, this.redact)),
      error: outcome.error === undefined ? null : this.redact(outcome.error),
    };
  }
}

/**
 * The document, or one drained snapshot, passed through `redact` once more
 * with the ledger as it stands: a value a provider resolved after a step
 * closed is covered when a worker ships its records and when the file is
 * written. The JSON columns are parsed, redacted leaf by leaf, and serialized
 * again, so what a viewer reads keeps its structure whatever the value.
 */
export function redactAiTraceDocument(
  document: AiTraceDocument,
  redact: (text: string) => string,
): AiTraceDocument {
  return {
    runs: redactLeaves(document.runs, redact),
    steps: document.steps.map((step) => ({
      ...step,
      input: redactColumn(step.input, redact),
      output: step.output === null ? null : redactColumn(step.output, redact),
      usage: step.usage === null ? null : redactColumn(step.usage, redact),
      error: step.error === null ? null : redact(step.error),
    })),
  };
}

/** A serialized JSON column with its string leaves redacted; text that is not JSON is redacted as text. */
function redactColumn(column: string, redact: (text: string) => string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(column);
  } catch {
    return redact(column);
  }
  return JSON.stringify(redactLeaves(parsed, redact));
}

/**
 * Registers a recorder with the AI SDK. The SDK is an optional peer: when it
 * is absent no model call can go through it, so there is nothing to record
 * and the absence is not an error here.
 */
export async function registerAiTraceRecorder(
  recorder: AiTraceRecorder,
  load: () => Promise<{ registerTelemetry: (...integrations: Telemetry[]) => void }>,
): Promise<void> {
  let sdk: { registerTelemetry: (...integrations: Telemetry[]) => void };
  try {
    sdk = await load();
  } catch {
    return;
  }
  sdk.registerTelemetry(recorder.telemetry);
}

/** Merges drained snapshots into one document; call order is arrival order. */
export class AiTraceCollector {
  private readonly runs: AiTraceRun[] = [];
  private readonly steps: AiTraceStep[] = [];

  merge(snapshot: AiTraceSnapshot): void {
    this.runs.push(...snapshot.runs);
    this.steps.push(...snapshot.steps);
  }

  /**
   * The document to write. Workers drain in batches, so records are put back
   * in start order: viewers read file order as time order.
   */
  document(): AiTraceDocument {
    const byStart = (a: { started_at: string }, b: { started_at: string }) =>
      a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0;
    return {
      runs: this.runs.toSorted(byStart),
      steps: this.steps.toSorted(byStart),
    };
  }

  get size(): number {
    return this.steps.length;
  }
}

/**
 * The prompt as a message list. The SDK keeps the system prompt apart from
 * the conversation (`instructions`); viewers attribute tokens per message
 * role, so it is put back in front as system messages.
 */
function promptMessages(instructions: unknown, messages: unknown[]): unknown[] {
  const system: unknown[] = [];
  if (typeof instructions === 'string') {
    system.push({ role: 'system', content: instructions });
  } else if (Array.isArray(instructions)) {
    system.push(...instructions);
  } else if (instructions !== undefined && instructions !== null) {
    system.push(instructions);
  }
  return [...system, ...messages];
}

function runName(scope: AiTraceScope | undefined, functionId: string | undefined): string | null {
  if (scope === undefined) return functionId ?? null;
  const parts = [scope.test];
  // A test run as several agents is several runs; the name tells them apart.
  if (scope.agent !== 'default') parts.push(`as ${scope.agent}`);
  if (scope.attempt > 0) parts.push(`attempt ${scope.attempt + 1}`);
  if (scope.api !== undefined) {
    const label =
      scope.label === undefined || scope.label === '' ? '' : ` ${JSON.stringify(truncate(scope.label))}`;
    parts.push(`${scope.api}${label}`);
  }
  return parts.join(' · ');
}

function truncate(text: string): string {
  return text.length <= MAX_LABEL_CHARS ? text : `${text.slice(0, MAX_LABEL_CHARS)}…`;
}

/** Copies SDK messages with inline media omitted, without inspecting user JSON. */
function traceMessages(messages: readonly unknown[] | undefined): unknown[] | undefined {
  return messages?.map((message) => {
    const record = traceObject(message);
    if (record === undefined || !['user', 'assistant', 'tool'].includes(String(record['role']))) return message;
    return { ...record, content: traceContent(record['content']) };
  });
}

/** Omits encoded media only in SDK content parts and structured tool outputs. */
function traceContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part: unknown) => {
    const record = traceObject(part);
    if (record === undefined) return part;
    switch (record['type']) {
      case 'image':
        return { ...record, image: omitInlineData(record['image']) };
      case 'file':
      case 'reasoning-file': {
        const data = traceObject(record['data']);
        if (data?.['type'] === 'data') {
          return { ...record, data: { ...data, data: omitInlineData(data['data']) } };
        }
        if (data?.['type'] === 'url') {
          return { ...record, data: { ...data, url: omitDataUrl(data['url']) } };
        }
        return { ...record, data: omitInlineData(record['data']) };
      }
      case 'image-data':
      case 'file-data':
        return { ...record, data: omitInlineData(record['data']) };
      case 'image-url':
      case 'file-url':
        return { ...record, url: omitDataUrl(record['url']) };
      case 'tool-result': {
        const output = traceObject(record['output']);
        return output?.['type'] === 'content'
          ? { ...record, output: { ...output, value: traceContent(output['value']) } }
          : part;
      }
      default:
        return part;
    }
  });
}

/** The object fields needed to read an SDK content part. */
function traceObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Keeps remote URLs and references while omitting inline binary data without decoding it. */
function omitInlineData(value: unknown): unknown {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return binaryNote(value.byteLength);
  if (value instanceof URL) return omitDataUrl(value);
  if (typeof value !== 'string') return value;
  const prefix = /^data:[^,]*;base64,/i.exec(value);
  if (prefix === null && /^[a-z][a-z\d+.-]*:/i.test(value)) return value;
  const encoded = (prefix === null ? value : value.slice(prefix[0].length)).replaceAll(/\s/g, '');
  return binaryNote(Buffer.byteLength(encoded, 'base64'));
}

/** A base64 data URL contains inline bytes; other URL forms remain useful diagnostics. */
function omitDataUrl(value: unknown): unknown {
  const url = value instanceof URL ? value.href : value;
  return typeof url === 'string' && /^data:[^,]*;base64,/i.test(url) ? omitInlineData(url) : value;
}

/** The existing devtools-compatible marker for omitted media. */
function binaryNote(bytes: number): string {
  return `[binary ${bytes} bytes omitted]`;
}

/** JSON with binary views omitted; arbitrary strings and raw tool JSON are preserved. */
export function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (current instanceof ArrayBuffer || ArrayBuffer.isView(current)) return binaryNote(current.byteLength);
    if (typeof current === 'bigint') return current.toString();
    return current;
  });
}
