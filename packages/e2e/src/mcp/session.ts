/**
 * The live session behind `e2e mcp`: one standalone attempt on one target
 * with one interactive agent step open on it, driven by a coding agent
 * through a fixed, four-tool surface. `open_session` loads the project's
 * config and opens the attempt and the step; `tools` renders the session's
 * catalog; `call` runs one catalog tool by name inside the step;
 * `close_session` ends the step and tears the attempt down. The catalog is
 * data, not registrations, so it follows the config and the target without a
 * restart and the client's tool list never changes.
 */

import path from 'node:path';
import { z } from 'zod';
import { loadAiSdk } from '../agent/ai-sdk.ts';
import { openInteractiveStep, type InteractiveStep } from '../agent/interactive-step.ts';
import { ScreenPresenter } from '../agent/screen-update.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import { secrets } from '../secrets.ts';
import { ConfigurationError, errorMessage } from '../internal/errors.ts';
import { uuidv7 } from '../internal/ids.ts';
import { LocatorEngine } from '../locator/engine.ts';
import { allocateAppPorts } from '../run/app-ports.ts';
import { openStandaloneAttempt, type StandaloneAttempt } from '../run/standalone.ts';
import type { AgentParams } from '../types.ts';
import { createSessionCatalog, isGrammarVerb, type SessionCatalog } from './catalog.ts';
import { catalogLine, defineMcpTool, describeToolDetail, errorResult, invokeTool, redactResult, textResult, type McpToolCallExtra, type McpToolResult, type McpToolSpec } from './tools.ts';

/** How long one session may live, whatever happens. */
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
/** A session nobody has touched for this long is closed, so no browser is left behind. */
const SESSION_IDLE_MS = 30 * 60 * 1000;
/** How long the attempt outlives its step, so a step that hit the TTL is still closed in order. */
const CLOSE_GRACE_MS = 60 * 1000;
const SESSION_INSTRUCTION = 'Interactive session: a coding agent drives the app over MCP.';

interface LiveSession {
  readonly id: string;
  readonly target: ResolvedTarget;
  readonly configPath: string;
  readonly attempt: StandaloneAttempt;
  readonly step: InteractiveStep;
  readonly screen: ScreenPresenter;
  readonly catalog: SessionCatalog;
  /** Cancels the attempt wherever it is. */
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
  toolSpecs(): readonly McpToolSpec[] {
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
    await live.step.end({ status: 'passed', summary: `session closed: ${reason}` });
    const outcome = await live.step.done;
    const cleanupErrors = await live.attempt.close();
    live.abort.abort();
    const lines = [`Session ${live.id} closed (${reason}); ${live.actions} tool calls ran.`];
    if (outcome.error !== undefined) lines.push(`The session step ended with: ${errorMessage(outcome.error)}`);
    for (const error of cleanupErrors) lines.push(`Cleanup: ${error.code}: ${error.message}`);
    return lines.join('\n');
  }

  /** The session's catalog, or one tool's full contract. */
  catalog(session: string | undefined, tool: string | undefined): string {
    const live = this.requireLive(session);
    if (tool === undefined) {
      return [`Session ${live.id} on target "${live.target.name}": ${Object.keys(live.catalog.tools).length} tools. Run one with call {tool, args}; tools {tool} shows a tool's arguments.`, ...this.catalogLines(live)].join('\n');
    }
    const found = live.catalog.tools[tool];
    if (found === undefined) throw this.unknownTool(live, tool);
    return describeToolDetail(tool, found, live.catalog.readOnly.has(tool));
  }

  /** Runs one catalog tool inside the live session's step; what comes back, a result or a failure, passes the attempt's secret ledger. */
  call(session: string | undefined, name: string, args: Record<string, unknown>, extra: McpToolCallExtra): Promise<McpToolResult> {
    const live = this.requireLive(session);
    const tool = live.catalog.tools[name];
    if (tool === undefined) throw this.unknownTool(live, name);
    const redact = live.attempt.agentRuntime.redact;
    return this.run(live, () => invokeTool(name, tool, args, extra)).then(
      (result) => redactResult(result, redact),
      (cause: unknown) => redactResult(errorResult(cause), redact),
    );
  }

  private async openSession(options: OpenSessionOptions): Promise<string> {
    // The catalog reads the tools' schemas through the AI SDK, synchronously
    // and on every render, so the optional SDK is loaded once here: a project
    // without it learns so before an attempt opens a browser.
    await loadAiSdk();
    // A session is its own run: a URL declared with port 0 gets a port here.
    const config = await allocateAppPorts(await this.options.loadConfig(options.config));
    const target = this.resolveTarget(config, options.target);
    const ttlMs = this.options.ttlMs ?? SESSION_TTL_MS;
    const abort = new AbortController();
    const id = uuidv7();
    let attempt: StandaloneAttempt | undefined;
    let step: InteractiveStep | undefined;
    try {
      attempt = await openStandaloneAttempt({
        config,
        target,
        headed: this.options.headed,
        env: this.options.env,
        signal: abort.signal,
        timeoutMs: ttlMs + CLOSE_GRACE_MS,
        artifactsRoot: path.join(config.projectRoot, '.e2e', 'artifacts'),
        notice: (scope, message) => this.options.log('info', `${scope}: ${message}`),
      });
      // The coding agent is the brain: the step is driven from here, and the
      // configured model stays out of the way.
      const params = this.secretParams(config);
      step = await openInteractiveStep(attempt.agentRuntime, {
        instruction: SESSION_INSTRUCTION,
        ...(params === undefined ? {} : { params }),
        timeout: ttlMs,
      });
      const screen = new ScreenPresenter();
      const catalog = createSessionCatalog({
        context: step.context,
        screen,
        session: attempt.session,
        executor: config.agent.executor,
        redact: attempt.agentRuntime.redact,
        locator: new LocatorEngine({
          session: attempt.session,
          budget: attempt.budget,
          runId: attempt.runId,
          attemptId: attempt.attemptId,
          actionTimeout: config.actionTimeout,
          assertionTimeout: config.assertionTimeout,
        }),
        warn: (message) => this.options.log('warning', message),
      });
      const live: LiveSession = {
        id,
        target,
        configPath: config.configPath ?? options.config ?? 'e2e.config.ts',
        attempt,
        step,
        screen,
        catalog,
        abort,
        idleTimer: undefined,
        actions: 0,
      };
      this.live = live;
      this.lastEnd = undefined;
      // A step that ends on its own (the TTL, a hard stop) ends the session.
      void step.done.then(async (outcome) => {
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
      await step?.end({ status: 'failed', summary: 'opening the session failed' }).catch(() => undefined);
      await attempt?.close().catch(() => undefined);
      abort.abort();
      throw cause;
    }
  }

  /** Opens the app when the engine can navigate, then observes. */
  private async firstScreen(live: LiveSession): Promise<string> {
    const base = live.target.app.base?.href;
    if (base !== undefined && live.step.context.target.verbs.has('navigate')) {
      try {
        await live.step.run((context) => context.actions.navigate(base));
      } catch (cause) {
        return `Opening ${base} failed: ${errorMessage(cause)}\nUse navigate once the app is reachable.`;
      }
    }
    const observation = await live.step.run((context) => context.observe());
    return live.screen.initial(observation);
  }

  private openingText(live: LiveSession, config: ResolvedConfig, screen: string): string {
    const engine = live.target.engine;
    const lines = [
      `Session ${live.id} open on target "${live.target.name}" (platform ${live.target.platform}, engine ${engine === undefined ? 'none' : `${engine.name} ${engine.version}`}), ${this.options.headed ? 'headed' : 'headless'}; config ${live.configPath}.`,
    ];
    if (live.target.app.base !== undefined) {
      lines.push(`App: ${live.target.app.base.href}.`);
    }
    if (config.credentials.size > 0) {
      const described = [...config.credentials.values()].map(
        (credential) => `"${credential.name}" (username ${JSON.stringify(credential.username)})`,
      );
      lines.push(`Credentials: ${described.join(', ')}. Type the username with type; fill the password with type_secret and the credential name.`);
    }
    const generic = [...config.secrets.values()].filter((secret) => secret.purpose === 'generic-secret');
    if (generic.length > 0) {
      lines.push(`Secrets: ${generic.map((secret) => `"${secret.name}"`).join(', ')}. Fill one into any input with type_secret and its name; you never see the value.`);
    }
    lines.push(`Tools (run one with call {tool, args}; tools {tool} shows a tool's arguments):`, ...this.catalogLines(live));
    lines.push(
      'Node ids ("n42") are valid only for the newest observation; every action reports what changed on screen, and observe shows the whole screen. Call close_session when you are done.',
    );
    return `${lines.join('\n')}\n\n${screen}`;
  }

  private catalogLines(live: LiveSession): string[] {
    return Object.entries(live.catalog.tools).map(([name, tool]) => catalogLine(name, tool, live.catalog.readOnly.has(name)));
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

  /** Every configured secret, passwords included, as a step secret, so `type_secret` can fill it. */
  private secretParams(config: ResolvedConfig): AgentParams | undefined {
    if (config.secrets.size === 0) return undefined;
    return Object.fromEntries(
      [...config.secrets.keys()].map((name) => [name, secrets.get(name)]),
    );
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
    if (isGrammarVerb(name)) {
      return new ConfigurationError(
        'UNSUPPORTED_CAPABILITY',
        `tool "${name}" is not available in this session: the engine of target "${live.target.name}" declares no such action; tools lists what it can do`,
      );
    }
    return new ConfigurationError('UNKNOWN_TOOL', `tool "${name}" is not available in this session; tools: ${Object.keys(live.catalog.tools).join(', ')}`);
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
    return live.step.run(body);
  }

  // --- the fixed tools ---

  private openSpec(): McpToolSpec {
    return defineMcpTool({
      name: 'open_session',
      description:
        'Open a live session on one target of an e2e project: loads the config, starts the app command the engine declares (if any), boots the engine (a browser, a simulator), opens the app URL, and returns the session id, the catalog of tools it can run, and the first observation. One session at a time. Then act with call and look with call {tool: "observe"}.',
      inputSchema: z.object({
        target: z.string().min(1).optional().describe('Target name from the config; required when the config declares several'),
        config: z.string().min(1).optional().describe("Path to an e2e config file, relative to the server's directory; default: the nearest e2e.config.ts"),
      }),
      readOnly: false,
      call: async (args) => textResult(await this.open(args)),
    });
  }

  private catalogSpec(): McpToolSpec {
    return defineMcpTool({
      name: 'tools',
      description:
        "List the tools the open session can run through call: observe, the grammar its engine honors (tap, type, press, select, scroll, navigate, type_secret, and screenshot and tap_at, which answer PIXEL_TAINTED once a secret has been filled), locate, and the project's own tools. With tool, shows that tool's full description and the JSON Schema of its arguments.",
      inputSchema: z.object({
        tool: z.string().min(1).optional().describe('A catalog tool name, for its full contract'),
        session: z.string().min(1).optional().describe('Session id; defaults to the open session'),
      }),
      readOnly: true,
      call: async (args) => textResult(this.catalog(args.session, args.tool)),
    });
  }

  private callSpec(): McpToolSpec {
    return defineMcpTool({
      name: 'call',
      description:
        "Run one tool of the open session by name, with its arguments as an object: call {tool: \"tap\", args: {target: \"n42\"}}. The session's catalog (from open_session or tools) names the tools and their arguments. Actions report what changed on screen; node ids are valid only for the newest observation.",
      inputSchema: z.object({
        tool: z.string().min(1).describe('A catalog tool name, e.g. "observe", "tap", "locate", "screenshot"'),
        args: z.record(z.string(), z.unknown()).optional().describe("The tool's arguments; omit for a tool without any"),
        session: z.string().min(1).optional().describe('Session id; defaults to the open session'),
      }),
      readOnly: false,
      call: (args, extra) => this.call(args.session, args.tool, args.args ?? {}, extra),
    });
  }

  private closeSpec(): McpToolSpec {
    return defineMcpTool({
      name: 'close_session',
      description: 'Close the live session: end the attempt, dispose the engine, and stop the app processes the session started.',
      inputSchema: z.object({
        session: z.string().min(1).optional().describe('Session id; defaults to the open session'),
      }),
      readOnly: false,
      call: async (args) => textResult(await this.close('closed by the agent', args.session)),
    });
  }
}
