import { randomUUID } from 'node:crypto';
import { AgentError, type JsonValue, type StepExecutor, type StepExecutorContext, type StepVerdict } from 'e2e';
import { BASE_RULES, VERDICT_RULES } from 'e2e/agent';
import { ConfigurationError } from 'e2e/engine';
import { claudeCodeLaunch, codexLaunch } from './presets.ts';
import type { Usage } from '@agentclientprotocol/sdk';
import { startSession, type AcpSession, type AgentLaunch, type TurnReport } from './session.ts';
import { activeStep, missingTools, openingScreen, stepTools, verdictOf, type ActiveStep, type StepSlot } from './tools.ts';
import type { ServedTool } from './mcp.ts';
import type { AcpAgentOptions, AcpExecutorOptions } from './types.ts';

/** What the session is, before the built-in agent's rules for the same tools. */
const SESSION_RULES = `This conversation drives a real application for an end-to-end test, one step per message: an action to perform, or an assertion to judge, with the current screen.
Use only the tools of this conversation. You have no access to the application's source, files, shell, or network.
The rules below are for each step. A step ends when you call complete_step; then wait for the next message. For an assertion, judge the condition from the screen without changing anything.`;

const RULES = `${SESSION_RULES}\n\n${BASE_RULES}\n\n${VERDICT_RULES}`;

/** How long a step waits for the turn of a step the runner gave up on to stop. */
const LAST_TURN_GRACE_MS = 5_000;

interface Held {
  readonly session: Promise<AcpSession>;
  readonly slot: StepSlot;
  /** The tools the session lists, fixed for the attempt. */
  readonly tools: readonly ServedTool[];
  introduced: boolean;
  /** The turn in flight, settled or not: one the runner gave up on may still be running. */
  turn: Promise<unknown> | undefined;
}

/**
 * Builds a step executor that runs `agent.act` and `agent.assert` on any
 * ACP agent: one agent session per test attempt, started by its first agent
 * step and closed when the attempt ends. `acpExecutor.claudeCode()` and
 * `.codex()` start those agents with the step tools as their only tools.
 */
export function acpExecutor(options: AcpExecutorOptions): StepExecutor {
  if (typeof options !== 'object' || options === null || typeof options.command !== 'string' || options.command === '') {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      "acpExecutor() takes { command, args }, e.g. acpExecutor({ command: 'agent', args: ['acp'] }), or use acpExecutor.claudeCode() or .codex()",
    );
  }
  const launch: AgentLaunch = {
    command: options.command,
    args: options.args ?? [],
    env: options.env,
    model: options.model,
    mode: options.mode,
    sessionMeta: options.sessionMeta,
  };
  return executor(options.name ?? 'acp', options, async () => launch);
}

/** Claude Code through Zed's adapter (`@agentclientprotocol/claude-agent-acp`), signed in with your `claude` login. */
acpExecutor.claudeCode = (options: AcpAgentOptions = {}): StepExecutor =>
  executor(options.name ?? 'claude-code', options, claudeCodeLaunch(options));

/** Codex through its adapter (`@agentclientprotocol/codex-acp`), signed in with your `codex` login. */
acpExecutor.codex = (options: AcpAgentOptions = {}): StepExecutor => executor(options.name ?? 'codex', options, codexLaunch(options));

function executor(name: string, options: AcpAgentOptions, launch: () => Promise<AgentLaunch>): StepExecutor {
  // Where an attempt's session lives in `attempt.memory`: one key per executor, so two ACP agents never share a session.
  const memoryKey = `@e2e-dev/acp.session.${randomUUID()}`;
  return {
    name,
    version: '1',
    cache: 'inherit',
    async runStep(ctx) {
      const held = hold(ctx, launch, memoryKey);
      let session: AcpSession;
      try {
        session = await untilAborted(held.session, ctx.signal);
      } catch (error) {
        // The next step starts a fresh agent rather than wait on this one.
        ctx.attempt.memory.delete(memoryKey);
        ctx.signal.throwIfAborted();
        if (error instanceof ConfigurationError) throw error;
        throw new AgentError('MODEL_PROVIDER_FAILED', `The ACP agent did not start: ${message(error)}`, { cause: error });
      }
      if (!(await settled(held.turn, LAST_TURN_GRACE_MS))) {
        session.close();
        ctx.attempt.memory.delete(memoryKey);
        throw new AgentError('MODEL_PROVIDER_FAILED', 'The ACP agent did not stop the turn of a step that already ended');
      }
      const active = activeStep(ctx);
      const text = await stepMessage(active, held.tools, held.introduced ? undefined : [RULES, options.system, ctx.agentContext]);
      held.introduced = true;
      held.slot.active = active;
      const cancel = () => session.cancel();
      ctx.signal.addEventListener('abort', cancel, { once: true });
      let report: TurnReport;
      try {
        const turn = session.prompt(text);
        held.turn = turn;
        report = await untilAborted(turn, ctx.signal);
      } catch (error) {
        ctx.signal.throwIfAborted();
        session.close();
        ctx.attempt.memory.delete(memoryKey);
        throw new AgentError('MODEL_PROVIDER_FAILED', `The ACP agent session failed: ${message(error)}`, { cause: error });
      } finally {
        if (held.slot.active === active) held.slot.active = undefined;
        ctx.signal.removeEventListener('abort', cancel);
      }
      ctx.attachTranscript(transcript(text, active, report));
      if (!ctx.signal.aborted) recordTurn(ctx, session, report);
      if (active.halted !== undefined) throw active.halted;
      ctx.signal.throwIfAborted();
      if (active.denied !== undefined) return ownToolUsed(active.denied);
      return verdictOf(active) ?? noConclusion(report);
    },
  };
}

/** Counts one prompt turn as one model call, with what the agent reported of it. */
function recordTurn(ctx: StepExecutorContext, session: AcpSession, report: TurnReport): void {
  const usage = report.usage;
  ctx.budgets.recordModelCall({
    startedAt: report.startedAt,
    durationMs: report.durationMs,
    ...(session.agentName === undefined ? {} : { provider: session.agentName }),
    ...(session.modelId === undefined ? {} : { modelId: session.modelId }),
    ...(usage === undefined
      ? {}
      : {
          inputTokens: inputTokens(usage),
          outputTokens: usage.outputTokens,
          ...(usage.cachedReadTokens == null ? {} : { cacheReadTokens: usage.cachedReadTokens }),
          ...(usage.cachedWriteTokens == null ? {} : { cacheWriteTokens: usage.cachedWriteTokens }),
        }),
    ...(report.costUsd === undefined ? {} : { estimatedCostUsd: report.costUsd }),
  });
}

/** The attempt's session, started on its first step and closed when the attempt ends. */
function hold(ctx: StepExecutorContext, launch: () => Promise<AgentLaunch>, memoryKey: string): Held {
  const existing = ctx.attempt.memory.get(memoryKey) as Held | undefined;
  if (existing !== undefined) return existing;
  let session: AcpSession | undefined;
  let closed = false;
  const slot: StepSlot = { active: undefined, halt: () => session?.cancel() };
  const tools = stepTools(slot, ctx);
  const ownTool = (title: string) => {
    if (slot.active === undefined) return;
    slot.active.denied ??= title;
    session?.cancel();
  };
  const held: Held = {
    slot,
    tools,
    introduced: false,
    turn: undefined,
    session: launch()
      // The first step's end stops a startup still in progress; an open session lives until the attempt ends.
      .then((how) => startSession(how, tools, AbortSignal.any([ctx.attempt.signal, ctx.signal]), ownTool))
      .then((started) => {
        session = started;
        if (closed) started.close();
        return started;
      }),
  };
  held.session.catch(() => undefined);
  ctx.attempt.memory.set(memoryKey, held);
  ctx.attempt.signal.addEventListener(
    'abort',
    () => {
      closed = true;
      session?.close();
    },
    { once: true },
  );
  return held;
}

/** Waits for `promise`, or rejects when the step ends first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort!));
}

/** The message for one step: the rules on the first, then the step, what already ran, and the screen. */
async function stepMessage(active: ActiveStep, tools: readonly ServedTool[], introduction: (string | undefined)[] | undefined): Promise<string> {
  const { ctx } = active;
  const parts: string[] = [];
  if (introduction !== undefined) parts.push(...introduction.filter((part): part is string => part !== undefined && part.trim() !== ''));
  const { step } = ctx;
  parts.push(`${step.kind === 'assert' ? 'Assertion' : 'Step'}: ${step.instruction}`);
  const params = plainParams(step.params);
  if (params !== undefined) parts.push(`Parameters: ${JSON.stringify(params)}`);
  if (step.secrets.length > 0) {
    parts.push(`Secrets to fill with type_secret, by name: ${step.secrets.map((secret) => `${secret.name} (${secret.purpose})`).join(', ')}`);
  }
  const missing = missingTools(active, tools);
  if (missing.length > 0) parts.push(`Not offered in this step: ${missing.join(', ')}.`);
  if (ctx.ledger !== '') parts.push(`Steps completed so far in this test, including any replayed without you:\n${ctx.ledger}`);
  const prefix = ctx.replayedPrefix;
  if (prefix !== undefined) {
    parts.push(
      `A cached replay already performed these actions for this step: ${prefix.replayedActions.join('; ')}. It stopped (${prefix.stopReason}). Continue from the current screen; do not redo them.`,
    );
    if (prefix.uncertainAction !== undefined) {
      parts.push(`This replayed action may have taken effect although it failed: ${prefix.uncertainAction}. Check the screen before doing anything like it again.`);
    }
  }
  parts.push(await openingScreen(active));
  return parts.join('\n\n');
}

/** The params without secret placeholders, which are listed by name instead. */
function plainParams(params: Readonly<Record<string, JsonValue>> | undefined): Record<string, JsonValue> | undefined {
  if (params === undefined) return undefined;
  const plain = Object.fromEntries(
    Object.entries(params).filter(([, value]) => !isSecretPlaceholder(value)),
  );
  return Object.keys(plain).length === 0 ? undefined : plain;
}

/** A secret in the params, as the runner projects it: `{ kind: 'secret', name, purpose }`. */
function isSecretPlaceholder(value: JsonValue): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (value as Record<string, JsonValue>)['kind'] === 'secret';
}

/**
 * The turn's input tokens with the cached ones included, as e2e counts them.
 * ACP leaves open whether an agent's `inputTokens` include them: the Claude
 * adapter's do not (its total adds the cache on top), Codex's do (its total
 * is input and output alone).
 */
function inputTokens(usage: Usage): number {
  const cached = (usage.cachedReadTokens ?? 0) + (usage.cachedWriteTokens ?? 0);
  const cacheApart = cached > 0 && usage.totalTokens >= usage.inputTokens + usage.outputTokens + cached;
  return cacheApart ? usage.inputTokens + cached : usage.inputTokens;
}

/** Whether `promise` settles within `ms`; no promise has nothing to wait for. */
async function settled(promise: Promise<unknown> | undefined, ms: number): Promise<boolean> {
  if (promise === undefined) return true;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const done = promise.then(
    () => true,
    () => true,
  );
  return Promise.race([done, timeout]).finally(() => clearTimeout(timer));
}

/** The verdict of a step where the agent acted with a tool of its own, which the runner neither saw nor recorded. */
function ownToolUsed(title: string): StepVerdict {
  return {
    status: 'failed',
    errorCode: 'POLICY_DENIED',
    summary: `The agent ran a tool of its own without asking (${title}); only the step tools may act, so the step was stopped.`,
  };
}

function noConclusion(report: TurnReport): StepVerdict {
  const said = report.text.trim().split('\n').at(-1)?.slice(0, 300);
  return {
    status: 'failed',
    errorCode: 'STEP_NO_CONCLUSION',
    summary: `The agent ended its turn (${report.stopReason}) without complete_step${said === undefined || said === '' ? '' : `: ${said}`}`,
  };
}

function transcript(prompt: string, active: ActiveStep, report: TurnReport): string {
  return [
    `> ${prompt}`,
    `tools: ${active.calls.join(', ') || 'none'}`,
    ...(report.rejected.length === 0 ? [] : [`rejected tools of the agent's own: ${report.rejected.join(', ')}`]),
    ...(report.ran.length === 0 ? [] : [`tools of the agent's own that ran without asking: ${report.ran.join(', ')}`]),
    `stop: ${report.stopReason}`,
    report.text,
  ].join('\n');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
