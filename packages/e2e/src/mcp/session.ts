/**
 * The live session behind `e2e mcp`: one standalone attempt on one target,
 * driven by a coding agent through a fixed, four-tool surface. `open_session`
 * loads the project's config and opens the attempt; `tools` renders the
 * session's catalog (the grammar the engine honors, `observe`, `locate`,
 * `screenshot`, and the project's own tools); `call` runs one catalog tool
 * by name; `close_session` tears everything down. The catalog is data, not
 * registrations, so it follows the config and the target without a restart
 * and the client's tool list never changes.
 */

import { tool as aiTool, type ToolSet } from 'ai';
import path from 'node:path';
import { z } from 'zod';
import { executorTools, projectToolsFor } from '../agent/default-agent.ts';
import type { StepExecutor, StepExecutorContext, StepVerdict } from '../agent/executor.ts';
import { createGrammarTools } from '../agent/primitives.ts';
import { ScreenPresenter } from '../agent/screen-update.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import { credentials, setCredentialRegistry } from '../credentials.ts';
import type { LocatorExpression, SemanticNode } from '../engine/surface.ts';
import { ConfigurationError, errorMessage } from '../internal/errors.ts';
import { uuidv7 } from '../internal/ids.ts';
import { describeExpression, roleQuery, testIdQuery, textQuery } from '../locator/expression.ts';
import { LocatorEngine } from '../locator/engine.ts';
import { openStandaloneAttempt, type StandaloneAttempt } from '../run/standalone.ts';
import type { AgentParams, Role } from '../types.ts';
import { catalogLine, describeToolDetail, errorResult, invokeTool, textResult, type McpToolCallExtra, type McpToolResult, type McpToolSpec } from './tools.ts';

/** How long one session may live, whatever happens. */
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
/** A session nobody has touched for this long is closed, so no browser is left behind. */
const SESSION_IDLE_MS = 30 * 60 * 1000;
/** Budgets a dev-loop step never reaches; the deadline is the real bound. */
const UNBOUNDED = 1_000_000;
/** How many matching nodes `locate` describes. */
const MAX_LOCATE_NODES = 10;
const SESSION_INSTRUCTION = 'Interactive session: a coding agent drives the app over MCP.';
/** The configured-agent name the session runs under: the project's agents stay untouched beside it. */
const SESSION_AGENT = 'e2e-mcp';
/** The grammar's tool names: a missing one is a verb the target's engine does not declare, not a typo. */
const GRAMMAR_TOOL_NAMES: ReadonlySet<string> = new Set(['tap', 'type', 'type_secret', 'press', 'select', 'scroll', 'navigate']);

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

/**
 * The session's `observe`: the whole screen, every time. Action results
 * report what changed since the screen the agent last received, as they do
 * for the testing agent; a coding agent that asks to look wants everything,
 * and the presenter takes that screen as the new baseline for later changes.
 */
function fullObserveTool(context: StepExecutorContext, screen: ScreenPresenter): ToolSet[string] {
  return {
    description:
      'Look at the whole current screen: every node with its id, role, name, and state. Action results report only what changed since the screen you last received; call this to see everything again or after waiting for something in progress.',
    inputSchema: z.object({}),
    execute: async () => screen.initial(await context.observe()),
  };
}

/**
 * The session's `screenshot`: the masked pixels as an image part, or the
 * reason they are withheld, rendered through `toModelOutput` like the device
 * pack's own screenshot tool so `call` serves both the same way.
 */
function screenshotTool(context: StepExecutorContext): ToolSet[string] {
  return aiTool({
    description:
      'Look at the masked pixels of the current screen. Secure fields are masked; the image is withheld when masking cannot be proven or a secret was filled in this session. Use when the observation tree is sparse or contradicts what you expect.',
    inputSchema: z.object({}),
    execute: async () => context.observe({ pixels: true }),
    toModelOutput: ({ output }) => {
      if (output.pixels === undefined) {
        return {
          type: 'text',
          value: `Screenshot withheld: ${output.pixelsWithheld ?? 'the engine captures no pixels'}. The observation tree is still available through observe.`,
        };
      }
      const { data, mediaType, width, height } = output.pixels;
      return {
        type: 'content',
        value: [
          { type: 'text', text: `Screen ${width}x${height} at revision ${output.revision}${output.path === undefined ? '' : ` (${output.path})`}.` },
          { type: 'file-data', data: Buffer.from(data).toString('base64'), mediaType },
        ],
      };
    },
  });
}

/** The session's `locate`: a semantic locator tried against the live screen, with the verdict a test would get. */
function locateTool(live: Pick<LiveSession, 'locator' | 'attempt'>): ToolSet[string] {
  return {
    description:
      'Try a semantic locator against the live screen before writing it into a test: screen.getByRole(role, { name }), getByText, getByLabel, getByPlaceholder, or getByTestId. Returns how many nodes match and which, plus the test code to use. Exactly one of role, text, label, placeholder, or testId; name narrows a role query. Matching is exact unless exact is false.',
    inputSchema: z.object({
      role: z.string().min(1).optional().describe('ARIA role, e.g. "button", "textbox", "link"'),
      name: z.string().min(1).optional().describe('Accessible name, with role'),
      text: z.string().min(1).optional(),
      label: z.string().min(1).optional(),
      placeholder: z.string().min(1).optional(),
      testId: z.string().min(1).optional(),
      exact: z.boolean().optional().describe('false for substring, case-insensitive matching'),
    }),
    execute: async (args: Record<string, unknown>) => {
      const query = locateQuery(args);
      const refs = await live.locator.resolveAll(query.expression);
      const read: SemanticNode[] = [];
      for (const ref of refs.slice(0, MAX_LOCATE_NODES)) {
        read.push(await live.attempt.session.read(ref, live.locator.operation()));
      }
      return describeLocate(query, refs.length, read);
    },
  };
}

interface LiveSession {
  readonly id: string;
  readonly target: ResolvedTarget;
  readonly configPath: string;
  readonly attempt: StandaloneAttempt;
  readonly executor: QueueExecutor;
  readonly context: StepExecutorContext;
  readonly screen: ScreenPresenter;
  /** The catalog: every tool `call` can run, in the order `tools` lists them. */
  readonly tools: ToolSet;
  /** The catalog tools that change nothing on the app. */
  readonly readOnly: ReadonlySet<string>;
  readonly locator: LocatorEngine;
  /** Settles when the underlying `agent.act()` step ends, for any reason. */
  readonly done: Promise<{ error?: unknown }>;
  readonly abort: AbortController;
  idleTimer: NodeJS.Timeout | undefined;
  actions: number;
}

export interface OpenSessionOptions {
  /** The target to open; otherwise the server's `--target`, else the config's only target. */
  readonly target?: string | undefined;
  /** A config file to load instead of the server's default, relative to the server's directory. */
  readonly config?: string | undefined;
}

export interface SessionHostOptions {
  /** Loads a config fresh for each session, so an edited config applies without a restart; `configPath` overrides the server's default. */
  readonly loadConfig: (configPath: string | undefined) => Promise<ResolvedConfig>;
  readonly env: NodeJS.ProcessEnv;
  readonly headed: boolean;
  /** The target every session opens on, from `--target`; a call may still name one. */
  readonly defaultTarget?: string | undefined;
  readonly log: (level: 'info' | 'warning' | 'error', message: string) => void;
  readonly idleMs?: number | undefined;
  readonly ttlMs?: number | undefined;
}

/** Owns at most one live session and the fixed MCP tools that drive it. */
export class SessionHost {
  private live: LiveSession | undefined;
  private opening: Promise<string> | undefined;
  /** Why the previous session ended, for the error a call on a closed session gets. */
  private lastEnd: string | undefined;

  constructor(private readonly options: SessionHostOptions) {}

  get isOpen(): boolean {
    return this.live !== undefined;
  }

  /** The server's tools: the same four whatever the project, the config, or the target. */
  toolSpecs(): McpToolSpec[] {
    return [this.openSpec(), this.catalogSpec(), this.callSpec(), this.closeSpec()];
  }

  /** Opens a session and returns its opening text: the summary, the catalog, and the first screen. */
  open(options: OpenSessionOptions): Promise<string> {
    if (this.live !== undefined) {
      return Promise.reject(
        new ConfigurationError(
          'SESSION_OPEN',
          `session ${this.live.id} is already open on target "${this.live.target.name}"; use it, or close_session first`,
        ),
      );
    }
    this.opening ??= this.openSession(options).finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  /** Closes the live session, if any, and returns what happened. */
  async close(reason: string, session?: string): Promise<string> {
    const live = this.live;
    if (live === undefined) return 'No session is open.';
    if (session !== undefined && session !== live.id) throw this.wrongSession(live, session);
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

  /** The session's catalog, or one tool's full contract. */
  catalog(session: string | undefined, tool: string | undefined): string {
    const live = this.requireLive(session);
    if (tool === undefined) {
      return [`Session ${live.id} on target "${live.target.name}": ${Object.keys(live.tools).length} tools. Run one with call {tool, args}; tools {tool} shows a tool's arguments.`, ...this.catalogLines(live)].join('\n');
    }
    const found = live.tools[tool];
    if (found === undefined) throw this.unknownTool(live, tool);
    return describeToolDetail(tool, found, live.readOnly.has(tool));
  }

  /** Runs one catalog tool inside the live session's step. */
  async call(session: string | undefined, name: string, args: Record<string, unknown>, extra: McpToolCallExtra): Promise<McpToolResult> {
    try {
      const live = this.requireLive(session);
      const tool = live.tools[name];
      if (tool === undefined) throw this.unknownTool(live, name);
      return await this.run(live, () => invokeTool(name, tool, args, extra));
    } catch (cause) {
      return errorResult(cause);
    }
  }

  private async openSession(options: OpenSessionOptions): Promise<string> {
    const base = await this.options.loadConfig(options.config);
    const target = this.resolveTarget(base, options.target);
    const executor = new QueueExecutor();
    // The session never calls a model: the coding agent is the brain, so the
    // configured model (and its credential preflight) stays out of the way.
    // The session's agent is the project's default agent with the queue as
    // its executor, registered under its own name; the attempt runs as it.
    const agent = { ...base.agent, executor, model: undefined, visionModel: undefined, maxSteps: UNBOUNDED, maxModelCalls: UNBOUNDED };
    const config: ResolvedConfig = { ...base, agents: new Map([...base.agents, [SESSION_AGENT, agent]]) };
    const ttlMs = this.options.ttlMs ?? SESSION_TTL_MS;
    const abort = new AbortController();
    const id = uuidv7();
    // The credential registry is process-wide; the session holds it while open.
    setCredentialRegistry(config.credentials);
    let attempt: StandaloneAttempt | undefined;
    try {
      attempt = await openStandaloneAttempt({
        config,
        target,
        headed: this.options.headed,
        env: this.options.env,
        signal: abort.signal,
        timeoutMs: ttlMs + 60_000,
        artifactsRoot: path.join(config.projectRoot, '.e2e', 'artifacts'),
        agent: SESSION_AGENT,
        notice: (scope, message) => this.options.log('info', `${scope}: ${message}`),
      });
      const params = this.secretParams(config);
      const done: Promise<{ error?: unknown }> = attempt.fixtures.agent
        .act(SESSION_INSTRUCTION, { ...(params === undefined ? {} : { params }), timeout: ttlMs })
        .then((): { error?: unknown } => ({}), (error: unknown): { error?: unknown } => ({ error }));
      const context = await Promise.race([
        executor.context,
        done.then((outcome) => {
          throw outcome.error ?? new Error('the session step ended before it started');
        }),
      ]);
      const screen = new ScreenPresenter();
      const locator = new LocatorEngine({
        session: attempt.session,
        budget: attempt.budget,
        runId: attempt.runId,
        attemptId: attempt.attemptId,
        actionTimeout: config.actionTimeout,
        assertionTimeout: config.assertionTimeout,
      });
      const { tools, readOnly } = this.buildCatalog(context, screen, { locator, attempt }, base);
      const live: LiveSession = {
        id,
        target,
        configPath: config.configPath ?? options.config ?? 'e2e.config.ts',
        attempt,
        executor,
        context,
        screen,
        tools,
        readOnly,
        locator,
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
      return this.openingText(live, config, await this.firstScreen(live));
    } catch (cause) {
      // Whatever failed after the attempt opened, the attempt is torn down:
      // an engine or app process left behind would block the next session.
      this.live = undefined;
      executor.finish({ status: 'failed', summary: 'opening the session failed' });
      await attempt?.close().catch(() => undefined);
      abort.abort();
      setCredentialRegistry(undefined);
      throw cause;
    }
  }

  /**
   * The session's catalog: `observe`, the grammar the target honors, `locate`
   * and `screenshot`, then the project's tools for this platform. Built-in
   * names win: a project tool named like one (the device pack's `screenshot`,
   * say) is neither listed nor reachable, the precedence the testing agent's
   * toolset applies, and the collision is logged.
   */
  private buildCatalog(
    context: StepExecutorContext,
    screen: ScreenPresenter,
    live: Pick<LiveSession, 'locator' | 'attempt'>,
    config: ResolvedConfig,
  ): { tools: ToolSet; readOnly: ReadonlySet<string> } {
    // The grammar's own observe reports a diff for the model loop; the
    // session's shows the whole screen, so it replaces the grammar's.
    const { observe: _diffObserve, ...verbs } = createGrammarTools(context, { screen });
    const builtIn: ToolSet = {
      observe: fullObserveTool(context, screen),
      ...verbs,
      locate: locateTool(live),
      screenshot: screenshotTool(context),
    };
    const defined = executorTools(config.agent.executor);
    const project: ToolSet = {};
    for (const [name, tool] of Object.entries(projectToolsFor(context, defined))) {
      if (name in builtIn) {
        this.options.log('warning', `project tool "${name}" is not served over MCP: the name belongs to a built-in session tool`);
        continue;
      }
      project[name] = tool;
    }
    const readOnly = new Set(['observe', 'locate', 'screenshot']);
    for (const name of Object.keys(project)) if (defined[name]?.annotations.mutates === false) readOnly.add(name);
    return { tools: { ...builtIn, ...project }, readOnly };
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
    return live.screen.initial(observation);
  }

  private openingText(live: LiveSession, config: ResolvedConfig, screen: string): string {
    const engine = live.target.engine;
    const lines = [
      `Session ${live.id} open on target "${live.target.name}" (platform ${live.target.platform}, engine ${engine === undefined ? 'none' : `${engine.name} ${engine.version}`}), ${this.options.headed ? 'headed' : 'headless'}; config ${live.configPath}.`,
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
    lines.push(`Tools (run one with call {tool, args}; tools {tool} shows a tool's arguments):`, ...this.catalogLines(live));
    lines.push(
      'Node ids ("n42") are valid only for the newest observation; every action reports what changed on screen, and observe shows the whole screen. Call close_session when you are done.',
    );
    return `${lines.join('\n')}\n\n${screen}`;
  }

  private catalogLines(live: LiveSession): string[] {
    return Object.entries(live.tools).map(([name, tool]) => catalogLine(name, tool, live.readOnly.has(name)));
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

  private requireLive(session: string | undefined): LiveSession {
    if (this.live === undefined) {
      const previous = this.lastEnd === undefined ? '' : ` (the previous session ended: ${this.lastEnd})`;
      throw new ConfigurationError('NO_SESSION', `no session is open; call open_session first${previous}`);
    }
    if (session !== undefined && session !== this.live.id) throw this.wrongSession(this.live, session);
    return this.live;
  }

  private wrongSession(live: LiveSession, session: string): ConfigurationError {
    return new ConfigurationError('NO_SESSION', `session "${session}" is not open; the open session is ${live.id}`);
  }

  private unknownTool(live: LiveSession, name: string): ConfigurationError {
    if (GRAMMAR_TOOL_NAMES.has(name)) {
      return new ConfigurationError(
        'UNSUPPORTED_CAPABILITY',
        `tool "${name}" is not available in this session: the engine of target "${live.target.name}" declares no such action; tools lists what it can do`,
      );
    }
    return new ConfigurationError('UNKNOWN_TOOL', `tool "${name}" is not available in this session; tools: ${Object.keys(live.tools).join(', ')}`);
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
  private run<T>(live: LiveSession, body: () => Promise<T>): Promise<T> {
    this.touch(live);
    live.actions += 1;
    return live.executor.submit(body);
  }

  // --- the fixed tools ---

  private openSpec(): McpToolSpec {
    return {
      name: 'open_session',
      description:
        'Open a live session on one target of an e2e project: loads the config, starts the app command the engine declares (if any), boots the engine (a browser, a simulator), opens the app URL, and returns the session id, the catalog of tools it can run, and the first observation. One session at a time. Then act with call and look with call {tool: "observe"}.',
      inputSchema: z.object({
        target: z.string().min(1).optional().describe('Target name from the config; required when the config declares several'),
        config: z.string().min(1).optional().describe('Path to an e2e config file, relative to the server\'s directory; default: the nearest e2e.config.ts'),
      }),
      readOnly: false,
      call: async (args) => {
        try {
          return textResult(
            await this.open({
              target: typeof args['target'] === 'string' ? args['target'] : undefined,
              config: typeof args['config'] === 'string' ? args['config'] : undefined,
            }),
          );
        } catch (cause) {
          return errorResult(cause);
        }
      },
    };
  }

  private catalogSpec(): McpToolSpec {
    return {
      name: 'tools',
      description:
        'List the tools the open session can run through call: observe, the grammar its engine honors (tap, type, press, select, scroll, navigate, type_secret), locate, screenshot, and the project\'s own tools. With tool, shows that tool\'s full description and the JSON Schema of its arguments.',
      inputSchema: z.object({
        tool: z.string().min(1).optional().describe('A catalog tool name, for its full contract'),
        session: z.string().min(1).optional().describe('Session id; defaults to the open session'),
      }),
      readOnly: true,
      call: async (args) => {
        try {
          return textResult(
            this.catalog(typeof args['session'] === 'string' ? args['session'] : undefined, typeof args['tool'] === 'string' ? args['tool'] : undefined),
          );
        } catch (cause) {
          return errorResult(cause);
        }
      },
    };
  }

  private callSpec(): McpToolSpec {
    return {
      name: 'call',
      description:
        'Run one tool of the open session by name, with its arguments as an object: call {tool: "tap", args: {target: "n42"}}. The session\'s catalog (from open_session or tools) names the tools and their arguments. Actions report what changed on screen; node ids are valid only for the newest observation.',
      inputSchema: z.object({
        tool: z.string().min(1).describe('A catalog tool name, e.g. "observe", "tap", "locate", "screenshot"'),
        args: z.record(z.string(), z.unknown()).optional().describe('The tool\'s arguments; omit for a tool without any'),
        session: z.string().min(1).optional().describe('Session id; defaults to the open session'),
      }),
      readOnly: false,
      call: (args, extra) =>
        this.call(
          typeof args['session'] === 'string' ? args['session'] : undefined,
          String(args['tool']),
          typeof args['args'] === 'object' && args['args'] !== null ? (args['args'] as Record<string, unknown>) : {},
          extra,
        ),
    };
  }

  private closeSpec(): McpToolSpec {
    return {
      name: 'close_session',
      description: 'Close the live session: end the attempt, dispose the engine, and stop the app processes the session started.',
      inputSchema: z.object({
        session: z.string().min(1).optional().describe('Session id; defaults to the open session'),
      }),
      readOnly: false,
      call: async (args) => {
        try {
          return textResult(await this.close('closed by the agent', typeof args['session'] === 'string' ? args['session'] : undefined));
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
