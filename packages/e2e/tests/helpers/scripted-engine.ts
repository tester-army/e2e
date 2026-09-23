/**
 * A scripted in-memory engine with a real semantic tree, for deterministic
 * tests of the `screen`/`expect` tier through the real runner: no browser, no
 * device. A script builds the tree once per attempt, reacts to actions with
 * per-node hooks, and schedules mutations (`after`) so polling has something
 * to wait for. `locate` is a real resolver of `LocatorExpression` over the
 * tree, `perform` applies plausible in-memory semantics and records every
 * dispatch, and the session hooks record what the `app` fixture asked for.
 *
 * Runtime classes come from the built package so `instanceof` checks inside
 * the built runner (used by run-project.ts) see the same identities.
 */

import type {
  EngineErrorCode,
  EngineHandle,
  LocatorAction,
  LocatorActionKind,
  LocatorExpression,
  PointerAction,
  PointerActionKind,
  SemanticNode,
  SemanticQuery,
  TextPattern,
  ViewportPoint,
} from '../../src/engine/index.ts';

const builtEngineModule = '../../dist/engine/index.js';
const {
  defineEngine,
  EngineError,
  ENGINE_SPI_VERSION,
  LOCATOR_ACTION_KINDS,
  POINTER_ACTION_KINDS,
  matchesText,
  parseKey,
} = (await import(builtEngineModule)) as typeof import('../../src/engine/index.ts');

/** The app URL the scripted engine declares; every observation reports it as its location. */
export const SCRIPTED_APP_URL = 'http://127.0.0.1:4598';
/** The stable id of the observation root; `perform(root, swipe)` is the viewport swipe. */
export const SCRIPTED_ROOT_ID = 'root';
const VIEWPORT = { width: 1280, height: 720 } as const;

type StateKey = 'checked' | 'disabled' | 'selected' | 'expanded' | 'pressed' | 'focused' | 'hidden' | 'secure';

/** How one action kind on one node fails instead of performing. */
export interface ScriptedFailure {
  readonly code: EngineErrorCode;
  readonly message?: string;
}

/** One option a `selectOption` picks from. */
export interface ScriptedOption {
  readonly label: string;
  readonly value: string;
}

/**
 * One node of the scripted tree: a mutable `SemanticNode` without a ref,
 * plus the script's own knobs. Hooks and scheduled mutations edit these
 * objects in place; the engine reads them live on every locate and observe.
 */
export interface ScriptedNode {
  id: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  testId?: string;
  states?: Partial<Record<StateKey, boolean>>;
  level?: number;
  rect?: { x: number; y: number; width: number; height: number };
  attributes?: Record<string, string>;
  inputPurpose?: SemanticNode['inputPurpose'];
  children?: ScriptedNode[];
  /** Options a `selectOption` picks from, in order. */
  options?: readonly ScriptedOption[];
  /** Root swipes needed before the node enters the tree at all; default 0. */
  appearsAfterSwipes?: number;
  /** Reacts to an action the engine performed on the node, after the built-in semantics ran. */
  on?: (action: LocatorAction, node: ScriptedNode) => void;
  /** Fails the named action kinds instead of performing them. */
  fail?: Partial<Record<LocatorActionKind, ScriptedFailure>>;
  /** The next perform on the node throws a retryable NODE_STALE and gives the node a fresh id. */
  staleOnce?: boolean;
  /** What `setInputFiles` last set. */
  files?: readonly string[];
}

/** What a scene can schedule while the attempt runs. */
export interface Stage {
  /** Runs `mutate` once, `ms` after the attempt started; cleared when the attempt ends. */
  after(ms: number, mutate: () => void): void;
}

export interface ScriptedEngineScript {
  /** Builds the tree for one attempt: the root's children, in document order. */
  scene(stage: Stage): ScriptedNode[];
  /** Action kinds `perform` honors; default every kind. */
  actions?: readonly LocatorActionKind[];
  /** Pointer action kinds `performAt` honors; default every kind. */
  pointerActions?: readonly PointerActionKind[];
  /** Whether the engine declares a keyboard; default true. */
  keyboard?: boolean;
}

export interface RecordedPerform {
  readonly attemptId: string;
  readonly id: string;
  readonly action: LocatorAction;
}

export interface RecordedPointerAction {
  readonly attemptId: string;
  readonly point: ViewportPoint;
  readonly action: PointerAction;
}

export interface RecordedKey {
  readonly attemptId: string;
  readonly kind: 'type' | 'press';
  readonly text: string;
  readonly replace?: boolean;
}

export interface RecordedSessionCall {
  readonly attemptId: string;
  readonly call: string;
}

export interface ScriptedEngineHandle {
  readonly engine: EngineHandle;
  readonly performs: RecordedPerform[];
  readonly pointerActions: RecordedPointerAction[];
  readonly keys: RecordedKey[];
  readonly sessionCalls: RecordedSessionCall[];
  /** Every `perform` of one attempt, in order. */
  performsOf(attemptId: string): RecordedPerform[];
  /** Every `performAt` of one attempt, in order. */
  pointerActionsOf(attemptId: string): RecordedPointerAction[];
  /** Every keyboard call of one attempt, in order. */
  keysOf(attemptId: string): RecordedKey[];
  /** Every session hook call of one attempt, in order. */
  sessionCallsOf(attemptId: string): string[];
}

/** Roles `getByLabel` names, mirroring what a browser's label query can reach. */
const LABELABLE_ROLES: ReadonlySet<string> = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'listbox',
  'button',
  'meter',
  'progressbar',
  'option',
]);

/** Roles whose value the keyboard edits. */
const TYPABLE_ROLES: ReadonlySet<string> = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

interface Attempt {
  readonly attemptId: string;
  readonly scene: ScriptedNode[];
  readonly timers: NodeJS.Timeout[];
  swipes: number;
  opened: boolean;
  location: string;
}

/** A thrown `EngineError` from the built package, so the runner's `instanceof` sees it. */
function failure(code: EngineErrorCode, message: string, retryable = false): InstanceType<typeof EngineError> {
  return new EngineError(code, message, { retryable });
}

/** Creates a branded scripted engine over the script's scene. */
export function createScriptedEngine(script: ScriptedEngineScript): ScriptedEngineHandle {
  const performs: RecordedPerform[] = [];
  const pointerActions: RecordedPointerAction[] = [];
  const keys: RecordedKey[] = [];
  const sessionCalls: RecordedSessionCall[] = [];
  let attempt: Attempt | undefined;

  /** The open attempt; every call outside one is the runner breaking its own lifecycle. */
  const current = (): Attempt => {
    if (attempt === undefined) throw failure('INVALID_STATE', 'no attempt is open');
    return attempt;
  };

  /** Whether the node is in the tree right now: revealed by enough root swipes. */
  const present = (node: ScriptedNode): boolean => (node.appearsAfterSwipes ?? 0) <= current().swipes;

  /** Every present descendant of `nodes`, pre-order, the nodes themselves excluded. */
  const descendants = (nodes: readonly ScriptedNode[]): ScriptedNode[] => {
    const out: ScriptedNode[] = [];
    const walk = (node: ScriptedNode): void => {
      for (const child of node.children ?? []) {
        if (!present(child)) continue;
        out.push(child);
        walk(child);
      }
    };
    for (const node of nodes) walk(node);
    return out;
  };

  /** Every present node of the scene, in document order. */
  const allNodes = (): ScriptedNode[] => descendants([{ id: SCRIPTED_ROOT_ID, children: current().scene }]);

  /** The present node a ref id names, if it is still in the tree. */
  const findById = (id: string): ScriptedNode | undefined => allNodes().find((node) => node.id === id);

  /** The node's own text and its descendants', joined for `hasText`. */
  const subtreeText = (node: ScriptedNode): string =>
    [node, ...descendants([node])].map((entry) => entry.text ?? '').join(' ');

  /** Whether one node satisfies a semantic query: the contract's rules per query kind, hidden nodes never for `role`. */
  const matchesQuery = (node: ScriptedNode, query: SemanticQuery): boolean => {
    const value: TextPattern = query.value;
    switch (query.kind) {
      case 'role': {
        if (node.states?.hidden === true) return false;
        if (value.kind !== 'string' || node.role !== value.value) return false;
        if (query.name !== undefined && !matchesText(node.name ?? '', query.name)) return false;
        for (const [key, required] of Object.entries(query.states ?? {})) {
          if ((node.states?.[key as StateKey] === true) !== required) return false;
        }
        return query.level === undefined || node.level === query.level;
      }
      case 'label':
        return LABELABLE_ROLES.has(node.role ?? '') && matchesText(node.name ?? '', value);
      case 'placeholder': {
        const placeholder = node.attributes?.['placeholder'];
        return placeholder !== undefined && matchesText(placeholder, value);
      }
      case 'text':
        return node.text !== undefined && matchesText(node.text, value);
      case 'displayValue':
        return node.value !== undefined && node.states?.secure !== true && matchesText(node.value, value);
      case 'testId':
        return node.testId !== undefined && matchesText(node.testId, value);
    }
  };

  /** Resolves an expression to the nodes it matches, searching under `within` (the whole tree when absent). */
  const resolve = (expression: LocatorExpression, within: readonly ScriptedNode[] | undefined): ScriptedNode[] => {
    switch (expression.kind) {
      case 'query': {
        const scopes = expression.scope === undefined ? within : resolve(expression.scope, within);
        const candidates = scopes === undefined ? allNodes() : dedupe(descendants(scopes));
        let matches = candidates.filter((node) => matchesQuery(node, expression.query));
        if (expression.query.kind === 'text') {
          // The innermost matching node answers, so a container echoing its child's text counts once.
          matches = matches.filter((node) => !descendants([node]).some((inner) => matches.includes(inner)));
        }
        if (expression.query.visible === true) matches = matches.filter((node) => node.states?.hidden !== true);
        return matches;
      }
      case 'filter': {
        const { hasText, has } = expression;
        return resolve(expression.source, within).filter(
          (node) =>
            (hasText === undefined || matchesText(subtreeText(node), hasText)) &&
            (has === undefined || resolve(has, [node]).length > 0),
        );
      }
      case 'index': {
        const source = resolve(expression.source, within);
        const index =
          expression.index === 'first' ? 0 : expression.index === 'last' ? source.length - 1 : expression.index;
        const picked = source[index];
        return picked === undefined ? [] : [picked];
      }
      case 'selector': {
        const node = findById(expression.selector);
        if (node === undefined) {
          throw failure('UNSUPPORTED_CAPABILITY', `selector ${JSON.stringify(expression.selector)} is not a node id`);
        }
        return [node];
      }
      case 'frame':
        throw failure('FRAME_NOT_FOUND', `no frame matches ${JSON.stringify(expression.selector)}`);
    }
  };

  /** The node as the contract reports it: a fresh copy, the value withheld on a secure field, children only for an observation. */
  const toSemantic = (node: ScriptedNode, deep: boolean): SemanticNode => ({
    ref: { id: node.id, revision: '' },
    ...(node.role === undefined ? {} : { role: node.role }),
    ...(node.name === undefined ? {} : { name: node.name }),
    ...(node.text === undefined ? {} : { text: node.text }),
    ...(node.value === undefined || node.states?.secure === true ? {} : { value: node.value }),
    ...(node.testId === undefined ? {} : { testId: node.testId }),
    ...(node.inputPurpose === undefined ? {} : { inputPurpose: node.inputPurpose }),
    ...(node.states === undefined ? {} : { states: { ...node.states } }),
    ...(node.level === undefined ? {} : { level: node.level }),
    ...(node.attributes === undefined ? {} : { attributes: { ...node.attributes } }),
    ...(node.rect === undefined ? {} : { rect: { ...node.rect } }),
    ...(deep && node.children !== undefined
      ? { children: node.children.filter(present).map((child) => toSemantic(child, true)) }
      : {}),
  });

  /** Moves the single focused state onto `target`. */
  const focus = (target: ScriptedNode): void => {
    for (const node of allNodes()) {
      if (node.states?.focused === true) node.states.focused = false;
    }
    target.states = { ...target.states, focused: true };
  };

  /** The focused node the keyboard types into; nothing typable focused is `NOT_ACTIONABLE`, as the contract asks. */
  const focused = (): ScriptedNode => {
    const node = allNodes().find((entry) => entry.states?.focused === true);
    if (node === undefined || !TYPABLE_ROLES.has(node.role ?? '')) {
      throw failure('NOT_ACTIONABLE', 'nothing that accepts text has focus');
    }
    return node;
  };

  /** Applies one key of the contract grammar to a node's value the way a field would. */
  const applyKey = (node: ScriptedNode, key: string): void => {
    const parsed = parseKey(key);
    if (parsed === undefined || !TYPABLE_ROLES.has(node.role ?? '')) return;
    const value = node.value ?? '';
    if (parsed.key.kind === 'named') {
      if (parsed.key.name === 'Backspace') node.value = value.slice(0, -1);
      return;
    }
    if (parsed.modifiers.length === 0) node.value = value + parsed.key.char;
  };

  /** The option a `selectOption` value names: a bare string is a label first, then a value. */
  const pickOption = (
    options: readonly ScriptedOption[],
    value: Extract<LocatorAction, { kind: 'selectOption' }>['value'],
  ): ScriptedOption | undefined => {
    if (typeof value === 'string') {
      return options.find((option) => option.label === value) ?? options.find((option) => option.value === value);
    }
    if (typeof value.label === 'string') return options.find((option) => option.label === value.label);
    if (typeof value.value === 'string') return options.find((option) => option.value === value.value);
    if (typeof value.index === 'number') return options[value.index];
    return undefined;
  };

  /** Sets the node's value to the option picked; an option the node does not offer is `NOT_ACTIONABLE`. */
  const selectOption = (node: ScriptedNode, value: Extract<LocatorAction, { kind: 'selectOption' }>['value']): void => {
    const picked = pickOption(node.options ?? [], value);
    if (picked === undefined) {
      throw failure('NOT_ACTIONABLE', `no option matches ${JSON.stringify(value)} on ${node.id}`);
    }
    node.value = picked.value;
  };

  /** The built-in in-memory semantics of one action; the pointer-like kinds leave the tree to the node's hook. */
  const apply = (node: ScriptedNode, action: LocatorAction): void => {
    switch (action.kind) {
      case 'fill':
        node.value = action.value;
        return;
      case 'clear':
        node.value = '';
        return;
      case 'check':
        node.states = { ...node.states, checked: true };
        return;
      case 'uncheck':
        node.states = { ...node.states, checked: false };
        return;
      case 'focus':
        focus(node);
        return;
      case 'press':
        applyKey(node, action.key);
        return;
      case 'selectOption':
        selectOption(node, action.value);
        return;
      case 'setInputFiles':
        node.files = action.paths;
        return;
      case 'tap':
      case 'doubleTap':
      case 'secondaryTap':
      case 'longPress':
      case 'hover':
      case 'scrollIntoView':
      case 'dragTo':
      case 'swipe':
        return;
    }
  };

  const engine = defineEngine({
    name: 'scripted',
    version: '1.0.0',
    spiVersion: ENGINE_SPI_VERSION,
    async startAttempt(context) {
      const timers: NodeJS.Timeout[] = [];
      const stage: Stage = {
        after(ms, mutate) {
          timers.push(setTimeout(mutate, ms));
        },
      };
      attempt = {
        attemptId: context.attemptId,
        scene: script.scene(stage),
        timers,
        swipes: 0,
        opened: false,
        location: `${SCRIPTED_APP_URL}/`,
      };
    },
    async endAttempt() {
      for (const timer of attempt?.timers ?? []) clearTimeout(timer);
      attempt = undefined;
    },
    async observe() {
      const { scene, location } = current();
      return {
        location,
        root: {
          ref: { id: SCRIPTED_ROOT_ID, revision: '' },
          role: 'group',
          children: scene.filter(present).map((node) => toSemantic(node, true)),
        },
        viewport: VIEWPORT,
      };
    },
    async locate(expression) {
      if (!current().opened) throw failure('INVALID_STATE', 'no app is open; call app.open() first');
      return resolve(expression, undefined).map((node) => toSemantic(node, false));
    },
    actions: script.actions ?? LOCATOR_ACTION_KINDS,
    async perform(ref, action, operation) {
      performs.push({ attemptId: operation.attemptId, id: ref.id, action });
      const state = current();
      if (ref.id === SCRIPTED_ROOT_ID) {
        if (action.kind === 'swipe') state.swipes += 1;
        return;
      }
      const node = findById(ref.id);
      if (node === undefined) throw failure('NODE_STALE', `node ${ref.id} is no longer in the tree`, true);
      if (node.staleOnce === true) {
        node.staleOnce = false;
        node.id = `${node.id}~relocated`;
        throw failure('NODE_STALE', `node ${ref.id} went stale`, true);
      }
      const scripted = node.fail?.[action.kind];
      if (scripted !== undefined) {
        throw failure(scripted.code, scripted.message ?? `${action.kind} on ${node.id} failed with ${scripted.code}`);
      }
      apply(node, action);
      node.on?.(action, node);
    },
    pointerActions: script.pointerActions ?? POINTER_ACTION_KINDS,
    async performAt(point, action, operation) {
      pointerActions.push({ attemptId: operation.attemptId, point, action });
    },
    ...(script.keyboard === false
      ? {}
      : {
          keyboard: {
            async type(text, options, operation) {
              keys.push({ attemptId: operation.attemptId, kind: 'type', text, replace: options.replace });
              const node = focused();
              node.value = options.replace ? text : `${node.value ?? ''}${text}`;
            },
            async press(key, operation) {
              keys.push({ attemptId: operation.attemptId, kind: 'press', text: key });
              applyKey(focused(), key);
            },
          },
        }),
    app: { url: SCRIPTED_APP_URL },
    session: {
      async open(url, operation) {
        sessionCalls.push({ attemptId: operation.attemptId, call: `open ${url}` });
        const state = current();
        state.opened = true;
        state.location = url;
      },
      async back(operation) {
        sessionCalls.push({ attemptId: operation.attemptId, call: 'back' });
      },
      async restart(operation) {
        sessionCalls.push({ attemptId: operation.attemptId, call: 'restart' });
        current().opened = false;
      },
      async reset(operation) {
        sessionCalls.push({ attemptId: operation.attemptId, call: 'reset' });
        current().opened = false;
      },
    },
  });

  return {
    engine,
    performs,
    pointerActions,
    keys,
    sessionCalls,
    performsOf: (attemptId) => performs.filter((entry) => entry.attemptId === attemptId),
    pointerActionsOf: (attemptId) => pointerActions.filter((entry) => entry.attemptId === attemptId),
    keysOf: (attemptId) => keys.filter((entry) => entry.attemptId === attemptId),
    sessionCallsOf: (attemptId) =>
      sessionCalls.filter((entry) => entry.attemptId === attemptId).map((entry) => entry.call),
  };
}

/** The nodes once each, in first-seen order: two scopes can share a descendant. */
function dedupe(nodes: readonly ScriptedNode[]): ScriptedNode[] {
  return [...new Set(nodes)];
}
