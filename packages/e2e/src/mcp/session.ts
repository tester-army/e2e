/**
 * The live sessions behind `e2e mcp`: each one standalone attempt on one
 * target with one interactive agent step open on it, driven by a coding agent
 * through a fixed, four-tool surface. `open_session` loads the project's
 * config and opens the attempt and the step; `tools` renders the session's
 * catalog; `call` runs one catalog tool by name inside the step;
 * `close_session` ends the step, saves a recording still running, and tears
 * the attempt down. Several sessions may be open at once, up to the server's
 * limit, so parallel agents each drive their own browser; a call names its
 * session by id, and may leave it out only while one is open. The catalog is
 * data, not registrations, so it follows the config and the target without a
 * restart and the client's tool list never changes.
 */

import { z } from 'zod';
import { loadAiSdk } from '../agent/ai-sdk.ts';
import { openInteractiveStep, type InteractiveStep } from '../agent/interactive-step.ts';
import { ScreenPresenter } from '../agent/screen-update.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import { secretHandle } from '../secrets.ts';
import { ConfigurationError, errorMessage, InfrastructureError, type SerializedError } from '../internal/errors.ts';
import { LocatorEngine } from '../locator/engine.ts';
import { allocateAppPorts } from '../run/app-ports.ts';
import { SharedAppProcesses } from '../run/process-pool.ts';
import { outputLayout } from '../run/output.ts';
import { sessionSecrecy } from '../run/secrecy.ts';
import { openStandaloneAttempt, type StandaloneAttempt } from '../run/standalone.ts';
import type { AgentParams } from '../types.ts';
import { createSessionCatalog, isGrammarVerb, type SessionCatalog } from './catalog.ts';
import type { LoadedConfig } from './config.ts';
import { describeRecording, SessionRecorder } from './recording.ts';
import { SessionRegistry } from './sessions.ts';
import { actionResult, catalogLine, defineMcpTool, describeToolDetail, errorResult, invokeTool, redactResult, textResult, type McpToolCallExtra, type McpToolResult, type McpToolSpec } from './tools.ts';

/** How long one session may live, whatever happens. */
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
/** A session nobody has touched for this long is closed, so no browser is left behind. */
const SESSION_IDLE_MS = 30 * 60 * 1000;
/** How long the attempt outlives its step, so a step that hit the TTL is still closed in order. */
const CLOSE_GRACE_MS = 60 * 1000;
/** How many sessions `e2e mcp --max-sessions` allows at once, each a browser or a device. */
export const SESSION_BOUNDS = { min: 1, max: 16, default: 4 } as const;
const SESSION_INSTRUCTION = 'Interactive session: a coding agent drives the app over MCP.';

interface LiveSession {
  readonly id: string;
  readonly target: ResolvedTarget;
  readonly configPath: string;
  readonly attempt: StandaloneAttempt;
  readonly step: InteractiveStep;
  readonly screen: ScreenPresenter;
  readonly catalog: SessionCatalog;
  /** The session's recordings, when the engine records video. */
  readonly recorder: SessionRecorder | undefined;
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
  /** The absolute path of the config a session loads, without evaluating it; `configPath` overrides the server's default. */
  readonly locateConfig: (configPath: string | undefined) => string;
  /** Loads the config at an absolute path fresh for each session, so an edited config applies without a restart. */
  readonly loadConfig: (configPath: string) => Promise<LoadedConfig>;
  readonly env: NodeJS.ProcessEnv;
  readonly headed: boolean;
  /** The target every session opens on, from `--target`; a call may still name one. */
  readonly defaultTarget?: string | undefined;
  readonly log: (level: 'info' | 'warning' | 'error', message: string) => void;
  readonly idleMs?: number | undefined;
  readonly ttlMs?: number | undefined;
  /** How many sessions may be open at once, from `--max-sessions`; default `SESSION_BOUNDS.default`. */
  readonly maxSessions?: number | undefined;
}

/** Owns the live sessions, up to the server's limit, and the fixed MCP tools that drive them. */
export class SessionHost {
  private readonly sessions: SessionRegistry<LiveSession>;
  /** Sessions on one app command share its process: the last one to close stops it. */
  private readonly apps = new SharedAppProcesses();
  /** Aborts every open still running once the server shuts down, so none leaves a process behind. */
  private readonly shutdown = new AbortController();

  constructor(private readonly options: SessionHostOptions) {
    this.sessions = new SessionRegistry(this.maxSessions);
  }

  get isOpen(): boolean {
    return this.sessions.hasLive;
  }

  private get maxSessions(): number {
    return this.options.maxSessions ?? SESSION_BOUNDS.default;
  }

  /** The server's tools: the same four whatever the project, the config, or the target. */
  toolSpecs(): readonly McpToolSpec[] {
    return [this.openSpec(), this.catalogSpec(), this.callSpec(), this.closeSpec()];
  }

  /**
   * Opens a session and returns its opening text: the summary, the catalog,
   * and the first screen. `signal` is the request's: a client that cancels
   * it, or disconnects, aborts the open and what it started.
   */
  open(options: OpenSessionOptions, signal?: AbortSignal): Promise<string> {
    return this.sessions.admit((id) => this.openSession(id, options, signal));
  }

  /** Closes one session, the only one when `session` is omitted, and returns what happened; a session already closing returns that close. */
  async close(reason: string, session?: string): Promise<string> {
    if (session === undefined && !this.sessions.hasLive) return 'No session is open.';
    return this.sessions.close(session, reason, (live) => this.teardown(live, reason));
  }

  /** Closes every session, for a server that is shutting down; undefined when none was open. */
  async closeAll(reason: string): Promise<string | undefined> {
    this.shutdown.abort();
    const summaries = await this.sessions.closeAll(reason, (live) => this.teardown(live, reason));
    return summaries.length === 0 ? undefined : summaries.join('\n');
  }

  private async teardown(live: LiveSession, reason: string): Promise<string> {
    if (live.idleTimer !== undefined) clearTimeout(live.idleTimer);
    const { value, cleanupErrors } = await this.closeAttempt(live.attempt, live.abort, async () => {
      await live.step.end({ status: 'passed', summary: `session closed: ${reason}` });
      const outcome = await live.step.done;
      // The recorder runs this after a start or stop still in flight, even one the step's deadline abandoned.
      return { outcome, saved: await this.saveRecording(live) };
    });
    const lines = [`Session ${live.id} closed (${reason}); ${live.actions} tool calls ran.`];
    if (value.saved !== undefined) lines.push(value.saved);
    if (value.outcome.error !== undefined) lines.push(`The session step ended with: ${errorMessage(value.outcome.error)}`);
    for (const error of cleanupErrors) lines.push(`Cleanup: ${error.code}: ${error.message}`);
    return lines.join('\n');
  }

  /**
   * Runs `settle` (ending the step, saving a recording), then closes the
   * attempt and cancels whatever still runs in it, whether or not `settle`
   * failed: an engine or app process left behind would block the next session.
   */
  private async closeAttempt<T>(
    attempt: StandaloneAttempt | undefined,
    abort: AbortController,
    settle: () => Promise<T>,
  ): Promise<{ readonly value: T; readonly cleanupErrors: readonly SerializedError[] }> {
    const settled = await settle().then(
      (value) => ({ value }),
      (cause: unknown) => ({ cause }),
    );
    const cleanupErrors = attempt === undefined ? [] : await attempt.close();
    abort.abort();
    if ('cause' in settled) throw settled.cause;
    return { value: settled.value, cleanupErrors };
  }

  /** The session's catalog, or one tool's full contract. */
  catalog(session: string | undefined, tool: string | undefined): string {
    const live = this.sessions.resolve(session);
    if (tool === undefined) {
      return [`Session ${live.id} on target "${live.target.name}": ${Object.keys(live.catalog.tools).length} tools. Run one with call {tool, args}; tools {tool} shows a tool's arguments.`, ...this.catalogLines(live)].join('\n');
    }
    const found = live.catalog.tools[tool];
    if (found === undefined) throw this.unknownTool(live, tool);
    return describeToolDetail(tool, found, live.catalog.readOnly.has(tool));
  }

  /** Runs one catalog tool inside the live session's step; what comes back, a result or a failure, passes the attempt's secret ledger. */
  call(session: string | undefined, name: string, args: Record<string, unknown>, extra: McpToolCallExtra): Promise<McpToolResult> {
    const live = this.sessions.resolve(session);
    const tool = live.catalog.tools[name];
    if (tool === undefined) throw this.unknownTool(live, name);
    const redact = live.attempt.agentRuntime.redact;
    return this.run(live, () => invokeTool(name, tool, args, extra)).then(
      (result) => redactResult(isGrammarVerb(name) ? actionResult(name, result) : result, redact),
      (cause: unknown) => redactResult(errorResult(cause), redact),
    );
  }

  private async openSession(id: string, options: OpenSessionOptions, request: AbortSignal | undefined): Promise<string> {
    // The catalog reads the tools' schemas through the AI SDK, synchronously
    // and on every render, so the optional SDK is loaded once here: a project
    // without it learns so before an attempt opens a browser.
    await loadAiSdk();
    // The config is claimed before it evaluates: its top-level code resolves
    // secrets against the registry an open session installed, which only
    // knows that session's config.
    const configPath = this.options.locateConfig(options.config);
    this.sessions.claimConfig(id, configPath);
    const loaded = await this.options.loadConfig(configPath);
    // A session is its own run: a URL declared with port 0 gets a port here.
    const config = await allocateAppPorts(loaded);
    const target = this.resolveTarget(config, options.target);
    this.sessions.claimEngine(id, target.name, target.engine);
    const ttlMs = this.options.ttlMs ?? SESSION_TTL_MS;
    const abort = new AbortController();
    // Until the session is live, the request and the server's shutdown can abort the open.
    const opening = AbortSignal.any([this.shutdown.signal, ...(request === undefined ? [] : [request])]);
    const cancel = (): void => abort.abort();
    if (opening.aborted) cancel();
    else opening.addEventListener('abort', cancel, { once: true });
    let attempt: StandaloneAttempt | undefined;
    let step: InteractiveStep | undefined;
    try {
      attempt = await openStandaloneAttempt({
        // A session records video only between start_recording and
        // stop_recording: the configured video mode is for runs, and would
        // record everything. The trace keeps the target's mode: a session is
        // one attempt that closes as passed, so it traces under `on` only.
        config,
        target: { ...target, video: { mode: 'off', source: 'default' } },
        headed: this.options.headed,
        env: this.options.env,
        signal: abort.signal,
        timeoutMs: ttlMs + CLOSE_GRACE_MS,
        processes: this.apps,
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
      const { context } = step;
      const screen = new ScreenPresenter({ pixelsUnavailable: () => context.pixelsTainted });
      const recorder = this.recorder(id, config, attempt);
      const catalog = createSessionCatalog({
        context: step.context,
        screen,
        session: attempt.session,
        tools: config.agent.tools,
        redact: attempt.agentRuntime.redact,
        recorder,
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
        configPath: loaded.configPath,
        attempt,
        step,
        screen,
        catalog,
        recorder,
        abort,
        idleTimer: undefined,
        actions: 0,
      };
      const text = this.openingText(live, config, await this.firstScreen(live));
      // A first screen that came back despite the cancel must not become a live session nobody asked for.
      if (abort.signal.aborted) throw new InfrastructureError('CANCELLED', `opening session ${id} was cancelled`);
      opening.removeEventListener('abort', cancel);
      this.sessions.activate(live);
      // A step that ends on its own (the TTL, a hard stop) ends the session.
      void step.done.then((outcome) => this.endOnItsOwn(live, outcome.error === undefined ? 'the session step concluded' : errorMessage(outcome.error)));
      this.touch(live);
      return text;
    } catch (cause) {
      opening.removeEventListener('abort', cancel);
      await this.closeAttempt(attempt, abort, async () => {
        await step?.end({ status: 'failed', summary: 'opening the session failed' });
      }).catch(() => undefined);
      throw cause;
    }
  }

  /** Closes a live session that ended without a close_session: its step concluded, or it sat idle. */
  private endOnItsOwn(live: LiveSession, why: string): void {
    if (!this.sessions.isLive(live.id)) return;
    this.options.log('warning', `session ${live.id} ended: ${why}`);
    this.close(why, live.id).catch((cause: unknown) => this.options.log('error', `closing session ${live.id} failed: ${errorMessage(cause)}`));
  }

  /** A recorder writing to `<output>/videos/<session>/`, when the engine records video. */
  private recorder(id: string, config: ResolvedConfig, attempt: StandaloneAttempt): SessionRecorder | undefined {
    const { startVideo, stopVideo } = attempt.session.artifacts;
    if (startVideo === undefined || stopVideo === undefined) return undefined;
    return new SessionRecorder({
      startVideo,
      stopVideo,
      attemptDir: attempt.artifactsDir,
      outDir: outputLayout(config.output).videos(id),
      // Not the attempt's signal: a session that hit its TTL still saves the recording on the way out.
      operation: (timeoutMs) => ({
        signal: AbortSignal.timeout(timeoutMs),
        timeoutMs,
        runId: attempt.runId,
        attemptId: attempt.attemptId,
        origin: 'test',
      }),
      timeoutMs: config.cleanupTimeout,
      tainted: () => sessionSecrecy(attempt.session, config.allSecrets).exposure.withholdsPixels,
    });
  }

  /**
   * Stops a recording still running when the session closes, and says where
   * it went or why it was lost. Always queued, never checked first: a start
   * still in flight is not running yet, and would record past the close.
   */
  private async saveRecording(live: LiveSession): Promise<string | undefined> {
    if (live.recorder === undefined) return undefined;
    try {
      const recording = await live.recorder.stop();
      return recording === undefined ? undefined : describeRecording(recording);
    } catch (cause) {
      return `The running recording could not be saved: ${errorMessage(cause)}`;
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
        (credential) => `"${credential.name}" (username ${JSON.stringify(credential.username)}, password secret "${credential.password.name}")`,
      );
      lines.push(`Credentials: ${described.join(', ')}. Type the username with type; fill the password with type_secret and its password secret's name.`);
    }
    if (config.secrets.size > 0) {
      lines.push(`Secrets: ${[...config.secrets.keys()].map((name) => `"${name}"`).join(', ')}. Fill one into any input with type_secret and its name; you never see the value.`);
    }
    lines.push(
      `Pass session "${live.id}" to every tools, call, and close_session; with several sessions open, a call without it fails.`,
    );
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
    if (config.allSecrets.size === 0) return undefined;
    return Object.fromEntries([...config.allSecrets.values()].map((secret) => [secret.name, secretHandle(secret)]));
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
    live.idleTimer = setTimeout(() => this.endOnItsOwn(live, `idle for ${Math.round(idleMs / 60_000)} minutes`), idleMs);
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
        'Open a live session on one target of an e2e project: loads the config, starts the app command the target declares (if any), boots the engine (a browser, a simulator), opens the app URL, and returns the session id, the catalog of tools it can run, and the first observation. Several sessions can be open at once, one per agent, each with its own engine: pass the returned session id to every later call. Then act with call and look with call {tool: "observe"}.',
      inputSchema: z.object({
        target: z.string().min(1).optional().describe('Target name from the config; required when the config declares several'),
        config: z.string().min(1).optional().describe("Path to an e2e config file, relative to the server's directory; default: the nearest e2e.config.ts"),
      }).strict(),
      readOnly: false,
      call: async (args, extra) => textResult(await this.open(args, extra.signal)),
    });
  }

  private catalogSpec(): McpToolSpec {
    return defineMcpTool({
      name: 'tools',
      description:
        "List the tools a session can run through call: observe, the grammar its engine honors (one tool per action the engine declares, type_secret when a secret is configured, and screenshot and the point tools, which answer PIXEL_TAINTED once a secret has been filled), locate, start_recording and stop_recording when the engine records video, and the project's own tools. With tool, shows that tool's full description and the JSON Schema of its arguments.",
      inputSchema: z.object({
        tool: z.string().min(1).optional().describe('A catalog tool name, for its full contract'),
        session: z.string().min(1).optional().describe('Session id from open_session; may be omitted only while one session is open'),
      }).strict(),
      readOnly: true,
      call: async (args) => textResult(this.catalog(args.session, args.tool)),
    });
  }

  private callSpec(): McpToolSpec {
    return defineMcpTool({
      name: 'call',
      description:
        "Run one tool of a session by name, with its arguments as an object: call {tool: \"tap\", args: {target: \"n42\"}, session: \"<id>\"}. The session's catalog (from open_session or tools) names the tools and their arguments. Actions report what changed on screen; node ids are valid only for the newest observation.",
      inputSchema: z.object({
        tool: z.string().min(1).describe('A catalog tool name, e.g. "observe", "tap", "locate", "screenshot"'),
        args: z.record(z.string(), z.unknown()).optional().describe("The tool's arguments; omit for a tool without any"),
        session: z.string().min(1).optional().describe('Session id from open_session; may be omitted only while one session is open'),
      }).strict(),
      readOnly: false,
      call: (args, extra) => this.call(args.session, args.tool, args.args ?? {}, extra),
    });
  }

  private closeSpec(): McpToolSpec {
    return defineMcpTool({
      name: 'close_session',
      description: 'Close a live session: save a recording still running, end the attempt, dispose the engine, and stop the app processes the session started.',
      inputSchema: z.object({
        session: z.string().min(1).optional().describe('Session id from open_session; may be omitted only while one session is open'),
      }).strict(),
      readOnly: false,
      call: async (args) => textResult(await this.close('closed by the agent', args.session)),
    });
  }
}
