/**
 * One attempt on the BiDi driver: its user context, the tab it drives, the
 * refs it minted, and the network, downloads, dialogs, and video scoped to
 * it, with the primitives every other module drives the page through.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Emulation, Storage } from 'webdriver-bidi-protocol';
import { EngineError, obj, TestError, withTimeout, type AppLogEntry, type EngineSnapshot, type NodeRef, type ViewportPoint, type ViewportSize } from 'e2e/engine';
import { CLOSED_SHADOW_ROOTS_INIT_SCRIPT } from '../closed-shadow.ts';
import { DialogRouter } from '../dialogs.ts';
import type { ConfiguredInitScripts } from '../init-scripts.ts';
import type { WebMedia } from '../media.ts';
import { cancelled, ErrorLatch, invalidState, sanitizeFilename } from '../support.ts';
import type { WebScreencastOptions } from '../options.ts';
import { BidiInput } from './bidi-input.ts';
import { BidiError, type BidiConnection } from './connection.ts';
import type { ContextTree } from './context-tree.ts';
import { AttemptDownloads } from './downloads.ts';
import { releaseQuietly, unlessStale } from './errors.ts';
import { FrameRegistry, type NodeTarget } from './frames.ts';
import type { BidiBrowser, BidiBrowserName } from './launch.ts';
import { AttemptNetwork } from './network.ts';
import { HIT_INTERCEPTOR_INIT_SCRIPT, viewportSize } from './page.ts';
import { BUILTINS_INIT_SCRIPT, readerCall, readerInstallCall, READERS_INIT_SCRIPT, READERS_MISSING, type ReaderArgs, type ReaderName, type ReaderResult } from './readers.ts';
import { callFunction, ScriptError, type CallOptions, type ElementRef, type PageArgument, type PageValue, type TypedPageFunction, type Wire } from './script.ts';
import type { BidiVideo } from './video.ts';
import type { ProviderVideo } from '../provider-video.ts';
import type { LeaseDownloads } from '../provider.ts';

/** How long one step of closing an attempt may take before the next runs. */
const CLOSE_STEP_MS = 10_000;

/**
 * Refuses service worker registration, as Playwright's `serviceWorkers:
 * 'block'` does when headers are configured: a worker's requests bypass
 * request interception, so they would leave without the headers.
 */
const BLOCK_SERVICE_WORKERS = "if (navigator.serviceWorker) navigator.serviceWorker.register = async () => { console.warn('Service Worker registration blocked by e2e'); };";

/** What every attempt of a worker is configured with. */
export interface SessionSettings {
  readonly browser: BidiBrowserName;
  readonly viewport: ViewportSize | null;
  readonly initScripts: ConfiguredInitScripts;
  readonly screencast: WebScreencastOptions;
  readonly userAgent: string | undefined;
  readonly locale: string | undefined;
  readonly timezoneId: string | undefined;
  readonly media: WebMedia;
  readonly testIdAttribute: string;
  readonly site: string | undefined;
  readonly projectRoot: string;
  readonly permissions: readonly string[];
  /** Whether the browser runs on another machine (a provider's lease), whose filesystem local paths do not reach. */
  readonly remoteFiles: boolean;
  /** The user context an attempt runs in (`BrowserSource.userContext`). */
  readonly userContext: UserContextMode;
  /** The run's environment, which names the tools the driver spawns (ffmpeg). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether every request is held for the configured site headers, and service workers blocked. */
  readonly holdRequests: boolean;
  readonly siteHeaders: (url: string) => Readonly<Record<string, string>> | undefined;
}

/** What one attempt starts with. */
export interface AttemptSettings {
  readonly attemptId: string;
  readonly artifactsDir: string;
  readonly appLog: (entry: AppLogEntry) => void;
  /** Tells the trace where the app went on its own. */
  readonly navigation: (line: string) => void;
  /** Hands the trace a screen read after an action; absent when the attempt keeps no trace. */
  readonly screen: ((snapshot: EngineSnapshot) => void) | undefined;
  readonly credentials: { readonly username: string; readonly password: string } | undefined;
  /** The provider that serves downloads off a remote browser's disk; undefined for a local browser. */
  readonly remoteDownloads?: LeaseDownloads | undefined;
}

/**
 * Which user context an attempt runs in: a fresh one it creates and
 * removes, the browser's default one (which a per-attempt lease's `prepare`
 * may have signed in), or the default one on the tab already open there,
 * which the attempt adopts and leaves open (`attachBrowser`).
 */
export type UserContextMode = 'fresh' | 'default' | 'adopt-tab';

/** The browser's own user context, which a lease's `prepare` signed in and which outlives every attempt. */
const DEFAULT_USER_CONTEXT = 'default';

/** A user context the attempt set up, with the preload scripts scoped to it, and the tab it had. */
interface ScopedUserContext {
  readonly userContext: string;
  readonly preloads: readonly string[];
  readonly context: string | undefined;
}

/** The sandbox realm a failed read runs again in, to tell a page that broke the readers from a fault of their own. */
const READER_PROBE_SANDBOX = 'e2e-reader-probe';

/**
 * The ids the driver minted and the element behind each, with the browsing
 * context that holds it. A BiDi shared id holds no handle: it names the
 * element for as long as it lives, so nothing here needs disposing.
 */
class BidiRefs {
  private counter = 0;
  private observation = new Map<string, NodeTarget>();
  private readonly located = new Map<string, NodeTarget>();
  /** The input count when each located id was minted, until an action claims it. */
  private readonly minted = new Map<string, number>();

  /** `dispatches` reads the attempt's input count. */
  constructor(private readonly dispatches: () => number) {}

  /** Reserves ids before a document can stamp them. */
  reserveIds(count: number): number {
    const first = this.counter + 1;
    this.counter += count;
    return first;
  }

  /** Replaces the observation generation. */
  publish(generation: Map<string, NodeTarget>): void {
    this.observation = generation;
  }

  /** Keeps a located element under the id its read gave it, dropping the oldest past 2048. */
  storeLocated(id: string, target: NodeTarget): void {
    this.located.delete(id);
    this.located.set(id, target);
    this.minted.set(id, this.dispatches());
    for (const oldest of this.located.keys()) {
      if (this.located.size <= 2048) break;
      this.located.delete(oldest);
      this.minted.delete(oldest);
    }
  }

  /**
   * Whether `ref` is acted on for the first time with no input, page
   * mutation, or test code since its locate proved it its locator's only
   * match, so that proof still holds; claims it, so a later action checks again.
   */
  claimFresh(ref: NodeRef): boolean {
    const mintedAt = this.minted.get(ref.id);
    this.minted.delete(ref.id);
    return mintedAt !== undefined && mintedAt === this.dispatches();
  }

  /** The element behind `ref`; `NODE_STALE` when no generation holds it. */
  lookup(ref: NodeRef): NodeTarget {
    const target = this.located.get(ref.id) ?? this.observation.get(ref.id);
    if (target === undefined) throw new EngineError('NODE_STALE', `node reference ${ref.id} is stale`, { retryable: true });
    return target;
  }

  /** Forgets everything recorded, for a new user context. */
  clear(): void {
    this.observation = new Map();
    this.located.clear();
    this.minted.clear();
  }
}

/**
 * One attempt on a BiDi browser: its user context and tab, and the refs,
 * frames, network, downloads, dialogs, and video scoped to it.
 */
export class BidiSession {
  userContext = '';
  context: string | undefined;
  /** The tab's keyboard and mouse, the only sender of input. */
  readonly input: BidiInput;
  readonly refs = new BidiRefs(() => this.input.dispatches);
  readonly frames = new FrameRegistry();
  readonly latch = new ErrorLatch();
  readonly dialogs = new DialogRouter(this.latch);
  readonly network: AttemptNetwork;
  readonly downloads: AttemptDownloads;
  /** The media features in effect: the configured ones, updated by `browser.emulateMedia`. */
  media: WebMedia;
  video: BidiVideo | undefined;
  /** The browser provider's own recording, which takes the place of `video` when the provider records. */
  providerVideo: ProviderVideo | undefined;
  /** Navigations the driver itself has in flight, which the trace leaves to the step that started them. */
  ownNavigations = 0;
  /** One entry per navigation the driver has in flight, given the URL of the tab's document request a test route aborted. */
  readonly navigationAborts = new Set<{ url?: string }>();
  /** The viewport `browser.setViewport` set for the rest of the attempt; the configured one until then. */
  private viewport: ViewportSize | null;
  private creating: Promise<string> | undefined;
  /** The tab the attempt found open and adopted (`existingTab`), which it never closes. */
  private adopted: string | undefined;
  /** User contexts this attempt created and has not yet seen removed, tried again by every later removal and by `close`. */
  private readonly unremoved = new Set<string>();
  /**
   * Bumped by every user context the attempt starts to set up and by
   * `close`: one that lands for an earlier generation (a reset given up on,
   * superseded, or outlived by the attempt) removes itself instead of
   * replacing the one in use.
   */
  private generation = 0;
  private readonly ended = new AbortController();
  private preloads: string[] = [];
  private readonly addedScripts: string[] = [];
  private readonly granted = new Map<string, Promise<void>>();
  /** The web origins the attempt's documents have been at, whose storage a saved session keeps. */
  readonly visited = new Set<string>();
  private artifactCounter = 0;

  constructor(
    readonly browser: BidiBrowser,
    readonly settings: SessionSettings,
    readonly attempt: AttemptSettings,
    private readonly contexts: ContextTree,
  ) {
    this.media = settings.media;
    this.viewport = settings.viewport;
    this.input = new BidiInput({ connection: browser.connection, browser: settings.browser, context: () => this.requireContext(), viewport: () => this.viewportSize() });
    this.network = new AttemptNetwork(browser.connection, {
      siteHeaders: settings.siteHeaders,
      credentials: attempt.credentials,
      ours: (event) => this.owns(event.context),
      onPage: (context) => this.onPage(context),
      contexts,
      exclusive: browser.exclusive,
      browser: settings.browser,
      onFailure: (error) => this.latch.latch(error),
      onNavigationAbort: (context, url) => {
        if (context !== this.context) return;
        for (const watch of this.navigationAborts) watch.url ??= url;
      },
      holdAll: settings.holdRequests,
    });
    this.downloads = new AttemptDownloads(browser.connection, attempt.remoteDownloads);
  }

  /** Aborts when the attempt closes, ending work it started that nothing awaits any more. */
  get lifetime(): AbortSignal {
    return this.ended.signal;
  }

  /** The browser's BiDi connection. */
  get connection(): BidiConnection {
    return this.browser.connection;
  }

  /** Whether `context` belongs to this attempt's user context. */
  owns(context: string | null | undefined): boolean {
    return context != null && this.contexts.owner(context) === this.userContext;
  }

  /** Whether `context` is the attempt's tab or a frame in it: what a page-scoped wait listens to, not a tab the app opened. */
  onPage(context: string | null | undefined): boolean {
    return context != null && this.context !== undefined && this.contexts.top(context) === this.context;
  }

  /**
   * Sets up the attempt's first user context, binds the network to it, and,
   * when the attempt adopts the open tab, reads that tab before anything
   * navigates. `signal` aborting, or `close`, before it lands removes it.
   */
  async openUserContext(signal: AbortSignal): Promise<void> {
    await this.installUserContext(signal);
    await this.network.bind(this.userContext);
    if (this.settings.userContext === 'adopt-tab') await this.ensureContext();
  }

  /**
   * Replaces the user context with a clean one, the test's routes and added
   * init scripts carried over. The new one is set up in full before it
   * takes the old one's place in one step, and only then is the old one
   * removed, so no step ever runs between the two. One whose `signal`
   * aborted, or that a later replacement or `close` overtook, removes itself
   * and leaves the user context in use as it was.
   */
  async replaceUserContext(signal: AbortSignal): Promise<void> {
    const previous = await this.installUserContext(signal);
    this.retireContext();
    await this.video?.contextClosing();
    await this.network.bind(this.userContext);
    await this.dropUserContext(previous);
  }

  /**
   * Creates a user context (the browser's own one when the settings ask for
   * it) and applies everything scoped to it: the preloaded scripts,
   * downloads, the emulated user agent, locale (and the `accept-language`
   * Playwright's locale sends), time zone, and media. Every step settles
   * before a failure is thrown, and a failed or overtaken setup removes what
   * it made. Once set up, it is published in place of the attempt's user
   * context, whose scope is returned.
   */
  private async installUserContext(signal: AbortSignal): Promise<ScopedUserContext> {
    const generation = ++this.generation;
    const connection = this.connection;
    signal.throwIfAborted();
    const { userContext } = this.settings.userContext === 'fresh' ? await connection.send('browser.createUserContext', {}) : { userContext: DEFAULT_USER_CONTEXT };
    const preloads: string[] = [];
    const overtaken = (): boolean => signal.aborted || generation !== this.generation;
    try {
      if (overtaken()) throw cancelled('the attempt closed or gave up while its user context opened');
      const scoped = { userContexts: [userContext] as [string] };
      const sources = [
        wrapScript(BUILTINS_INIT_SCRIPT),
        wrapScript(READERS_INIT_SCRIPT),
        wrapScript(CLOSED_SHADOW_ROOTS_INIT_SCRIPT),
        wrapScript(HIT_INTERCEPTOR_INIT_SCRIPT),
        ...(this.settings.holdRequests ? [wrapScript(BLOCK_SERVICE_WORKERS)] : []),
        ...[...this.settings.initScripts.forAttempt(), ...this.addedScripts].map(wrapAppScript),
      ];
      const { userAgent, locale, timezoneId } = this.settings;
      const steps = await Promise.allSettled([
        ...sources.map(async (source) => {
          preloads.push((await connection.send('script.addPreloadScript', { functionDeclaration: source, ...scoped })).script);
        }),
        this.downloads.allow(userContext),
        userAgent === undefined ? undefined : connection.send('emulation.setUserAgentOverride', { userAgent, ...scoped }),
        locale === undefined ? undefined : connection.send('emulation.setLocaleOverride', { locale, ...scoped }),
        locale === undefined ? undefined : connection.send('network.setExtraHeaders', { headers: [{ name: 'accept-language', value: { type: 'string', value: locale } }], ...scoped }),
        timezoneId === undefined ? undefined : connection.send('emulation.setTimezoneOverride', { timezone: timezoneId, ...scoped }),
        this.applyMedia(userContext),
      ]);
      const failed = steps.find((step) => step.status === 'rejected');
      if (failed !== undefined) throw failed.reason;
      if (overtaken()) throw cancelled('the attempt closed or gave up while its user context opened');
    } catch (cause) {
      await releaseQuietly(this.dropUserContext({ userContext, preloads, context: undefined }));
      throw cause;
    }
    const previous = { userContext: this.userContext, preloads: this.preloads, context: this.context };
    this.userContext = userContext;
    this.preloads = preloads;
    this.granted.clear();
    this.visited.clear();
    return previous;
  }

  /** Ends the recording of the attempt's tab, forgets its user context, and removes it with its preload scripts. */
  private async closeUserContext(): Promise<void> {
    await this.video?.contextClosing();
    const current = { userContext: this.userContext, preloads: this.preloads, context: this.context };
    this.userContext = '';
    this.preloads = [];
    try {
      await this.dropUserContext(current);
    } finally {
      this.retireContext();
    }
  }

  /**
   * Removes a user context the attempt no longer uses, which closes its
   * tabs, then its preload scripts: removing a script from a live tab races
   * the tab's close inside the Chromium mapper. The browser's own user
   * context stays; only the tab the attempt opened there is closed.
   */
  private async dropUserContext(dropped: ScopedUserContext): Promise<void> {
    if (dropped.userContext === DEFAULT_USER_CONTEXT) {
      if (dropped.context !== undefined && dropped.context !== this.adopted) await releaseQuietly(this.connection.send('browsingContext.close', { context: dropped.context }));
    } else if (dropped.userContext !== '') this.unremoved.add(dropped.userContext);
    try {
      await this.removeUserContexts();
    } finally {
      await Promise.all(dropped.preloads.map((script) => releaseQuietly(this.connection.send('script.removePreloadScript', { script }))));
    }
  }

  /** Removes every user context still owed removal; one that fails stays owed, and the first failure is thrown. */
  private async removeUserContexts(): Promise<void> {
    const pending = [...this.unremoved];
    const results = await Promise.allSettled(pending.map((userContext) => this.connection.send('browser.removeUserContext', { userContext })));
    pending.forEach((userContext, index) => {
      const result = results[index]!;
      if (result.status === 'fulfilled' || (result.reason instanceof BidiError && result.reason.error === 'no such user context')) this.unremoved.delete(userContext);
    });
    const failed = results.find((result, index) => result.status === 'rejected' && this.unremoved.has(pending[index]!));
    if (failed !== undefined) throw (failed as PromiseRejectedResult).reason;
  }

  /**
   * Applies the media features on Chromium (`emulation.setMediaFeaturesOverride`);
   * Firefox takes the configured ones as launch preferences.
   */
  async applyMedia(userContext = this.userContext): Promise<void> {
    if (this.media.colorScheme === undefined && this.media.reducedMotion === undefined) return;
    const features: Emulation.MediaFeatures = obj({
      'prefers-color-scheme': this.media.colorScheme === 'no-preference' ? null : this.media.colorScheme,
      // Firefox overrides only the color scheme; its reduced motion is the launch preference.
      'prefers-reduced-motion': this.settings.browser === 'firefox' ? undefined : this.media.reducedMotion,
    });
    await this.connection.send('emulation.setMediaFeaturesOverride', { features, userContexts: [userContext] });
  }

  /** Adds an init script for every document of this user context from now on, and of every one that replaces it. */
  async addInitScript(source: string): Promise<void> {
    const { script } = await this.connection.send('script.addPreloadScript', {
      functionDeclaration: wrapAppScript(source),
      userContexts: [this.userContext],
    });
    this.addedScripts.push(source);
    this.preloads.push(script);
  }

  /** The attempt's tab; `INVALID_STATE` before the first open. */
  requireContext(): string {
    if (this.context === undefined) throw invalidState('no app page is open; call app.open() or browser.goto() first');
    return this.context;
  }

  /**
   * The attempt's tab, created on first use at the attempt's viewport, with
   * the network covering it and a video segment started when recording.
   * Concurrent first uses share one creation. A window on Firefox.
   */
  ensureContext(): Promise<string> {
    if (this.context !== undefined) return Promise.resolve(this.context);
    this.creating ??= this.createContext().finally(() => {
      this.creating = undefined;
    });
    return this.creating;
  }

  /**
   * Opens the attempt's tab in its user context, or adopts the one already
   * open there when the settings ask for it, refusing one that opened after
   * the user context was replaced.
   */
  private async createContext(): Promise<string> {
    const connection = this.connection;
    const userContext = this.userContext;
    if (userContext === '') throw invalidState('the attempt has no user context to open a tab in');
    this.adopted = this.settings.userContext === 'adopt-tab' ? await this.openTab(userContext) : undefined;
    const context = this.adopted ?? (await connection.send('browsingContext.create', {
      type: this.settings.browser === 'firefox' ? 'window' : 'tab',
      userContext,
    })).context;
    if (userContext !== this.userContext) {
      if (context !== this.adopted) await releaseQuietly(connection.send('browsingContext.close', { context }));
      throw new EngineError('NODE_STALE', 'the attempt replaced its user context while a tab opened', { retryable: true });
    }
    await this.network.addContext(context);
    if (this.viewport !== null) await connection.send('browsingContext.setViewport', { context, viewport: this.viewport });
    this.context = context;
    this.input.reset();
    await this.video?.contextOpened(context, await this.viewportSize());
    return context;
  }

  /** The first top-level tab already open in `userContext`, if any. */
  private async openTab(userContext: string): Promise<string | undefined> {
    const { contexts } = await this.connection.send('browsingContext.getTree', { maxDepth: 0 });
    return contexts.find((info) => info.userContext === userContext)?.context;
  }

  /** Resizes the tab, and every tab the attempt opens after it, to `size`. */
  async setViewport(size: ViewportSize): Promise<void> {
    this.viewport = { width: size.width, height: size.height };
    // Before the first page the size is only kept: the tab opens at it, and no page opens early.
    if (this.context === undefined) return;
    await this.connection.send('browsingContext.setViewport', { context: this.context, viewport: this.viewport });
  }

  /**
   * Closes the tab and every tab the app opened, keeping the user context's
   * storage, as a restart closes every page. Nothing more is closed once
   * `signal` aborted.
   */
  async closeContext(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.video?.contextClosing();
    this.retireContext();
    const { contexts } = await this.connection.send('browsingContext.getTree', { maxDepth: 0 });
    signal.throwIfAborted();
    const tabs = contexts.filter((info) => info.userContext === this.userContext).map((info) => info.context);
    await Promise.all(tabs.map(async (context) => {
      await this.network.removeContext(context);
      await unlessStale(this.connection.send('browsingContext.close', { context }), undefined);
    }));
  }

  /** Calls a page function in `context` (the tab by default). */
  call(declaration: string, args: readonly PageArgument[] = [], options?: CallOptions, context?: string): Promise<PageValue> {
    return callFunction(this.connection, context ?? this.requireContext(), declaration, args, options);
  }

  /**
   * Runs one of this driver's typed page functions in `context` (the tab by
   * default), with its element arguments as references and its result
   * converted back the same way; a promise it returns is awaited.
   */
  async run<F extends TypedPageFunction>(fn: F, args: Wire<Parameters<F>> & readonly PageArgument[], context?: string): Promise<Wire<Awaited<ReturnType<F>>>> {
    const value = await callFunction(this.connection, context ?? this.requireContext(), fn, args, { awaitPromise: true, maxObjectDepth: null });
    return value as Wire<Awaited<ReturnType<F>>>;
  }

  /** Calls the document's reader `name` in `context` (the tab by default). */
  async reader<K extends ReaderName>(name: K, args: ReaderArgs<K>, context?: string): Promise<ReaderResult<K>> {
    return (await this.callReader(name, args, undefined, context)) as ReaderResult<K>;
  }

  /**
   * Calls the document's encoded reader `name` in `context` (the tab by
   * default) and decodes its metadata: one JSON string, or, when the page's
   * JSON cannot be trusted, the value itself, read whole in the same call.
   */
  async readEncoded<K extends 'tree' | 'locate'>(name: K, args: ReaderArgs<K>, context?: string): Promise<{ metadata: Exclude<ReaderResult<K>[0], string>; elements: ElementRef[] }> {
    const [metadata, elements] = (await this.callReader(name, args, { maxObjectDepth: null }, context)) as ReaderResult<K>;
    // oxlint-disable-next-line e2e/no-unchecked-json -- page-reported metadata; each caller checks its alignment
    return { metadata: typeof metadata === 'string' ? JSON.parse(metadata) : metadata, elements };
  }

  /**
   * Calls one of the document's readers through the copy its preload
   * installed; a document without one (open before the preload) gets them
   * with the call, and keeps them.
   */
  private async callReader(name: ReaderName, args: readonly PageArgument[], options: CallOptions | undefined, context: string | undefined): Promise<unknown> {
    try {
      const value = await this.call(readerCall(name), args, options, context);
      if (value !== READERS_MISSING) return value;
      return await this.call(readerInstallCall(name), args, options, context);
    } catch (cause) {
      throw (await this.pageBrokeReader(name, cause, args, options, context)) ?? cause;
    }
  }

  /**
   * The failure of a reader the page's own scripts broke, as the test's
   * `EVALUATE_FAILED`, or undefined when something else failed. A page that
   * replaces a built-in method the readers call (`Map.prototype.set`) breaks
   * them in its world. Told apart by reading again in a sandbox realm, whose
   * built-ins and DOM bindings no page script reaches: a read that throws in
   * the page's world and passes there failed because of the page.
   */
  private async pageBrokeReader(name: ReaderName, cause: unknown, args: readonly PageArgument[], options: CallOptions | undefined, context: string | undefined): Promise<TestError | undefined> {
    if (!(cause instanceof ScriptError)) return undefined;
    try {
      await this.call(readerInstallCall(name), args, { ...options, sandbox: READER_PROBE_SANDBOX }, context);
    } catch {
      return undefined;
    }
    return new TestError('EVALUATE_FAILED', `the ${name} read failed: the page deleted or replaced a JavaScript built-in that in-page automation code needs: ${cause.message}`, { cause });
  }

  /**
   * Forgets the tab, which closed or is closing: its refs, frames, and the
   * input state that died with it, so the next use opens a fresh one.
   */
  retireContext(): void {
    this.context = undefined;
    this.refs.clear();
    this.frames.clear();
    this.input.reset();
  }

  /** Input sends and page mutations so far (`BidiInput.dispatches`). */
  get dispatches(): number {
    return this.input.dispatches;
  }

  /** Where the mouse last moved in the tab. */
  get pointer(): ViewportPoint {
    return this.input.pointer;
  }

  /** Counts a change the driver or the test's code made in the page (a fill, a select, an evaluate), which may have reached the app. */
  mutated(): void {
    this.input.mutated();
  }

  /**
   * Records a document of the attempt starting to load `url`: its origin is
   * remembered for a saved session, and granted the configured permissions,
   * once per origin and user context (BiDi grants per origin). Concurrent
   * calls for one origin share its grant.
   */
  visit(url: string): Promise<void> {
    if (!URL.canParse(url)) return Promise.resolve();
    const { origin, protocol } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return Promise.resolve();
    this.visited.add(origin);
    if (this.settings.permissions.length === 0) return Promise.resolve();
    let grant = this.granted.get(origin);
    if (grant === undefined) {
      const userContext = this.userContext;
      grant = Promise.all(this.settings.permissions.map((name) =>
        this.connection.send('permissions.setPermission', { descriptor: { name }, state: 'granted', origin, userContext }))).then(() => undefined);
      this.granted.set(origin, grant);
    }
    return grant;
  }

  /** The viewport in CSS pixels: the attempt's, else the window's. */
  async viewportSize(): Promise<ViewportSize> {
    if (this.viewport !== null) return this.viewport;
    return this.run(viewportSize, []);
  }

  /** The tab's URL, as the browser reports it. */
  async currentUrl(): Promise<string> {
    const { contexts } = await this.connection.send('browsingContext.getTree', { root: this.requireContext(), maxDepth: 0 });
    return contexts[0]?.url ?? '';
  }

  /** `context` and every frame document under it. */
  async documentContexts(context: string): Promise<string[]> {
    const { contexts } = await this.connection.send('browsingContext.getTree', { root: context });
    const out: string[] = [];
    const walk = (info: (typeof contexts)[number]): void => {
      out.push(info.context);
      for (const child of info.children ?? []) walk(child);
    };
    for (const info of contexts) walk(info);
    return out;
  }

  /** The cookie partition of this user context. */
  partition(): Storage.StorageKeyPartitionDescriptor {
    return { type: 'storageKey', userContext: this.userContext };
  }

  /** Reserves one artifact path under the attempt directory: a counter keeps names unique, the label readable. */
  artifactPath(folder: string, label: string | undefined, extension: string): { relative: string; absolute: string } {
    this.artifactCounter += 1;
    const name = `${String(this.artifactCounter).padStart(3, '0')}${label === undefined ? '' : `-${sanitizeFilename(label)}`}${extension}`;
    const relative = path.posix.join(folder, name);
    const absolute = path.join(this.attempt.artifactsDir, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    return { relative, absolute };
  }

  /**
   * Ends the attempt: its video, user context, network, and download
   * directory, each attempted whatever the others did; the first failure is
   * reported once all ran, each remote step bounded so a hung one never keeps
   * the rest from running. A browser already gone leaves only local work. A
   * replacement user context still opening removes itself when it lands.
   */
  async close(): Promise<void> {
    this.generation += 1;
    this.ended.abort();
    const gone = this.connection.isClosed;
    const step = (label: string, work: () => unknown): (() => Promise<unknown>) => () =>
      withTimeout(Promise.resolve().then(work), CLOSE_STEP_MS, () => new EngineError('OPERATION_TIMEOUT', `${label} did not finish within ${CLOSE_STEP_MS}ms`, { retryable: false }));
    const results = await settleEach([
      step('video stop', () => this.video?.stop()),
      step('provider video', () => this.providerVideo?.abandon(AbortSignal.timeout(CLOSE_STEP_MS))),
      step('user context removal', () => (gone ? undefined : this.closeUserContext())),
      step('earlier user contexts', () => (gone ? undefined : this.removeUserContexts())),
      step('network release', () => this.network.dispose()),
      () => this.downloads.dispose(),
    ]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
  }
}

/** The query parameter that marks a scratch document a saved-state read or write opens, which the app's init scripts skip. */
export const SCRATCH_PARAM = '__e2e_state_scratch';

/** A driver script's source as a preload script's function declaration. */
function wrapScript(source: string): string {
  return `() => {\n${source}\n}`;
}

/** An app init script's source as a preload script's function declaration: it runs in every document but a saved-state scratch one, which it must not change. */
function wrapAppScript(source: string): string {
  return `() => {\nif (new URLSearchParams(location.search).has(${JSON.stringify(SCRATCH_PARAM)})) return;\n${source}\n}`;
}

/** Runs each step in order whatever the earlier ones did, and settles with every outcome. */
async function settleEach(steps: readonly (() => unknown)[]): Promise<PromiseSettledResult<unknown>[]> {
  const results: PromiseSettledResult<unknown>[] = [];
  for (const step of steps) {
    try {
      results.push({ status: 'fulfilled', value: await step() });
    } catch (reason) {
      results.push({ status: 'rejected', reason });
    }
  }
  return results;
}
