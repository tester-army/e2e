/**
 * The scripted screen behind the fake engine: a mutable semantic tree built
 * once per attempt, whose nodes react to actions with hooks and whose script
 * schedules mutations (`after`) so polling has something to wait for.
 * `locate` is the contract's `resolveExpression` over the tree, `perform`
 * applies plausible in-memory semantics, and a root swipe reveals what
 * `appearsAfterSwipes` hides. No engine plumbing lives here; the fake engine
 * owns one `Scene` per attempt and forwards its calls.
 */

import type { LocatorAction, LocatorActionKind, LocatorExpression, SemanticNode } from '../../src/engine/index.ts';
import { engineFailure, obj, parseKey, resolveExpression } from './engine-runtime.ts';

/** The stable id of the observation root; `perform(root, swipe)` is the viewport swipe. */
export const SCENE_ROOT_ID = 'root';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type StateKey = keyof NonNullable<SemanticNode['states']>;

/** How one action kind on one node fails instead of performing. */
export interface ScriptedFailure {
  readonly code: Parameters<typeof engineFailure>[0];
  readonly message?: string;
}

/** One option a `selectOption` picks from. */
export interface ScriptedOption {
  readonly label: string;
  readonly value: string;
}

/**
 * One node of the scripted tree: a mutable `SemanticNode` addressed by id
 * instead of a ref, plus the script's own knobs. Hooks and scheduled
 * mutations edit these objects in place; the engine reads them live on every
 * locate and observe.
 */
export interface ScriptedNode extends Mutable<Omit<SemanticNode, 'ref' | 'children' | 'states'>> {
  id: string;
  states?: Partial<Record<StateKey, boolean>>;
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
}

/** What a scene can schedule while the attempt runs. */
export interface Stage {
  /** Runs `mutate` once, `ms` after the attempt started; cleared when the attempt ends. */
  after(ms: number, mutate: () => void): void;
}

/** The scripted tree of one attempt and everything the engine does to it. */
export interface Scene {
  /** What the newest observation reports as its location: the last opened URL. */
  readonly location: string;
  /** Cancels every scheduled mutation; the attempt is over. */
  dispose(): void;
  /** `session.open`: the app is open at `url`. */
  open(url: string): void;
  /** `session.restart` and `reset`: the app must be opened again. */
  close(): void;
  /** The observation root over every present node. */
  root(): SemanticNode;
  /** The nodes an expression matches right now, as shallow contract nodes; before `open` it is `INVALID_STATE`. */
  locate(expression: LocatorExpression): SemanticNode[];
  /** One action on the node `id` names: the built-in semantics, then the node's own hook. */
  perform(id: string, action: LocatorAction): void;
  /** `keyboard.type` into the focused field. */
  type(text: string, replace: boolean): void;
  /** `keyboard.press` on the focused field. */
  press(key: string): void;
}

/** Roles whose value the keyboard edits. */
const TYPABLE_ROLES: ReadonlySet<string> = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

/** Builds the scene of one attempt with `build`, which may schedule mutations on the stage it receives. */
export function createScene(build: (stage: Stage) => ScriptedNode[], initialLocation: string): Scene {
  const timers: NodeJS.Timeout[] = [];
  const nodes = build({
    after(ms, mutate) {
      timers.push(setTimeout(mutate, ms));
    },
  });
  let swipes = 0;
  let opened = false;
  let location = initialLocation;

  /** Whether the node is in the tree right now: revealed by enough root swipes. */
  const present = (node: ScriptedNode): boolean => (node.appearsAfterSwipes ?? 0) <= swipes;

  /** Every present node of the scene, in document order. */
  const allNodes = (): ScriptedNode[] => {
    const out: ScriptedNode[] = [];
    const walk = (level: readonly ScriptedNode[]): void => {
      for (const node of level) {
        if (!present(node)) continue;
        out.push(node);
        walk(node.children ?? []);
      }
    };
    walk(nodes);
    return out;
  };

  const findById = (id: string): ScriptedNode | undefined => allNodes().find((node) => node.id === id);

  /** The node as the contract reports it: a fresh copy, the value withheld on a secure field, children only for an observation. */
  const toSemantic = (node: ScriptedNode, deep: boolean): SemanticNode =>
    obj({
      ref: { id: node.id, revision: '' },
      role: node.role,
      name: node.name,
      text: node.text,
      value: node.states?.secure === true ? undefined : node.value,
      testId: node.testId,
      inputPurpose: node.inputPurpose,
      states: node.states === undefined ? undefined : { ...node.states },
      level: node.level,
      attributes: node.attributes === undefined ? undefined : { ...node.attributes },
      rect: node.rect === undefined ? undefined : { ...node.rect },
      children:
        deep && node.children !== undefined
          ? node.children.filter(present).map((child) => toSemantic(child, true))
          : undefined,
    });

  const root = (): SemanticNode => ({
    ref: { id: SCENE_ROOT_ID, revision: '' },
    role: 'group',
    children: nodes.filter(present).map((node) => toSemantic(node, true)),
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
      throw engineFailure('NOT_ACTIONABLE', 'nothing that accepts text has focus');
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

  /** Sets the node's value to the option picked; an option the node does not offer is `NOT_ACTIONABLE`. */
  const selectOption = (node: ScriptedNode, value: Extract<LocatorAction, { kind: 'selectOption' }>['value']): void => {
    const picked = pickOption(node.options ?? [], value);
    if (picked === undefined) {
      throw engineFailure('NOT_ACTIONABLE', `no option matches ${JSON.stringify(value)} on ${node.id}`);
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
      case 'tap':
      case 'doubleTap':
      case 'secondaryTap':
      case 'longPress':
      case 'hover':
      case 'scrollIntoView':
      case 'setInputFiles':
      case 'dragTo':
      case 'swipe':
        return;
    }
  };

  return {
    get location() {
      return location;
    },
    dispose() {
      for (const timer of timers) clearTimeout(timer);
    },
    open(url) {
      opened = true;
      location = url;
    },
    close() {
      opened = false;
    },
    root,
    locate(expression) {
      if (!opened) throw engineFailure('INVALID_STATE', 'no app is open; call app.open() first');
      return resolveExpression(expression, root().children ?? []).map((match) => obj({ ...match, children: undefined }));
    },
    perform(id, action) {
      if (id === SCENE_ROOT_ID) {
        if (action.kind === 'swipe') swipes += 1;
        return;
      }
      const node = findById(id);
      if (node === undefined) throw engineFailure('NODE_STALE', `node ${id} is no longer in the tree`, true);
      if (node.staleOnce === true) {
        node.staleOnce = false;
        node.id = `${node.id}~relocated`;
        throw engineFailure('NODE_STALE', `node ${id} went stale`, true);
      }
      const scripted = node.fail?.[action.kind];
      if (scripted !== undefined) {
        throw engineFailure(scripted.code, scripted.message ?? `${action.kind} on ${node.id} failed with ${scripted.code}`);
      }
      apply(node, action);
      node.on?.(action, node);
    },
    type(text, replace) {
      const node = focused();
      node.value = replace ? text : `${node.value ?? ''}${text}`;
    },
    press(key) {
      applyKey(focused(), key);
    },
  };
}

/** The option a `selectOption` value names: a bare string is a label first, then a value. */
function pickOption(
  options: readonly ScriptedOption[],
  value: Extract<LocatorAction, { kind: 'selectOption' }>['value'],
): ScriptedOption | undefined {
  if (typeof value === 'string') {
    return options.find((option) => option.label === value) ?? options.find((option) => option.value === value);
  }
  if (typeof value.label === 'string') return options.find((option) => option.label === value.label);
  if (typeof value.value === 'string') return options.find((option) => option.value === value.value);
  if (typeof value.index === 'number') return options[value.index];
  return undefined;
}
