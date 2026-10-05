/**
 * The engine-to-session adapter. One adapter per attempt satisfies
 * the internal `TargetSession` surface over the engine contract, so the agent
 * tier, the judgment tier, the trace cache, and the fixture graph program
 * against one shape. It is the single seam every engine call crosses, which
 * makes it the one place three rules are enforced: a capability the engine
 * does not declare fails loud with `UNSUPPORTED_CAPABILITY` at the moment of
 * use, a `press` key outside the contract grammar fails with
 * `INVALID_ARGUMENT` before any engine sees it, and anything an engine throws
 * that is not an `EngineError` is normalized to
 * a non-retryable `ENGINE_FAILURE`, so a crashed engine is an infrastructure
 * failure everywhere and never a retry-eligible test failure.
 */

import {
  asEngineError,
  ConfigurationError,
  errorMessage,
  isE2EError,
  TestError,
} from '../internal/errors.ts';
import { requireKey } from '../internal/keys.ts';
import { timestamp } from '../internal/ids.ts';
import type { AppLogEntry, EngineHandle, EngineSnapshot } from './index.ts';
import {
  type AppLogRoute,
  EngineError,
  type EnvironmentFacts,
  type GrammarVerb,
  type LocatorActionKind,
  type NodeRef,
  type Observation,
  type PointerActionKind,
  type SemanticNode,
  type SessionApp,
  type SessionArtifacts,
  type TargetSession,
} from './surface.ts';

export interface EngineSessionOptions {
  readonly engine: EngineHandle | undefined;
  readonly targetName: string;
}

/** App log entries held while no step recorder takes them, the launch's own. */
const MAX_WAITING_APP_LOG = 50;
const APP_LOG_SOURCES: ReadonlySet<unknown> = new Set(['console', 'error', 'network', 'system', 'navigation']);
const APP_LOG_LEVELS: ReadonlySet<unknown> = new Set(['error', 'warning', 'info']);

/** Whether an engine handed `appLog` an entry of the contract's shape. */
function isAppLogEntry(value: unknown): value is AppLogEntry {
  if (typeof value !== 'object' || value === null) return false;
  const { source, level, text } = value as Partial<Record<keyof AppLogEntry, unknown>>;
  return APP_LOG_SOURCES.has(source) && APP_LOG_LEVELS.has(level) && typeof text === 'string' && text.trim() !== '';
}

/** The session's app log route; see `AppLogRoute`. */
function createAppLogRoute(): AppLogRoute {
  let sink: ((entry: AppLogEntry, at: string) => void) | undefined;
  const waiting: { entry: AppLogEntry; at: string }[] = [];
  return {
    push(entry) {
      if (!isAppLogEntry(entry)) return;
      const copy: AppLogEntry = { source: entry.source, level: entry.level, text: entry.text };
      if (sink !== undefined) sink(copy, timestamp());
      else if (waiting.length < MAX_WAITING_APP_LOG) waiting.push({ entry: copy, at: timestamp() });
    },
    route(next) {
      sink = next;
      if (sink === undefined) return;
      for (const { entry, at } of waiting.splice(0)) sink(entry, at);
    },
  };
}

/** Facts `environment` keeps, and the characters of each key and value. */
const MAX_ENVIRONMENT_FACTS = 8;
const MAX_ENVIRONMENT_KEY_CHARS = 40;
const MAX_ENVIRONMENT_VALUE_CHARS = 200;

/** The session's environment facts; see `EnvironmentFacts`. */
function createEnvironmentFacts(): EnvironmentFacts {
  const facts = new Map<string, string>();
  return {
    push(next) {
      if (typeof next !== 'object' || next === null) return;
      for (const [key, value] of Object.entries(next)) {
        if (typeof value !== 'string' || key.trim() === '' || value.trim() === '') continue;
        const name = key.trim().slice(0, MAX_ENVIRONMENT_KEY_CHARS);
        if (!facts.has(name) && facts.size >= MAX_ENVIRONMENT_FACTS) continue;
        facts.set(name, value.replace(/\s+/g, ' ').trim().slice(0, MAX_ENVIRONMENT_VALUE_CHARS));
      }
    },
    read: () => Object.fromEntries(facts),
  };
}

/** Whether an engine handed `screen` a snapshot of the contract's shape, as far as the trace reads it. */
function isEngineSnapshot(value: unknown): value is EngineSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const { root, viewport } = value as Partial<Record<keyof EngineSnapshot, unknown>>;
  return typeof root === 'object' && root !== null && typeof (root as SemanticNode).ref?.id === 'string' && typeof viewport === 'object' && viewport !== null;
}

/** Located refs are pruned oldest-first past this bound so the map cannot grow unboundedly. */
const MAX_LOCATED_REFS = 2048;

/** Revision prefixes: the adapter mints `l<n>` for locate, `b<n>` for observe, and `s<n>` for a screen the engine handed over. */
const LOCATE_REVISION_PREFIX = 'l';
const OBSERVE_REVISION_PREFIX = 'b';
const SCREEN_REVISION_PREFIX = 's';

/**
 * Stamps the adapter's revision onto every ref. Engines mint stable ids;
 * the adapter owns revisions, so the staleness rule (act on the newest
 * observation only) holds without every engine reimplementing it.
 */
function stampRevision(node: SemanticNode, revision: string): SemanticNode {
  return {
    ...node,
    ref: { id: node.ref.id, revision },
    ...(node.children === undefined
      ? {}
      : { children: node.children.map((child) => stampRevision(child, revision)) }),
  };
}

function countSecure(node: SemanticNode): number {
  let count = node.states?.secure === true ? 1 : 0;
  for (const child of node.children ?? []) count += countSecure(child);
  return count;
}

/**
 * Normalizes what an engine threw onto the error contract. `EngineError`
 * (from any module copy) and runner errors pass through; anything else is the
 * engine failing outside its contract, reported as infrastructure.
 */
function normalize(cause: unknown, label: string): never {
  if (isE2EError(cause) || asEngineError(cause) !== undefined) {
    throw cause;
  }
  throw new EngineError('ENGINE_FAILURE', `${label} failed: ${errorMessage(cause)}`, {
    retryable: false,
    cause,
  });
}

/**
 * The action kinds an engine must declare for each kind-derived grammar
 * verb. `check` sets a state rather than flipping one, so it needs both
 * directions; `fill` unlocks the plain and the secret fill alike.
 */
const KINDS_BY_VERB: readonly (readonly [GrammarVerb, readonly LocatorActionKind[]])[] = [
  ['tap', ['tap']],
  ['doubleTap', ['doubleTap']],
  ['longPress', ['longPress']],
  ['secondaryTap', ['secondaryTap']],
  ['hover', ['hover']],
  ['type', ['fill']],
  ['typeSecret', ['fill']],
  ['press', ['press']],
  ['select', ['selectOption']],
  ['check', ['check', 'uncheck']],
  ['scroll', ['swipe']],
  ['scrollTo', ['scrollIntoView']],
  ['scrollUntil', ['swipe']],
  ['drag', ['dragTo']],
  ['upload', ['setInputFiles']],
];

/** The grammar verbs an engine declaration can honor. */
function declaredVerbs(engine: EngineHandle | undefined): ReadonlySet<GrammarVerb> {
  const verbs = new Set<GrammarVerb>();
  const kinds = new Set(engine?.actions ?? []);
  for (const [verb, required] of KINDS_BY_VERB) {
    if (required.every((kind) => kinds.has(kind))) verbs.add(verb);
  }
  if (engine?.pointerActions?.includes('tap') === true) verbs.add('tapAt');
  if (engine?.pointerActions?.includes('hover') === true) verbs.add('hoverAt');
  if (engine?.session?.back !== undefined) verbs.add('back');
  if (engine?.keyboard !== undefined) {
    verbs.add('typeText');
    verbs.add('pressKey');
    if (engine.keyboard.dismiss !== undefined) verbs.add('dismissKeyboard');
  }
  if (engine?.session?.open !== undefined) verbs.add('navigate');
  return verbs;
}

/**
 * Builds one session over an engine. One adapter per attempt; revisions are
 * minted per adapter, so refs can never leak across attempts.
 */
export function createEngineSession(options: EngineSessionOptions): TargetSession {
  const { engine, targetName } = options;
  let revision = 0;
  /** The root ref of the newest observation, the address of a viewport swipe; unset until the first observation. */
  let root: NodeRef | undefined;

  const unsupported = (what: string): never => {
    const remedy =
      engine === undefined
        ? 'the target declares no engine; add one, such as web() from @e2e-dev/web or mobile({ platform }) from @e2e-dev/mobile'
        : `engine ${engine.name} does not implement it`;
    throw new ConfigurationError(
      'UNSUPPORTED_CAPABILITY',
      `target "${targetName}" has no engine capability for ${what}: ${remedy}`,
    );
  };

  /**
   * One declared member as a guarded call: capability-checked at the moment of
   * use and error-normalized. `defineEngine` bound every member to its body,
   * so the function is called as is.
   */
  const guard =
    <A extends unknown[], R>(what: string, fn: ((...args: A) => Promise<R>) | undefined) =>
    async (...args: A): Promise<R> => {
      if (fn === undefined) return unsupported(what);
      try {
        return await fn(...args);
      } catch (cause) {
        return normalize(cause, what);
      }
    };

  // Located nodes, cached by id so `read(ref)` answers from the resolution
  // that minted the ref. A read against an older resolution is NODE_STALE,
  // which the locator engine treats as retryable: it re-resolves and reads again.
  let locateRevision = 0;
  const located = new Map<string, SemanticNode>();

  const stale = (ref: NodeRef): EngineError =>
    new EngineError('NODE_STALE', `node ${ref.id} is stale; re-resolve`, { retryable: true });

  /**
   * A located ref from a superseded resolution never reaches the engine.
   * Observation refs are exempt: they are checked by the engine against its
   * newest observation, and an engine with stable ids may legitimately hand
   * the same id to both tiers.
   */
  const rejectSupersededLocate = (ref: NodeRef): void => {
    if (!ref.revision.startsWith(LOCATE_REVISION_PREFIX)) return;
    const known = located.get(ref.id);
    if (known !== undefined && known.ref.revision !== ref.revision) throw stale(ref);
  };

  const locateRaw = guard('locators (screen)', engine?.locate);
  const observeRaw = guard('observation', engine?.observe);
  const performRaw = guard('actions', engine?.perform);
  const actions: ReadonlySet<LocatorActionKind> = new Set(engine?.actions ?? []);
  const performAtRaw = guard('point actions', engine?.performAt);
  const pointerActions: ReadonlySet<PointerActionKind> = new Set(engine?.pointerActions ?? []);
  const tapModifiers = engine?.tapModifiers === true;

  const app: SessionApp = {
    open: guard('navigation', engine?.session?.open),
    back: guard('back navigation', engine?.session?.back),
    restart: guard('app restart', engine?.session?.restart),
    reset: guard('app state reset', engine?.session?.reset),
  };

  const artifacts: SessionArtifacts = {
    screenshot: guard('screenshots', engine?.artifacts?.screenshot),
    ...(engine?.artifacts?.startVideo === undefined || engine.artifacts.stopVideo === undefined
      ? {}
      : {
          startVideo: guard('video recording', engine.artifacts.startVideo),
          stopVideo: guard('video recording', engine.artifacts.stopVideo),
        }),
  };

  let ended = false;
  let screenSink: ((observation: Observation) => void) | undefined;
  let screenRevision = 0;
  /** Hands one screen to the trace; a sink that throws never fails what the session was doing. */
  const showScreen = (observation: Observation): void => {
    try {
      screenSink?.(observation);
    } catch {
      // The trace is a reader; it never fails an action.
    }
  };

  const session: TargetSession = {
    verbs: declaredVerbs(engine),
    actions,
    pointerActions,
    tapModifiers,
    app,
    artifacts,
    appLog: createAppLogRoute(),
    screens: {
      push(snapshot) {
        if (screenSink === undefined || !isEngineSnapshot(snapshot) || snapshot.treeUnavailable === true) return;
        screenRevision += 1;
        const minted = `${SCREEN_REVISION_PREFIX}${screenRevision}`;
        showScreen({
          kind: 'semantic',
          root: { ...snapshot.root.ref, revision: minted },
          revision: minted,
          capturedAt: new Date().toISOString(),
          ...(snapshot.location === undefined ? {} : { location: snapshot.location }),
          viewport: snapshot.viewport,
          redaction: { secureNodeCount: countSecure(snapshot.root), maskedRegionCount: 0 },
          tree: stampRevision(snapshot.root, minted),
          truncated: snapshot.truncated === true,
        });
      },
      route(sink) {
        screenSink = sink;
      },
    },
    environment: createEnvironmentFacts(),
    ...(engine?.state === undefined
      ? {}
      : {
          captureState: guard('state capture', engine.state.capture),
          restoreState: guard('state restore', engine.state.restore),
        }),
    async observe(operation, observeOptions) {
      const snapshot = await observeRaw(
        operation,
        {
          ...(observeOptions?.pixels === true ? { pixels: true } : {}),
          ...(observeOptions?.pixelFallback === true ? { pixelFallback: true } : {}),
        },
      );
      const minted = `${OBSERVE_REVISION_PREFIX}${revision + 1}`;
      const metadata = {
        root: { ...snapshot.root.ref, revision: minted },
        revision: minted,
        capturedAt: new Date().toISOString(),
        ...(snapshot.location === undefined ? {} : { location: snapshot.location }),
        viewport: snapshot.viewport,
        redaction: {
          secureNodeCount: countSecure(snapshot.root),
          maskedRegionCount: snapshot.maskedRegionCount ?? 0,
        },
      };
      if (snapshot.treeUnavailable === true) {
        if (observeOptions?.pixelFallback !== true || snapshot.pixels === undefined) {
          throw new TestError('UNSUPPORTED_CAPABILITY', 'unavailable semantics require permitted fallback pixels');
        }
        if (Object.keys(snapshot.root).some((key) => key !== 'ref')) {
          throw new EngineError('INVALID_STATE', 'an unavailable semantic tree must contain only the stable root reference', { retryable: false });
        }
        located.clear();
        revision += 1;
        root = metadata.root;
        return { ...metadata, kind: 'pixels', pixels: snapshot.pixels };
      }
      revision += 1;
      root = metadata.root;
      const observation: Observation = {
        ...metadata,
        kind: 'semantic',
        tree: stampRevision(snapshot.root, minted),
        truncated: snapshot.truncated === true,
        ...(snapshot.pixels === undefined ? {} : { pixels: snapshot.pixels }),
      };
      showScreen(observation);
      return observation;
    },
    async locate(expression, operation) {
      // An engine answers `visible` inside scopes, filters, and indices, where
      // only it can; the harness holds a top-level query to the same predicate
      // so a direct query never resolves to a node its own state calls hidden.
      const nodes = (await locateRaw(expression, operation)).filter(
        (node) =>
          !(expression.kind === 'query' && expression.query.visible === true) ||
          node.states?.hidden !== true,
      );
      locateRevision += 1;
      const locateRev = `${LOCATE_REVISION_PREFIX}${locateRevision}`;
      const refs: NodeRef[] = [];
      for (const node of nodes) {
        const stamped = stampRevision(node, locateRev);
        located.delete(stamped.ref.id);
        located.set(stamped.ref.id, stamped);
        refs.push(stamped.ref);
      }
      for (const oldest of located.keys()) {
        if (located.size <= MAX_LOCATED_REFS) break;
        located.delete(oldest);
      }
      return refs;
    },
    async read(ref) {
      if (engine?.locate === undefined) unsupported('locators (screen)');
      const node = located.get(ref.id);
      if (node === undefined || node.ref.revision !== ref.revision) throw stale(ref);
      return node;
    },
    async perform(ref, action, operation) {
      if (!actions.has(action.kind)) unsupported(`the "${action.kind}" action`);
      if ('modifiers' in action && action.modifiers !== undefined && !tapModifiers) {
        unsupported(`modifiers on the "${action.kind}" action`);
      }
      if (action.kind === 'press') requireKey(action.key);
      rejectSupersededLocate(ref);
      if (action.kind === 'dragTo') rejectSupersededLocate(action.target);
      await performRaw(ref, action, operation);
    },
    async swipe(direction, momentum, operation) {
      if (!actions.has('swipe')) unsupported('swipe gestures');
      const target = root ?? (await session.observe(operation)).root;
      await performRaw(target, { kind: 'swipe', direction, ...(momentum === undefined ? {} : { momentum }) }, operation);
    },
    async performAt(point, action, operation) {
      if (!pointerActions.has(action.kind)) unsupported(`the "${action.kind}" action at a point`);
      await performAtRaw(point, action, operation);
    },
    keyboard: {
      type: guard('keyboard input', engine?.keyboard?.type),
      press: (key, operation) => {
        requireKey(key);
        return guard('keyboard input', engine?.keyboard?.press)(key, operation);
      },
      dismiss: guard('keyboard dismissal', engine?.keyboard?.dismiss),
    },
    settle: guard('attempt settle', async (operation) => {
      await engine?.settleAttempt?.({ signal: operation.signal, timeoutMs: operation.timeoutMs });
    }),
    // The engine outlives the attempt; only the per-attempt isolation ends
    // here, exactly once. dispose() belongs to the worker.
    close: guard('attempt end', async (operation) => {
      if (ended) return;
      ended = true;
      await engine?.endAttempt?.({ signal: operation.signal, timeoutMs: operation.timeoutMs });
    }),
  };
  return session;
}
