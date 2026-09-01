/**
 * Dogfood: the tool-loop chassis with the agent-device AI SDK toolset instead
 * of the web grammar. The harness still owns budgets, deadlines, verdicts,
 * loop guards, and the transcript; agent-device owns the simulator. The
 * driver-facing context (observe, actions) is never touched: every action
 * runs through the device tools, so a web target is only the config host.
 */

import { readFileSync } from 'node:fs';
import type { StepExecutor } from 'e2e';
import { createToolLoopExecutor, type ToolLoopExecutorOptions } from 'e2e/agent';
import { createAgentDeviceTools } from 'agent-device/ai-sdk';
import { jsonSchema, type JSONSchema7, type ModelMessage, type ToolSet } from 'ai';

const DEVICE_RULES = `You are an autonomous end-to-end testing agent executing exactly one test step against a real mobile app through agent-device tools.

Rules:
- Work only toward the given step; do not start the next step or explore beyond it.
- Your first message includes a fresh snapshot of the current screen. The device keeps its state between steps: when the right app and screen are already up, continue from them; never reopen or relaunch an app unless the step asks for a fresh start or the app is not open.
- Snapshot refs like "@e12" are valid only against the newest snapshot or settle diff; act on refs from the latest output and never invent refs. Always pass a ref with its leading "@".
- If the target is not on screen, scroll or navigate to find it, or conclude.
- The device and session are pre-configured. Omit every optional parameter you do not need; never pass empty strings or placeholder values.
- When a tool offers alternative parameters (such as scroll's amount vs pixels, or wait's durationMs vs text vs ref), pass exactly one of them.
- find only searches the current accessibility tree; it does not scroll. Bring off-screen content into view with scroll first, then act by ref.
- In long lists, scroll with direction "bottom" or "top" to jump straight to an edge instead of paging repeatedly.
- Prefer scroll with settle true over swipe in lists: a fling leaves animations running and the next snapshot may catch an empty tree.
- The screenshot tool returns the image itself: when a snapshot is sparse, contradicts what you expect, or an element seems missing, take a screenshot and look at the screen. Only the newest screenshot stays in your history.
- When the step starts in an app left deep in some screen by earlier work, relaunch it (open with relaunch true) instead of navigating back.
- iOS can interrupt at any time with system sheets and permission prompts (Siri or Dictation onboarding, privacy panes, alerts). Dismiss them (Continue, Not Now, OK, Don't Allow) and resume the step; an interrupt you can dismiss is never a reason to conclude blocked.`;

/** Tools that change device or app state; they consume an action-budget slot. */
const MUTATING_TOOLS = new Set([
  'alert',
  'back',
  'click',
  'close',
  'fill',
  'find',
  'open',
  'press',
  'scroll',
  'swipe',
  'type',
]);

export interface AgentDeviceExecutorOptions {
  /** agent-device session name every tool call is pinned to. */
  readonly session: string;
  readonly platform: 'ios' | 'android';
  /** AI SDK language model; defaults to the config-resolved agent model. */
  readonly model?: ToolLoopExecutorOptions['model'];
}

/**
 * Builds a step executor whose whole vocabulary is the agent-device core
 * toolset. Tool construction is async, so the inner chassis executor is
 * built once on the first step and reused for the rest of the run.
 */
export function createAgentDeviceExecutor(options: AgentDeviceExecutorOptions): StepExecutor {
  let inner: Promise<StepExecutor> | undefined;
  return {
    name: 'agent-device',
    version: '1',
    async runStep(context) {
      inner ??= buildInner(options);
      return (await inner).runStep(context);
    },
  };
}

/**
 * Global plumbing options present on every agent-device command. The session
 * pins all of them, and models junk-fill any option they can see, so they are
 * stripped from the tool schemas rather than prompted around. `target` is
 * overloaded and handled separately: interaction commands use it for the UI
 * element, everything else as a deviceTarget alias.
 */
const GLOBAL_OPTION_KEYS = new Set([
  'deviceTarget',
  'device',
  'udid',
  'serial',
  'iosSimulatorDeviceSet',
  'iosXctestrunFile',
  'iosXctestDerivedDataPath',
  'iosXctestEnvDir',
  'androidDeviceAllowlist',
  'daemonBaseUrl',
  'daemonAuthToken',
  'tenant',
  'runId',
  'leaseId',
  'cwd',
  'debug',
  'noRecord',
  'record',
]);

/** True for the `target` variant that aliases deviceTarget, not a UI element. */
function isDeviceTargetAlias(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { enum?: unknown }).enum) &&
    ((value as { enum: unknown[] }).enum).includes('mobile')
  );
}

/** Rebuilds one tool input schema without the pre-configured global options. */
function pruneToolSchema(inputSchema: unknown): unknown {
  const wrapped = inputSchema as { jsonSchema?: JSONSchema7 } | undefined;
  const source = wrapped?.jsonSchema;
  if (source === undefined || typeof source.properties !== 'object') return inputSchema;
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source.properties)) {
    if (GLOBAL_OPTION_KEYS.has(key)) continue;
    if (key === 'target' && isDeviceTargetAlias(value)) continue;
    properties[key] = value;
  }
  return jsonSchema({ ...source, properties } as JSONSchema7);
}

/** Multimodal tool output accepted by the AI SDK's `toModelOutput` hook. */
type ToolModelOutput =
  | { type: 'text'; value: string }
  | {
      type: 'content';
      value: ({ type: 'text'; text: string } | { type: 'file'; data: string; mediaType: string })[];
    };

/**
 * Turns the screenshot tool's `{ path }` result into the image itself, so the
 * model can look at the screen when the accessibility tree is sparse or
 * lying. Errors and unreadable paths fall back to the plain text result.
 */
function screenshotToModelOutput(output: unknown): ToolModelOutput {
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  try {
    const parsed = JSON.parse(text) as { path?: unknown };
    if (typeof parsed.path === 'string') {
      const data = readFileSync(parsed.path).toString('base64');
      return {
        type: 'content',
        value: [
          { type: 'file', data, mediaType: 'image/png' },
          { type: 'text', text },
        ],
      };
    }
  } catch {
    // Error strings and non-JSON results flow through as text below.
  }
  return { type: 'text', value: text };
}

/**
 * Keeps only the newest screenshot verbatim in the transcript. Every older
 * image is dead weight the model re-reads each turn; its part is replaced
 * with a short text stub, mirroring the snapshot compaction of the default
 * web agent.
 */
function compactScreenshotHistory(messages: ModelMessage[]): ModelMessage[] {
  const isImageOutput = (output: unknown): boolean => {
    const candidate = output as { type?: unknown; value?: unknown };
    return (
      candidate?.type === 'content' &&
      Array.isArray(candidate.value) &&
      candidate.value.some((part: { type?: unknown }) => part?.type === 'file')
    );
  };
  const total = messages.reduce(
    (count, message) =>
      message.role === 'tool'
        ? count +
          message.content.filter((part) => part.type === 'tool-result' && isImageOutput(part.output)).length
        : count,
    0,
  );
  let stale = total - 1;
  if (stale <= 0) return messages;
  return messages.map((message) => {
    if (stale <= 0 || message.role !== 'tool') return message;
    const content = message.content.map((part) => {
      if (part.type !== 'tool-result' || !isImageOutput(part.output) || stale <= 0) return part;
      stale -= 1;
      return {
        ...part,
        output: {
          type: 'text' as const,
          value: '[stale screenshot elided; take a new screenshot if you need to look again]',
        },
      };
    });
    return { ...message, content };
  });
}

/** Required property names from a `jsonSchema()`-wrapped tool input schema. */
function requiredKeys(inputSchema: unknown): ReadonlySet<string> {
  const wrapped = inputSchema as { jsonSchema?: { required?: readonly string[] } } | undefined;
  return new Set(wrapped?.jsonSchema?.required ?? []);
}

/**
 * Some models fill every optional parameter with "" or null instead of
 * omitting it, and agent-device rejects present-but-empty options one at a
 * time; dropping empty optionals sends the call the model meant.
 */
function pruneEmptyOptionals(input: unknown, required: ReadonlySet<string>): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  return Object.fromEntries(
    Object.entries(input).filter(([key, value]) => (value !== '' && value !== null) || required.has(key)),
  );
}

/**
 * XCTest-backed snapshots taken mid-animation intermittently return a sparse
 * tree of one Application node. Retrying on the device side costs under a
 * second; returning the sparse tree to the model costs a full model round
 * trip of confusion.
 */
async function retrySparseSnapshot(
  execute: (input: never, options: never) => PromiseLike<unknown>,
  input: unknown,
  executionOptions: unknown,
): Promise<unknown> {
  let result = await execute(input as never, executionOptions as never);
  for (const backoffMs of [1_200, 3_000]) {
    if (!isSparseSnapshot(result)) break;
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    result = await execute(input as never, executionOptions as never);
  }
  return result;
}

function isSparseSnapshot(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false;
  const quality = (result as { snapshotQuality?: { state?: unknown } }).snapshotQuality;
  return quality?.state === 'sparse';
}

/** wait's exactly-one condition parameter, keyed by the declared kind. */
const WAIT_PARAM_BY_KIND: Readonly<Record<string, string>> = {
  duration: 'durationMs',
  text: 'text',
  ref: 'ref',
  selector: 'selector',
  stable: 'stable',
};

/**
 * Deterministic repairs for junk-filled exclusive parameters. scroll takes
 * amount or pixels, never both; wait takes exactly one condition, and its
 * kind field names the one the model meant. Resolving conflicts here spends
 * the call on the device instead of on an INVALID_ARGS round trip.
 */
function sanitizeToolInput(name: string, input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return input;
  const call = { ...(input as Record<string, unknown>) };
  if (name === 'scroll' && typeof call['amount'] === 'number' && typeof call['pixels'] === 'number') {
    if (call['amount'] === 0) delete call['amount'];
    else delete call['pixels'];
  }
  if (name === 'wait') {
    const keep = WAIT_PARAM_BY_KIND[String(call['kind'])];
    if (keep !== undefined) {
      for (const key of Object.values(WAIT_PARAM_BY_KIND)) {
        if (key !== keep) delete call[key];
      }
    }
  }
  return call;
}

/**
 * Serializes one fresh snapshot for the step's opening prompt, so the model
 * starts each step seeing the screen instead of blind. A blind start costs an
 * orientation turn, and in practice the model spends it re-opening the app
 * the previous step already left in the foreground. Undefined when no
 * session or app is up yet (the very first step); the model then opens the
 * app the instruction names.
 */
async function captureScreenText(
  client: Awaited<ReturnType<typeof createAgentDeviceTools>>['client'],
): Promise<string | undefined> {
  try {
    const snapshot = await client.capture.snapshot({ interactiveOnly: true });
    const lines = (snapshot.nodes ?? []).slice(0, 120).map((node) => {
      const value = node.value === undefined ? '' : ` value=${JSON.stringify(node.value)}`;
      return `@${node.ref} [${node.type ?? '?'}] ${JSON.stringify(node.label ?? '')}${value}`;
    });
    return lines.length === 0 ? undefined : lines.join('\n');
  } catch {
    return undefined;
  }
}

async function buildInner(options: AgentDeviceExecutorOptions): Promise<StepExecutor> {
  const { tools, client } = await createAgentDeviceTools({
    session: options.session,
    platform: options.platform,
  });
  return createToolLoopExecutor({
    name: 'agent-device',
    version: '1',
    ...(options.model === undefined ? {} : { model: options.model }),
    system: DEVICE_RULES,
    compactMessages: compactScreenshotHistory,
    tools: (context, helpers) => {
      const accounted: ToolSet = {};
      for (const [name, deviceTool] of Object.entries(tools)) {
        const execute = deviceTool.execute?.bind(deviceTool);
        if (execute === undefined) {
          accounted[name] = deviceTool;
          continue;
        }
        const required = requiredKeys(deviceTool.inputSchema);
        accounted[name] = {
          ...deviceTool,
          inputSchema: pruneToolSchema(deviceTool.inputSchema),
          ...(name === 'screenshot'
            ? { toModelOutput: ({ output }: { output: unknown }) => screenshotToModelOutput(output) }
            : {}),
          execute: (input: never, executionOptions: never) =>
            helpers.guard(async () => {
              const startedMs = Date.now();
              const call = sanitizeToolInput(name, pruneEmptyOptionals(input, required));
              const result =
                name === 'snapshot'
                  ? await retrySparseSnapshot(execute, call, executionOptions)
                  : await execute(call as never, executionOptions);
              context.budgets.recordToolCall({
                name,
                mutates: MUTATING_TOOLS.has(name),
                durationMs: Date.now() - startedMs,
              });
              return typeof result === 'string' ? result : JSON.stringify(result);
            }),
        } as ToolSet[string];
      }
      return accounted;
    },
    buildPrompt: async (context) => {
      const parts = [
        context.step.kind === 'assert'
          ? `Judge whether this assertion holds; do not change application state: ${context.step.instruction}`
          : `Execute this test step: ${context.step.instruction}`,
      ];
      if (context.step.params !== undefined) {
        parts.push(`Step parameters:\n${JSON.stringify(context.step.params, null, 2)}`);
      }
      if (context.ledger !== '') {
        parts.push(`Previously completed steps:\n${context.ledger}`);
      }
      const screen = await captureScreenText(client);
      if (screen !== undefined) {
        parts.push(`Current screen (fresh snapshot; refs are valid to act on):\n${screen}`);
      }
      return parts.join('\n\n');
    },
  });
}
