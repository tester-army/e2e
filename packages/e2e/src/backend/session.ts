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
  type NodeRef,
  type Observation,
  type ObserveOptions,
  type OperationContext,
  type SemanticNode,
  type SessionActions,
  type SessionApp,
  type SessionArtifacts,
  type SessionScreen,
  type TargetSession,
} from './surface.ts';

export interface BackendSessionOptions {
  readonly backend: BackendHandle | undefined;
  readonly targetName: string;
}

/** Located refs are pruned oldest-first past this bound so the map cannot grow unboundedly. */
const MAX_LOCATED_REFS = 2048;

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

  /** Resolves one declared member bound to its owner, or fails loud. */
  const member = <Owner extends object, Key extends keyof Owner>(
    owner: Owner | undefined,
    key: Key,
    what: string,
  ): NonNullable<Owner[Key]> => {
    const value = owner?.[key];
    if (typeof value !== 'function') unsupported(what);
    return (value as (...args: never[]) => unknown).bind(owner) as NonNullable<Owner[Key]>;
  };

  /** Runs one backend call under the error contract. */
  const guarded = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (cause) {
      return normalize(cause, label);
    }
  };

  /** One declared member as a guarded call: capability-checked, error-normalized. */
  const call =
    <Owner extends object, Key extends keyof Owner>(owner: Owner | undefined, key: Key, what: string) =>
    (...args: Parameters<Extract<NonNullable<Owner[Key]>, (...inner: never[]) => unknown>>) =>
      guarded(what, () =>
        (member(owner, key, what) as (...inner: typeof args) => Promise<never>)(...args),
      ) as ReturnType<Extract<NonNullable<Owner[Key]>, (...inner: never[]) => unknown>>;

  const actions: SessionActions = {
    tap: call(backend?.actions, 'tap', 'tap'),
    type: (target, value, _sensitive, operation) =>
      call(backend?.actions, 'type', 'type')(target, value, operation),
    scroll: (direction, scrollOptions, operation) =>
      call(backend?.actions, 'scroll', 'scroll')(
        direction,
        scrollOptions.target === undefined ? undefined : { ref: scrollOptions.target },
        operation,
      ),
  };

  // Located nodes, cached by id so `read(ref)` answers from the resolution
  // that minted the ref. A read against an older resolution is NODE_STALE,
  // which the engine treats as retryable: it re-resolves and reads again.
  let locateRevision = 0;
  const located = new Map<string, SemanticNode>();

  const stale = (ref: NodeRef): BackendError =>
    new BackendError('NODE_STALE', `node ${ref.id} is stale; re-resolve`, { retryable: true });

  const requireLocated = (ref: NodeRef): SemanticNode => {
    if (backend?.locate === undefined) unsupported('locators (screen)');
    const node = located.get(ref.id);
    if (node === undefined || node.ref.revision !== ref.revision) throw stale(ref);
    return node;
  };

  /** A located ref from a superseded resolution never reaches the backend. */
  const rejectSupersededLocate = (ref: NodeRef): void => {
    const known = located.get(ref.id);
    if (known !== undefined && known.ref.revision !== ref.revision) throw stale(ref);
  };

  const screen: SessionScreen = {
    resolve: (expression, operation) =>
      guarded('locate', async () => {
        const nodes = await member(backend, 'locate', 'locators (screen)')(expression, operation);
        locateRevision += 1;
        const locateRev = `l${locateRevision}`;
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
      }),
    async read(ref) {
      return requireLocated(ref);
    },
    perform: (ref, action, operation) =>
      guarded(`the "${action.kind}" action`, async () => {
        // Refs come from locate (the deterministic tier) or from the newest
        // observation (the agent's targeted press/select). Both live in the
        // backend's one id space; the adapter only rejects a located ref it
        // knows to be superseded, and the backend reports NODE_STALE for the rest.
        rejectSupersededLocate(ref);
        if (action.kind === 'dragTo') rejectSupersededLocate(action.target);
        const perform = backend?.perform;
        if (perform !== undefined) {
          await perform.call(backend, ref, action, operation);
          return;
        }
        // Without `perform`, the four actions that are also grammar verbs go
        // through the verbs; everything else is honestly unsupported.
        const verbs = backend?.actions;
        switch (action.kind) {
          case 'tap':
            await member(verbs, 'tap', 'tap')({ ref }, operation);
            return;
          case 'fill':
            await member(verbs, 'type', 'type')({ ref }, action.value, operation);
            return;
          case 'press':
            await member(verbs, 'press', 'press')({ ref }, action.key, operation);
            return;
          case 'selectOption':
            await member(verbs, 'select', 'select')({ ref }, String(action.value), operation);
            return;
          default:
            unsupported(`the "${action.kind}" action`);
        }
      }),
    swipe: call(backend, 'swipe', 'swipe'),
  };

  const app: SessionApp = {
    open: call(backend?.actions, 'navigate', 'navigate'),
    restart: call(backend?.app, 'restart', 'app restart'),
    clearState: call(backend?.app, 'clearState', 'app state clearing'),
    back: call(backend?.actions, 'back', 'back navigation'),
  };

  const artifacts: SessionArtifacts = {
    screenshot: call(backend?.artifacts, 'screenshot', 'screenshots'),
    ...(backend?.artifacts?.startTrace === undefined || backend.artifacts.stopTrace === undefined
      ? {}
      : {
          startTrace: call(backend.artifacts, 'startTrace', 'traces'),
          stopTrace: call(backend.artifacts, 'stopTrace', 'traces'),
        }),
  };

  let ended = false;

  return {
    app,
    screen,
    actions,
    artifacts,
    ...(backend?.state === undefined
      ? {}
      : {
          captureState: call(backend.state, 'capture', 'state capture'),
          restoreState: call(backend.state, 'restore', 'state restore'),
        }),
    ...(backend?.url === undefined ? {} : { url: call(backend, 'url', 'the current URL') }),
    observe: (operation: OperationContext, observeOptions?: ObserveOptions): Promise<Observation> =>
      guarded('observe', async () => {
        const snapshot = await member(backend, 'observe', 'observation')(
          operation,
          observeOptions?.pixels === true ? { pixels: true } : {},
        );
        if (snapshot.viewport !== undefined) viewport = snapshot.viewport;
        revision += 1;
        const minted = `b${revision}`;
        return {
          revision: minted,
          capturedAt: new Date().toISOString(),
          ...(snapshot.pixels === undefined ? {} : { pixels: snapshot.pixels }),
          tree: toTree(snapshot.nodes, minted),
          viewport,
          // The harness redacts observation text downstream for every backend.
          // Pixel completeness is judged downstream too, from the region count
          // against the secure nodes, so a short mask degrades to tree-only
          // input instead of failing the observation here.
          redaction: {
            secureNodeCount: countSecure(snapshot.nodes),
            maskedRegionCount: snapshot.maskedRegionCount ?? 0,
            complete: true,
          },
        };
      }),
    async runtime() {
      return { viewport };
    },
    close: () =>
      // The backend outlives the attempt; only the per-attempt isolation ends
      // here, exactly once. dispose() belongs to the worker.
      guarded('attempt end', async () => {
        if (ended) return;
        ended = true;
        await backend?.endAttempt?.();
      }),
  };
}
