/**
 * The live half of `e2e mcp`: one open attempt on one target, driven by a
 * coding agent through the same tools the testing agent gets.
 *
 * The session is one long `agent.act()` step whose executor is not a model
 * loop but a queue: every MCP tool call is a job the executor runs inside
 * the step, so observations, actions, secrets, origin policy, budgets, and
 * recording are the harness's own, byte for byte what a test step sees.
 * `createGrammarTools` supplies the vocabulary; nothing here reimplements a
 * verb.
 */

import type { ToolSet } from 'ai';
import path from 'node:path';
import { z } from 'zod';
import { executorTools, projectToolsFor } from '../agent/default-agent.ts';
import type { StepExecutor, StepExecutorContext, StepVerdict } from '../agent/executor.ts';
import { createGrammarTools } from '../agent/primitives.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import { credentials, setCredentialRegistry } from '../credentials.ts';
import { createEngineSession } from '../engine/session.ts';
import type { GrammarVerb, LocatorExpression, SemanticNode } from '../engine/surface.ts';
import { ConfigurationError, errorMessage } from '../internal/errors.ts';
import { uuidv7 } from '../internal/ids.ts';
import { describeExpression, roleQuery, testIdQuery, textQuery } from '../locator/expression.ts';
import { LocatorEngine } from '../locator/engine.ts';
import { openStandaloneAttempt, type StandaloneAttempt } from '../run/standalone.ts';
import type { AgentParams, Role } from '../types.ts';
import { adaptToolSet, errorResult, textResult, type McpToolResult, type McpToolSpec } from './tools.ts';

/** How long one session may live, whatever happens. */
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
/** A session nobody has touched for this long is closed, so no browser is left behind. */
const SESSION_IDLE_MS = 30 * 60 * 1000;
/** Budgets a dev-loop step never reaches; the deadline is the real bound. */
const UNBOUNDED = 1_000_000;
/** How many matching nodes `locate` describes. */
const MAX_LOCATE_NODES = 10;
const SESSION_INSTRUCTION = 'Interactive session: a coding agent drives the app over MCP.';

/**
 * The executor behind a session: `runStep` hands its context out and then
 * runs, one at a time and in order, every job the host submits, until the
 * host finishes the step or the harness stops it. Jobs run inside the
 * step's async scope, so the recorder attributes their events to the step.
 */
class QueueExecutor implements StepExecutor {
  readonly name = 'e2e-mcp';
  readonly version = '1';
  readonly cache = 'off' as const;
  private readonly jobs: { run: (context: StepExecutorContext) => Promise<unknown>; settle: (outcome: { value?: unknown; error?: unknown }) => void }[] = [];
  private wake: (() => void) | undefined;
  private verdict: StepVerdict | undefined;
  private stopped: unknown | undefined;
  private resolveContext!: (context: StepExecutorContext) => void;
  /** The step context, once the harness opened the step. */
  readonly context: Promise<StepExecutorContext> = new Promise((resolve) => {
    this.resolveContext = resolve;
  });

  async runStep(context: StepExecutorContext): Promise<StepVerdict> {
    this.resolveContext(context);
    const onAbort = (): void => this.stop(context.signal.reason ?? new Error('the session step was stopped'));
    context.signal.addEventListener('abort', onAbort, { once: true });
    try {
      while (this.verdict === undefined && this.stopped === undefined) {
        const job = this.jobs.shift();
        if (job === undefined) {
          await new Promise<void>((resolve) => {
            this.wake = resolve;
          });
          continue;
        }
        try {
          job.settle({ value: await job.run(context) });
        } catch (error) {
          job.settle({ error });
        }
      }
    } finally {
      context.signal.removeEventListener('abort', onAbort);
      this.drain();
    }
    if (this.verdict !== undefined) return this.verdict;
    throw this.stopped;
  }

  /** Runs one job inside the step, after every job submitted before it. */
  submit<T>(run: (context: StepExecutorContext) => Promise<T>): Promise<T> {
    if (this.verdict !== undefined || this.stopped !== undefined) {
      return Promise.reject(new ConfigurationError('NO_SESSION', 'the session has ended; open_session again'));
    }
    return new Promise<T>((resolve, reject) => {
      this.jobs.push({
        run,
        settle: (outcome) => (outcome.error === undefined ? resolve(outcome.value as T) : reject(outcome.error)),
      });
      this.wake?.();
      this.wake = undefined;
    });
  }

  /** Concludes the step; queued jobs are refused. */
  finish(verdict: StepVerdict): void {
    this.verdict ??= verdict;
    this.wake?.();
    this.wake = undefined;
  }

  private stop(reason: unknown): void {
    this.stopped ??= reason;
    this.wake?.();
    this.wake = undefined;
  }

  private drain(): void {
    const reason = new ConfigurationError('NO_SESSION', 'the session ended before this call ran');
    for (const job of this.jobs.splice(0)) job.settle({ error: reason });
  }
}

interface LiveSession {
  readonly id: string;
  readonly target: ResolvedTarget;
  readonly attempt: StandaloneAttempt;
  readonly executor: QueueExecutor;
  readonly context: StepExecutorContext;
  readonly tools: ToolSet;
  readonly locator: LocatorEngine;
  /** Settles when the underlying `agent.act()` step ends, for any reason. */
  readonly done: Promise<{ error?: unknown }>;
  readonly abort: AbortController;
  idleTimer: NodeJS.Timeout | undefined;
  actions: number;
}

export interface SessionHostOptions {
  /** The config as loaded at startup, for tool registration; undefined when it failed to load. */
  readonly config: ResolvedConfig | undefined;
  /** Loads the config fresh for each session, so an edited config applies without a restart. */
  readonly loadConfig: () => Promise<ResolvedConfig>;
  readonly env: NodeJS.ProcessEnv;
  readonly headed: boolean;
  /** The target every session opens on, from `--target`; a call may still name one. */
  readonly defaultTarget?: string | undefined;
  readonly log: (level: 'info' | 'warning' | 'error', message: string) => void;
  readonly idleMs?: number | undefined;
  readonly ttlMs?: number | undefined;
}

/** Owns at most one live session and the MCP tools that drive it. */
export class SessionHost {
  private live: LiveSession | undefined;
  private opening: Promise<string> | undefined;
  /** Why the previous session ended, for the error a call on a closed session gets. */
  private lastEnd: string | undefined;

  constructor(private readonly options: SessionHostOptions) {}

  get isOpen(): boolean {
    return this.live !== undefined;
  }

  /** Every session tool, in the order clients list them. */
  toolSpecs(): McpToolSpec[] {
    return [this.openSpec(), ...this.grammarSpecs(), this.locateSpec(), this.screenshotSpec(), ...this.projectSpecs(), this.closeSpec()];
  }

  /** Opens a session on the target and returns its opening text. */
  open(targetName: string | undefined): Promise<string> {
    if (this.live !== undefined) {
      return Promise.reject(
        new ConfigurationError(
          'SESSION_OPEN',
          `a session is already open on target "${this.live.target.name}"; use it, or close_session first`,
        ),
      );
    }
    this.opening ??= this.openSession(targetName).finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  /** Closes the live session, if any, and returns what happened. */
  async close(reason: string): Promise<string> {
    const live = this.live;
    if (live === undefined) return 'No session is open.';
    this.live = undefined;
    this.lastEnd = reason;
    if (live.idleTimer !== undefined) clearTimeout(live.idleTimer);
    live.executor.finish({ status: 'passed', summary: `session closed: ${reason}` });
    const outcome = await live.done;
    const cleanupErrors = await live.attempt.close();
    live.abort.abort();
    setCredentialRegistry(undefined);
    const lines = [`Session ${live.id} closed (${reason}); ${live.actions} tool calls ran.`];
    if (outcome.error !== undefined) lines.push(`The session step ended with: ${errorMessage(outcome.error)}`);
    for (const error of cleanupErrors) lines.push(`Cleanup: ${error.code}: ${error.message}`);
    return lines.join('\n');
  }

  private async openSession(targetName: string | undefined): Promise<string> {
    const base = await this.options.loadConfig();
    const target = this.resolveTarget(base, targetName);
    const executor = new QueueExecutor();
    const config: ResolvedConfig = {
      ...base,
      agent: { ...base.agent, executor, maxSteps: UNBOUNDED, maxModelCalls: UNBOUNDED },
    };
    const ttlMs = this.options.ttlMs ?? SESSION_TTL_MS;
    const abort = new AbortController();
    const id = uuidv7();
    // The credential registry is process-wide; the session holds it while open.
    setCredentialRegistry(config.credentials);
    try {
      const attempt = await openStandaloneAttempt({
        config,
        target,
        headed: this.options.headed,
        env: this.options.env,
        signal: abort.signal,
        timeoutMs: ttlMs + 60_000,
        artifactsRoot: path.join(config.projectRoot, '.e2e', 'artifacts'),
        notice: (scope, message) => this.options.log('info', `${scope}: ${message}`),
      });
      const params = this.secretParams(config);
      const done: Promise<{ error?: unknown }> = attempt.fixtures.agent
        .act(SESSION_INSTRUCTION, params, { timeout: ttlMs })
        .then((): { error?: unknown } => ({}), (error: unknown): { error?: unknown } => ({ error }));
      const context = await Promise.race([
        executor.context,
        done.then((outcome) => {
          throw outcome.error ?? new Error('the session step ended before it started');
        }),
      ]);
      const live: LiveSession = {
        id,
        target,
        attempt,
        executor,
        context,
        tools: {
          ...projectToolsFor(context, executorTools(base.agent.executor)),
          ...createGrammarTools(context),
        },
        locator: new LocatorEngine({
          session: attempt.session,
          budget: attempt.budget,
          runId: attempt.runId,
          attemptId: attempt.attemptId,
          actionTimeout: config.actionTimeout,
          assertionTimeout: config.assertionTimeout,
        }),
        done,
        abort,
        idleTimer: undefined,
        actions: 0,
      };
      this.live = live;
      this.lastEnd = undefined;
      // A step that ends on its own (the TTL, a hard stop) ends the session.
      void done.then(async (outcome) => {
        if (this.live !== live) return;
        const why = outcome.error === undefined ? 'the session step concluded' : errorMessage(outcome.error);
        this.options.log('warning', `session ${id} ended: ${why}`);
        await this.close(why);
      });
      this.touch(live);
      return this.opening_text(live, config, await this.firstScreen(live));
    } catch (cause) {
      abort.abort();
      setCredentialRegistry(undefined);
      throw cause;
    }
  }

  /** Opens the app when the engine can navigate, then observes. */
  private async firstScreen(live: LiveSession): Promise<string> {
    const base = live.target.app.base?.href;
    if (base !== undefined && live.context.target.verbs.has('navigate')) {
      try {
        await live.executor.submit((context) => context.actions.navigate(base));
      } catch (cause) {
        return `Opening ${base} failed: ${errorMessage(cause)}\nUse navigate once the app is reachable.`;
      }
    }
    const observation = await live.executor.submit((context) => context.observe());
    return `Current screen (revision ${observation.revision})${observation.path === undefined ? '' : ` at ${observation.path}`}:\n${observation.text}`;
  }

  private opening_text(live: LiveSession, config: ResolvedConfig, screen: string): string {
    const engine = live.target.engine;
    const lines = [
      `Session ${live.id} open on target "${live.target.name}" (platform ${live.target.platform}, engine ${engine === undefined ? 'none' : `${engine.name} ${engine.version}`}), ${this.options.headed ? 'headed' : 'headless'}.`,
    ];
    if (live.target.app.base !== undefined) {
      lines.push(`App: ${live.target.app.base.href}; allowed origins: ${live.target.app.allowedOrigins.join(', ')}.`);
    }
    if (config.credentials.size > 0) {
      const described = [...config.credentials.values()].map(
        (credential) => `"${credential.name}" (username ${JSON.stringify(credential.username)})`,
      );
      lines.push(`Credentials: ${described.join(', ')}. Type the username with type; fill the password with type_secret and the credential name.`);
    }
    const names = Object.keys(live.tools);
    lines.push(
      `Tools: ${[...names, 'locate', 'screenshot', 'close_session'].join(', ')}. Node ids ("n42") are valid only for the newest observation; every action returns the updated screen. Close the session when you are done.`,
    );
    return `${lines.join('\n')}\n\n${screen}`;
  }

  private resolveTarget(config: ResolvedConfig, requested: string | undefined): ResolvedTarget {
    const name = requested ?? this.options.defaultTarget;
    const names = config.targets.map((target) => target.name);
    if (name !== undefined) {
      const target = config.targets.find((candidate) => candidate.name === name);
      if (target === undefined) {
        throw new ConfigurationError('UNKNOWN_TARGET', `unknown target "${name}"; the config declares ${names.map((n) => `"${n}"`).join(', ')}`);
      }
      return target;
    }
    const [only] = config.targets;
    if (only !== undefined && config.targets.length === 1) return only;
    if (only === undefined) throw new ConfigurationError('INVALID_CONFIG', 'the config declares no targets');
    throw new ConfigurationError(
      'TARGET_REQUIRED',
      `the config declares several targets (${names.join(', ')}); pass target to open_session, or start e2e mcp --target <name>`,
    );
  }

  /** Every configured credential's password as a step secret, so `type_secret` can fill it. */
  private secretParams(config: ResolvedConfig): AgentParams | undefined {
    if (config.credentials.size === 0) return undefined;
    return Object.fromEntries([...config.credentials.keys()].map((name) => [name, credentials.user(name).password]));
  }

  private requireLive(): LiveSession {
    if (this.live === undefined) {
      const previous = this.lastEnd === undefined ? '' : ` (the previous session ended: ${this.lastEnd})`;
      throw new ConfigurationError('NO_SESSION', `no session is open; call open_session first${previous}`);
    }
    return this.live;
  }

  private touch(live: LiveSession): void {
    if (live.idleTimer !== undefined) clearTimeout(live.idleTimer);
    const idleMs = this.options.idleMs ?? SESSION_IDLE_MS;
    live.idleTimer = setTimeout(() => {
      if (this.live !== live) return;
      this.options.log('warning', `session ${live.id} idle for ${Math.round(idleMs / 60_000)} minutes; closing it`);
      void this.close('idle timeout');
    }, idleMs);
    live.idleTimer.unref();
  }

  /** Runs one tool body inside the live session's step. */
  private run<T>(body: (context: StepExecutorContext) => Promise<T>): Promise<T> {
    const live = this.requireLive();
    this.touch(live);
    live.actions += 1;
    return live.executor.submit(body);
  }

  // --- tool specs ---

  /** The grammar verbs the registration target(s) can honor, so unsupported verbs are never offered. */
  private registrationVerbs(): ReadonlySet<GrammarVerb> {
    const config = this.options.config;
    const all: GrammarVerb[] = ['tap', 'type', 'typeSecret', 'press', 'select', 'scroll', 'navigate'];
    if (config === undefined) return new Set(all);
    const targets =
      this.options.defaultTarget === undefined
        ? config.targets
        : config.targets.filter((target) => target.name === this.options.defaultTarget);
    const verbs = new Set<GrammarVerb>();
    for (const target of targets.length === 0 ? config.targets : targets) {
      for (const verb of createEngineSession({ engine: target.engine, targetName: target.name }).verbs) verbs.add(verb);
    }
    return verbs;
  }

  /** A context with only what tool construction reads: verbs, platform, and the declared secrets. */
  private stubContext(): StepExecutorContext {
    const config = this.options.config;
    const target =
      config?.targets.find((candidate) => candidate.name === this.options.defaultTarget) ?? config?.targets[0];
    const secrets = [...(config?.credentials.values() ?? [])].map((credential) => ({ name: credential.name, purpose: 'password' as const }));
    return {
      target: { name: target?.name ?? 'default', platform: target?.platform ?? 'web', verbs: this.registrationVerbs() },
      step: { kind: 'act', index: 0, instruction: SESSION_INSTRUCTION, params: undefined, secrets },
    } as unknown as StepExecutorContext;
  }

  private grammarSpecs(): McpToolSpec[] {
    return adaptToolSet(
      createGrammarTools(this.stubContext()),
      (_name, execute) => this.run(() => execute()),
      () => this.live?.tools ?? {},
    );
  }

  private projectSpecs(): McpToolSpec[] {
    const tools = executorTools(this.options.config?.agent.executor);
    if (Object.keys(tools).length === 0) return [];
    return adaptToolSet(
      projectToolsFor(this.stubContext(), tools),
      (_name, execute) => this.run(() => execute()),
      () => this.live?.tools ?? {},
      (name) => tools[name]?.annotations.mutates === false,
    );
  }

  private openSpec(): McpToolSpec {
    return {
      name: 'open_session',
      description:
        'Open a live session on one target: starts the app command the engine declares (if any), boots the engine (a browser, a simulator), opens the app URL, and returns the first observation. One session at a time; run_tests closes it. Node ids in the observation address nodes for tap, type, press, select, and scroll.',
      inputSchema: z.object({
        target: z.string().min(1).optional().describe('Target name from e2e.config.ts; required when the config declares several'),
      }),
      readOnly: false,
      call: async (args) => {
        try {
          return textResult(await this.open(typeof args['target'] === 'string' ? args['target'] : undefined));
        } catch (cause) {
          return errorResult(cause);
        }
      },
    };
  }

  private closeSpec(): McpToolSpec {
    return {
      name: 'close_session',
      description: 'Close the live session: end the attempt, dispose the engine, and stop the app processes the session started.',
      inputSchema: z.object({}),
      readOnly: false,
      call: async () => {
        try {
          return textResult(await this.close('closed by the agent'));
        } catch (cause) {
          return errorResult(cause);
        }
      },
    };
  }

  private screenshotSpec(): McpToolSpec {
    return {
      name: 'screenshot',
      description:
        'Look at the masked pixels of the current screen. Secure fields are masked; the image is withheld when masking cannot be proven or a secret was filled in this session. Use when the observation tree is sparse or contradicts what you expect.',
      inputSchema: z.object({}),
      readOnly: true,
      call: async () => {
        try {
          const observation = await this.run((context) => context.observe({ pixels: true }));
          if (observation.pixels === undefined) {
            return textResult(`Screenshot withheld: ${observation.pixelsWithheld ?? 'the engine captures no pixels'}. The observation tree is still available through observe.`);
          }
          const { data, mediaType, width, height } = observation.pixels;
          return {
            content: [
              { type: 'text', text: `Screen ${width}x${height} at revision ${observation.revision}${observation.path === undefined ? '' : ` (${observation.path})`}.` },
              { type: 'image', data: Buffer.from(data).toString('base64'), mimeType: mediaType },
            ],
          };
        } catch (cause) {
          return errorResult(cause);
        }
      },
    };
  }

  private locateSpec(): McpToolSpec {
    return {
      name: 'locate',
      description:
        'Try a semantic locator against the live screen before writing it into a test: screen.getByRole(role, { name }), getByText, getByLabel, getByPlaceholder, or getByTestId. Returns how many nodes match and which, plus the test code to use. Exactly one of role, text, label, placeholder, or testId; name narrows a role query. Matching is exact unless exact is false. Read-only.',
      inputSchema: z.object({
        role: z.string().min(1).optional().describe('ARIA role, e.g. "button", "textbox", "link"'),
        name: z.string().min(1).optional().describe('Accessible name, with role'),
        text: z.string().min(1).optional(),
        label: z.string().min(1).optional(),
        placeholder: z.string().min(1).optional(),
        testId: z.string().min(1).optional(),
        exact: z.boolean().optional().describe('false for substring, case-insensitive matching'),
      }),
      readOnly: true,
      call: async (args) => {
        try {
          const query = locateQuery(args);
          const live = this.requireLive();
          const nodes = await this.run(async () => {
            const refs = await live.locator.resolveAll(query.expression);
            const read: SemanticNode[] = [];
            for (const ref of refs.slice(0, MAX_LOCATE_NODES)) {
              read.push(await live.attempt.session.read(ref, live.locator.operation()));
            }
            return { count: refs.length, read };
          });
          return textResult(describeLocate(query, nodes.count, nodes.read));
        } catch (cause) {
          return errorResult(cause);
        }
      },
    };
  }
}

interface LocateQuery {
  readonly expression: LocatorExpression;
  readonly code: string;
}

/** Builds the expression and the matching `screen.*` call from the tool arguments. */
export function locateQuery(args: Record<string, unknown>): LocateQuery {
  const str = (key: string): string | undefined => (typeof args[key] === 'string' ? (args[key] as string) : undefined);
  const exact = args['exact'] !== false;
  const exactOption = exact ? '' : ', exact: false';
  const role = str('role');
  const name = str('name');
  const text = str('text');
  const label = str('label');
  const placeholder = str('placeholder');
  const testId = str('testId');
  const given = [role, text, label, placeholder, testId].filter((value) => value !== undefined).length;
  if (given !== 1) {
    throw new ConfigurationError('INVALID_ARGUMENT', 'locate needs exactly one of role, text, label, placeholder, or testId');
  }
  if (role !== undefined) {
    const options = name === undefined ? '' : `, { name: ${JSON.stringify(name)}${exactOption} }`;
    return {
      expression: roleQuery(role as Role, name === undefined ? undefined : { name, exact }, undefined),
      code: `screen.getByRole(${JSON.stringify(role)}${options})`,
    };
  }
  if (name !== undefined) throw new ConfigurationError('INVALID_ARGUMENT', 'name only narrows a role query');
  if (testId !== undefined) return { expression: testIdQuery(testId, undefined, undefined), code: `screen.getByTestId(${JSON.stringify(testId)})` };
  const options = exact ? '' : `, { exact: false }`;
  if (text !== undefined) return { expression: textQuery('text', text, { exact }, undefined), code: `screen.getByText(${JSON.stringify(text)}${options})` };
  if (label !== undefined) return { expression: textQuery('label', label, { exact }, undefined), code: `screen.getByLabel(${JSON.stringify(label)}${options})` };
  return { expression: textQuery('placeholder', placeholder!, { exact }, undefined), code: `screen.getByPlaceholder(${JSON.stringify(placeholder)}${options})` };
}

/** Renders a locate result: the count, the verdict a test would get, and the nodes. */
export function describeLocate(query: LocateQuery, count: number, nodes: readonly SemanticNode[]): string {
  const lines = [`${count === 1 ? '1 node matches' : `${count} nodes match`} ${describeExpression(query.expression)}.`];
  if (count === 1) lines.push(`Use: ${query.code}`);
  else if (count === 0) lines.push('A test using this locator would fail with LOCATOR_NOT_FOUND. Check the accessible name in the observation (observe), or loosen the match with exact: false.');
  else lines.push(`A test action on ${query.code} would fail with LOCATOR_AMBIGUOUS. Narrow it with { name }, .filter({ hasText }), .first(), or .nth(i), or scope it under a container.`);
  for (const node of nodes) lines.push(`- ${describeNode(node)}`);
  if (count > nodes.length) lines.push(`- and ${count - nodes.length} more`);
  return lines.join('\n');
}

/** A located node by what names it; located refs are not observation ids, so none is shown. */
function describeNode(node: SemanticNode): string {
  const parts = [node.role ?? 'node'];
  if (node.name !== undefined && node.name !== '') parts.push(JSON.stringify(node.name));
  if (node.text !== undefined && node.text !== '' && node.text !== node.name) parts.push(`text ${JSON.stringify(node.text)}`);
  if (node.value !== undefined && node.states?.secure !== true) parts.push(`value ${JSON.stringify(node.value)}`);
  const states = Object.entries(node.states ?? {})
    .filter(([, value]) => value === true)
    .map(([key]) => key);
  if (states.length > 0) parts.push(`[${states.join(', ')}]`);
  return parts.join(' ');
}

/** The result envelope helpers, re-exported so the server never imports the adapter for them. */
export { textResult, errorResult, type McpToolResult, type McpToolSpec };
