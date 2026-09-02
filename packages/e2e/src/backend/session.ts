/**
 * The backend-to-session adapter (RFC0002). One adapter per attempt satisfies
 * the internal `TargetSession` surface over the backend contract, so the agent
 * tier, the judgment tier, the trace cache, and the fixture graph program
 * against one shape. It is the single seam every backend call crosses, which
 * makes it the one place two rules are enforced: a capability the backend does
 * not declare fails loud with `UNSUPPORTED_CAPABILITY` at the moment of use,
 * and anything a backend throws that is not a `BackendError` is normalized to
 * a non-retryable `BACKEND_FAILURE`, so a crashed backend is an infrastructure
 * failure everywhere and never a retry-eligible test failure.
 */

import {
  asBackendError,
  ConfigurationError,
  E2EError,
  errorMessage,
  isForeignE2EError,
} from '../internal/errors.ts';
import type { BackendHandle } from './index.ts';
import {
  BackendError,
  type GrammarVerb,
  type NodeRef,
  type SemanticNode,
  type SessionApp,
  type SessionArtifacts,
  type TargetSession,
} from './surface.ts';

export interface BackendSessionOptions {
  readonly backend: BackendHandle | undefined;
  readonly targetName: string;
}

/** Located refs are pruned oldest-first past this bound so the map cannot grow unboundedly. */
const MAX_LOCATED_REFS = 2048;

/** Revision prefixes: the adapter mints `l<n>` for locate and `b<n>` for observe. */
const LOCATE_REVISION_PREFIX = 'l';
const OBSERVE_REVISION_PREFIX = 'b';

/**
 * Stamps the adapter's revision onto every ref. Backends mint stable ids;
 * the adapter owns revisions, so the staleness rule (act on the newest
 * observation only) holds without every backend reimplementing it.
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

/** Wraps a backend snapshot's root nodes into the single-root observation tree. */
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
 * Normalizes what a backend threw onto the error contract. `BackendError`
 * (from any module copy) and runner errors pass through; anything else is the
 * backend failing outside its contract, reported as infrastructure.
 */
function normalize(cause: unknown, label: string): never {
  if (cause instanceof E2EError || isForeignE2EError(cause) || asBackendError(cause) !== undefined) {
    throw cause;
  }
  throw new BackendError('BACKEND_FAILURE', `${label} failed: ${errorMessage(cause)}`, {
    retryable: false,
    cause,
  });
}

/** The grammar verbs a backend declaration can honor. */
function declaredVerbs(backend: BackendHandle | undefined): ReadonlySet<GrammarVerb> {
  const verbs = new Set<GrammarVerb>();
  if (backend?.perform !== undefined) {
    for (const verb of ['tap', 'type', 'typeSecret', 'press', 'select'] as const) verbs.add(verb);
  }
  if (backend?.swipe !== undefined) verbs.add('scroll');
  if (backend?.app?.navigate !== undefined) verbs.add('navigate');
  return verbs;
}

/**
 * Builds one session over a backend. One adapter per attempt; revisions are
 * minted per adapter, so refs can never leak across attempts.
 */
export function createBackendSession(options: BackendSessionOptions): TargetSession {
  const { backend, targetName } = options;
  let revision = 0;
  let viewport = { width: 1, height: 1, scale: 1 };

  const unsupported = (what: string): never => {
    throw new ConfigurationError(
      'UNSUPPORTED_CAPABILITY',
      `target "${targetName}" has no backend capability for ${what}`,
    );
  };

  /**
   * One declared member as a guarded call: capability-checked at the moment of
   * use and error-normalized. `defineBackend` bound every member to its body,
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
  // which the engine treats as retryable: it re-resolves and reads again.
  let locateRevision = 0;
  const located = new Map<string, SemanticNode>();

  const stale = (ref: NodeRef): BackendError =>
    new BackendError('NODE_STALE', `node ${ref.id} is stale; re-resolve`, { retryable: true });

  /**
   * A located ref from a superseded resolution never reaches the backend.
   * Observation refs are exempt: they are checked by the backend against its
   * newest observation, and a backend with stable ids may legitimately hand
   * the same id to both tiers.
   */
  const rejectSupersededLocate = (ref: NodeRef): void => {
    if (!ref.revision.startsWith(LOCATE_REVISION_PREFIX)) return;
    const known = located.get(ref.id);
    if (known !== undefined && known.ref.revision !== ref.revision) throw stale(ref);
  };

  const locateRaw = guard('locators (screen)', backend?.locate);
  const observeRaw = guard('observation', backend?.observe);

  const app: SessionApp = {
    open: guard('navigation', backend?.app?.navigate),
    back: guard('back navigation', backend?.app?.back),
    restart: guard('app restart', backend?.app?.restart),
    clearState: guard('app state clearing', backend?.app?.clearState),
  };

  const artifacts: SessionArtifacts = {
    screenshot: guard('screenshots', backend?.artifacts?.screenshot),
    ...(backend?.artifacts?.startTrace === undefined || backend.artifacts.stopTrace === undefined
      ? {}
      : {
          startTrace: guard('traces', backend.artifacts.startTrace),
          stopTrace: guard('traces', backend.artifacts.stopTrace),
        }),
  };

  let ended = false;

  return {
    verbs: declaredVerbs(backend),
    app,
    artifacts,
    ...(backend?.state === undefined
      ? {}
      : {
          captureState: guard('state capture', backend.state.capture),
          restoreState: guard('state restore', backend.state.restore),
        }),
    ...(backend?.url === undefined ? {} : { url: guard('the current URL', backend.url) }),
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
      const nodes = await locateRaw(expression, operation);
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
      if (backend?.locate === undefined) unsupported('locators (screen)');
      const node = located.get(ref.id);
      if (node === undefined || node.ref.revision !== ref.revision) throw stale(ref);
      return node;
    },
    async perform(ref, action, operation) {
      rejectSupersededLocate(ref);
      if (action.kind === 'dragTo') rejectSupersededLocate(action.target);
      await guard(`the "${action.kind}" action`, backend?.perform)(ref, action, operation);
    },
    swipe: guard('swipe gestures', backend?.swipe),
    // The backend outlives the attempt; only the per-attempt isolation ends
    // here, exactly once. dispose() belongs to the worker.
    close: guard('attempt end', async (operation) => {
      if (ended) return;
      ended = true;
      await backend?.endAttempt?.({ signal: operation.signal, timeoutMs: operation.timeoutMs });
    }),
  };
}
