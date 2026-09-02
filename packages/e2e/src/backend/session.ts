/**
 * The backend-to-session adapter (RFC0002). A backend target has no driver;
 * this adapter satisfies the internal `DriverSession` shape over the backend
 * contract instead, so the agent tier, the judgment tier, the trace cache,
 * and the fixture graph run unchanged. Every capability the backend does not
 * declare fails loud with `UNSUPPORTED_CAPABILITY` at the moment of use —
 * the graded-degradation rule, not a silent no-op.
 */

import type {
  DriverAgentActions,
  DriverApp,
  DriverArtifacts,
  DriverScreen,
  DriverSession,
  Observation,
  OperationContext,
  SemanticNode,
} from '../driver/index.ts';
import { ConfigurationError } from '../internal/errors.ts';
import type { BackendHandle } from './index.ts';

export interface BackendSessionOptions {
  readonly backend: BackendHandle | undefined;
  readonly targetName: string;
  /** Base href for `app.open()` with no path. */
  readonly baseHref: string;
}

function unsupported(targetName: string, what: string): never {
  throw new ConfigurationError(
    'UNSUPPORTED_CAPABILITY',
    `target "${targetName}" has no backend capability for ${what}`,
  );
}

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
 * Builds one session over a backend. One adapter per attempt; revisions are
 * minted per adapter, so refs can never leak across attempts.
 */
export function createBackendSession(options: BackendSessionOptions): DriverSession {
  const { backend, targetName } = options;
  let revision = 0;
  let viewport = { width: 1, height: 1, scale: 1 };

  const actions: DriverAgentActions = {
    async tap(target, operation) {
      const tap = backend?.actions?.tap ?? unsupported(targetName, 'tap');
      await tap.call(backend?.actions, target, operation);
    },
    async type(target, value, _sensitive, operation) {
      const type = backend?.actions?.type ?? unsupported(targetName, 'type');
      await type.call(backend?.actions, target, value, operation);
    },
    async scroll(direction, scrollOptions, operation) {
      const scroll = backend?.actions?.scroll ?? unsupported(targetName, 'scroll');
      await scroll.call(
        backend?.actions,
        direction,
        scrollOptions.target === undefined ? undefined : { ref: scrollOptions.target },
        operation,
      );
    },
    async press() {
      // The grammar's global key press has no backend verb; targeted presses
      // route through screen.perform below.
      unsupported(targetName, 'press');
    },
  };

  const screen: DriverScreen = {
    async resolve() {
      unsupported(targetName, 'locators (screen)');
    },
    async read() {
      unsupported(targetName, 'locators (screen)');
    },
    async perform(ref, action, operation) {
      if (action.kind === 'press') {
        const press = backend?.actions?.press ?? unsupported(targetName, 'press');
        await press.call(backend?.actions, { ref }, action.key, operation);
        return;
      }
      if (action.kind === 'selectOption') {
        const select = backend?.actions?.select ?? unsupported(targetName, 'select');
        await select.call(backend?.actions, { ref }, String(action.value), operation);
        return;
      }
      unsupported(targetName, `the "${action.kind}" action`);
    },
    async swipe() {
      unsupported(targetName, 'swipe');
    },
  };

  const app: DriverApp = {
    async open(path, operation) {
      const navigate = backend?.actions?.navigate ?? unsupported(targetName, 'navigate');
      await navigate.call(backend?.actions, path ?? options.baseHref, operation);
    },
    async restart() {
      unsupported(targetName, 'app restart');
    },
    async clearState() {
      unsupported(targetName, 'app state clearing');
    },
    async back() {
      unsupported(targetName, 'back navigation');
    },
    async deepLink(url, operation) {
      const navigate = backend?.actions?.navigate ?? unsupported(targetName, 'navigate');
      await navigate.call(backend?.actions, url, operation);
    },
  };

  const artifacts: DriverArtifacts = {
    async screenshot() {
      unsupported(targetName, 'screenshots');
    },
  };

  return {
    app,
    screen,
    actions,
    artifacts,
    async observe(operation: OperationContext): Promise<Observation> {
      const observe = backend?.observe ?? unsupported(targetName, 'observation');
      const snapshot = await observe.call(backend, operation);
      if (snapshot.viewport !== undefined) viewport = snapshot.viewport;
      revision += 1;
      const minted = `b${revision}`;
      return {
        revision: minted,
        capturedAt: new Date().toISOString(),
        tree: toTree(snapshot.nodes, minted),
        viewport,
        // The harness redacts observation text downstream for every backend;
        // the completeness gate is about masked pixels, which a backend
        // observation never carries.
        redaction: {
          secureNodeCount: countSecure(snapshot.nodes),
          maskedRegionCount: 0,
          complete: true,
        },
      };
    },
    async runtime() {
      return { viewport };
    },
    async close() {
      // The backend outlives the attempt; dispose() belongs to the worker.
    },
  };
}
