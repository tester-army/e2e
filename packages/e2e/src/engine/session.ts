/**
 * The engine-to-session adapter. One adapter per attempt satisfies
 * the internal `TargetSession` surface over the engine contract, so the agent
 * tier, the judgment tier, the trace cache, and the fixture graph program
 * against one shape. It is the single seam every engine call crosses, which
 * makes it the one place two rules are enforced: a capability the engine does
 * not declare fails loud with `UNSUPPORTED_CAPABILITY` at the moment of use,
 * and anything an engine throws that is not an `EngineError` is normalized to
 * a non-retryable `ENGINE_FAILURE`, so a crashed engine is an infrastructure
 * failure everywhere and never a retry-eligible test failure.
 */

import {
  asEngineError,
  ConfigurationError,
  E2EError,
  errorMessage,
  isForeignE2EError,
} from '../internal/errors.ts';
import type { EngineHandle } from './index.ts';
import {
  EngineError,
  type GrammarVerb,
  type NodeRef,
  type SemanticNode,
  type SessionApp,
  type SessionArtifacts,
  type TargetSession,
} from './surface.ts';

export interface EngineSessionOptions {
  readonly engine: EngineHandle | undefined;
  readonly targetName: string;
}

/** Located refs are pruned oldest-first past this bound so the map cannot grow unboundedly. */
const MAX_LOCATED_REFS = 2048;

/** Revision prefixes: the adapter mints `l<n>` for locate and `b<n>` for observe. */
const LOCATE_REVISION_PREFIX = 'l';
const OBSERVE_REVISION_PREFIX = 'b';

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

/** Wraps an engine snapshot's root nodes into the single-root observation tree. */
function toTree(nodes: readonly SemanticNode[], revision: string): SemanticNode {
  const stamped = nodes.map((node) => stampRevision(node, revision));
  const first = stamped[0];
  if (stamped.length === 1 && first !== undefined) return first;
  return { ref: { id: 'root', revision }, role: 'root', children: stamped };
}

function countSecure(nodes: readonly SemanticNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.states?.secure === true) count += 1;
    if (node.children !== undefined) count += countSecure(node.children);
  }
  return count;
}

/**
 * Normalizes what an engine threw onto the error contract. `EngineError`
 * (from any module copy) and runner errors pass through; anything else is the
 * engine failing outside its contract, reported as infrastructure.
 */
function normalize(cause: unknown, label: string): never {
  if (cause instanceof E2EError || isForeignE2EError(cause) || asEngineError(cause) !== undefined) {
    throw cause;
  }
  throw new EngineError('ENGINE_FAILURE', `${label} failed: ${errorMessage(cause)}`, {
    retryable: false,
    cause,
  });
}

/** The grammar verbs an engine declaration can honor. */
function declaredVerbs(engine: EngineHandle | undefined): ReadonlySet<GrammarVerb> {
  const verbs = new Set<GrammarVerb>();
  if (engine?.perform !== undefined) {
    for (const verb of ['tap', 'type', 'typeSecret', 'press', 'select'] as const) verbs.add(verb);
  }
  if (engine?.swipe !== undefined) verbs.add('scroll');
  if (engine?.app?.navigate !== undefined) verbs.add('navigate');
  return verbs;
}

/**
 * Builds one session over an engine. One adapter per attempt; revisions are
 * minted per adapter, so refs can never leak across attempts.
 */
export function createEngineSession(options: EngineSessionOptions): TargetSession {
  const { engine, targetName } = options;
  let revision = 0;
  let viewport = { width: 1, height: 1, scale: 1 };

  const unsupported = (what: string): never => {
    const remedy =
      engine === undefined
        ? 'the target declares no engine; add one, such as playwright({ url }) from @e2edev/playwright or agentDevice({ platform, app }) from @e2edev/agent-device'
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

  const app: SessionApp = {
    open: guard('navigation', engine?.app?.navigate),
    back: guard('back navigation', engine?.app?.back),
    restart: guard('app restart', engine?.app?.restart),
    clearState: guard('app state clearing', engine?.app?.clearState),
  };

  const artifacts: SessionArtifacts = {
    screenshot: guard('screenshots', engine?.artifacts?.screenshot),
    ...(engine?.artifacts?.startTrace === undefined || engine.artifacts.stopTrace === undefined
      ? {}
      : {
          startTrace: guard('traces', engine.artifacts.startTrace),
          stopTrace: guard('traces', engine.artifacts.stopTrace),
        }),
    ...(engine?.artifacts?.startVideo === undefined || engine.artifacts.stopVideo === undefined
      ? {}
      : {
          startVideo: guard('video recording', engine.artifacts.startVideo),
          stopVideo: guard('video recording', engine.artifacts.stopVideo),
        }),
  };

  let ended = false;

  return {
    verbs: declaredVerbs(engine),
    app,
    artifacts,
    ...(engine?.state === undefined
      ? {}
      : {
          captureState: guard('state capture', engine.state.capture),
          restoreState: guard('state restore', engine.state.restore),
        }),
    ...(engine?.url === undefined ? {} : { url: guard('the current URL', engine.url) }),
    async observe(operation, observeOptions) {
      const snapshot = await observeRaw(
        operation,
        observeOptions?.pixels === true ? { pixels: true } : {},
      );
      if (snapshot.viewport !== undefined) viewport = snapshot.viewport;
      revision += 1;
      const minted = `${OBSERVE_REVISION_PREFIX}${revision}`;
      return {
        revision: minted,
        capturedAt: new Date().toISOString(),
        ...(snapshot.url === undefined ? {} : { url: snapshot.url }),
        ...(snapshot.pixels === undefined ? {} : { pixels: snapshot.pixels }),
        tree: toTree(snapshot.nodes, minted),
        viewport,
        redaction: {
          secureNodeCount: countSecure(snapshot.nodes),
          maskedRegionCount: snapshot.maskedRegionCount ?? 0,
        },
      };
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
      rejectSupersededLocate(ref);
      if (action.kind === 'dragTo') rejectSupersededLocate(action.target);
      await guard(`the "${action.kind}" action`, engine?.perform)(ref, action, operation);
    },
    swipe: guard('swipe gestures', engine?.swipe),
    // The engine outlives the attempt; only the per-attempt isolation ends
    // here, exactly once. dispose() belongs to the worker.
    close: guard('attempt end', async (operation) => {
      if (ended) return;
      ended = true;
      await engine?.endAttempt?.({ signal: operation.signal, timeoutMs: operation.timeoutMs });
    }),
  };
}
