/**
 * The scripted engine: the fake engine configured over a scripted screen,
 * for deterministic tests of the `screen`/`expect` tier through the real
 * runner with no browser or device. Every capability the tier can reach is
 * declared unless the script narrows it, and `scene` is the reference screen
 * the deterministic-tier suites share.
 */

import type { LocatorActionKind, PointerActionKind } from '../../src/engine/index.ts';
import { LOCATOR_ACTION_KINDS, POINTER_ACTION_KINDS } from './engine-runtime.ts';
import { createFakeEngine, type FakeEngineHandle } from './fake-engine.ts';
import type { ScriptedNode, Stage } from './scripted-scene.ts';

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

/** The fake engine over the script's scene, with every capability of the tier unless the script narrows one. */
export function createScriptedEngine(script: ScriptedEngineScript): FakeEngineHandle {
  return createFakeEngine({
    scene: script.scene,
    actions: script.actions ?? LOCATOR_ACTION_KINDS,
    pointerActions: script.pointerActions ?? POINTER_ACTION_KINDS,
    keyboard: script.keyboard ?? true,
    navigation: true,
  });
}

/**
 * The reference screen: form controls, toggles, a list with nested
 * checkboxes, hidden twins, echoed text, and the nodes that move while an
 * attempt runs (a late arrival, a growing list, a flipping state).
 */
export function scene(stage: Stage): ScriptedNode[] {
  const counter: ScriptedNode = { id: 'counter', role: 'status', name: 'Count', text: '0' };
  const lateArrival: ScriptedNode = { id: 'late', role: 'button', name: 'Late arrival', states: { hidden: true } };
  const loading: ScriptedNode = { id: 'loading', role: 'status', name: 'Loading', text: 'Loading' };
  const ticker: ScriptedNode = { id: 'ticker', role: 'status', name: 'Ticker', text: 'tick' };
  const progress: ScriptedNode = { id: 'progress', role: 'spinbutton', name: 'Progress', value: '10' };
  const save: ScriptedNode = { id: 'save', role: 'menuitem', name: 'Save', states: { disabled: true } };
  const growing: ScriptedNode = {
    id: 'growing',
    role: 'list',
    name: 'Growing',
    children: [{ id: 'grow-1', role: 'listitem', text: 'One' }],
  };
  // The clocks start from a tap in the body, not from the attempt launch, so
  // a slow worker cannot land the mutation before the assertion begins.
  const reveal: ScriptedNode = {
    id: 'reveal',
    role: 'button',
    name: 'Reveal',
    on(action) {
      if (action.kind !== 'tap') return;
      stage.after(300, () => {
        lateArrival.states = { hidden: false };
        loading.states = { hidden: true };
      });
    },
  };
  const advance: ScriptedNode = {
    id: 'advance',
    role: 'button',
    name: 'Advance',
    on(action) {
      if (action.kind !== 'tap') return;
      stage.after(250, () => {
        ticker.text = 'tock';
        progress.value = '100';
        save.states = { disabled: false };
      });
    },
  };
  const loadMore: ScriptedNode = {
    id: 'load-more',
    role: 'button',
    name: 'Load more',
    on(action) {
      if (action.kind !== 'tap') return;
      stage.after(200, () => growing.children?.push({ id: 'grow-2', role: 'listitem', text: 'Two' }));
      stage.after(400, () => growing.children?.push({ id: 'grow-3', role: 'listitem', text: 'Three' }));
    },
  };

  const todo = (index: number, text: string, done: boolean): ScriptedNode => ({
    id: `todo-${index}`,
    role: 'listitem',
    testId: 'todo',
    text,
    children: [{ id: `todo-${index}-done`, role: 'checkbox', name: 'Done', states: { checked: done } }],
  });

  return [
    { id: 'h1', role: 'heading', name: 'Dashboard', text: 'Dashboard', level: 1 },
    { id: 'h2', role: 'heading', name: 'Recent', text: 'Recent', level: 2 },
    {
      id: 'email',
      role: 'textbox',
      name: 'Email',
      value: '',
      attributes: { placeholder: 'you@example.test', autocomplete: 'email' },
      rect: { x: 10, y: 100, width: 200, height: 30 },
    },
    { id: 'notes', role: 'textbox', name: 'Notes', value: 'line1\n\nline2  ' },
    {
      id: 'password',
      role: 'textbox',
      name: 'Password',
      value: 'hunter2',
      inputPurpose: 'password',
      states: { secure: true },
      rect: { x: 10, y: 140, width: 200, height: 30 },
    },
    { id: 'search', role: 'searchbox', name: 'Search', value: 'hello-value' },
    { id: 'notify', role: 'checkbox', name: 'Notifications', states: { checked: false } },
    { id: 'dark', role: 'switch', name: 'Dark mode', states: { checked: true } },
    {
      id: 'plan',
      role: 'combobox',
      name: 'Plan',
      value: 'free',
      options: [
        { label: 'Free', value: 'free' },
        { label: 'Pro', value: 'pro' },
        { label: 'Team', value: 'team' },
      ],
    },
    { id: 'submit', role: 'button', name: 'Submit', text: 'Submit', rect: { x: 20, y: 200, width: 100, height: 40 } },
    { id: 'disabled', role: 'button', name: 'Disabled action', states: { disabled: true } },
    {
      id: 'menu',
      role: 'button',
      name: 'Menu',
      states: { expanded: false },
      on(action, node) {
        if (action.kind === 'tap') node.states = { ...node.states, expanded: node.states?.expanded !== true };
      },
    },
    {
      id: 'bold',
      role: 'button',
      name: 'Bold',
      states: { pressed: false },
      on(action, node) {
        if (action.kind === 'tap') node.states = { ...node.states, pressed: true };
      },
    },
    {
      id: 'increment',
      role: 'button',
      name: 'Increment',
      on(action) {
        if (action.kind === 'tap') counter.text = String(Number(counter.text) + 1);
      },
    },
    counter,
    { id: 'dup-1', role: 'button', name: 'Duplicated', text: 'Duplicated' },
    { id: 'dup-2', role: 'button', name: 'Duplicated', text: 'Duplicated' },
    { id: 'ready-hidden', role: 'status', name: 'Ready state', text: 'Ready', states: { hidden: true } },
    { id: 'ready-visible', role: 'status', name: 'Ready state', text: 'Ready' },
    { id: 'hidden-text', text: 'Hidden content', states: { hidden: true } },
    {
      id: 'todos',
      role: 'list',
      name: 'Todos',
      testId: 'todos',
      children: [todo(1, 'Write spec', false), todo(2, 'Ship runner', true), todo(3, 'Release', false)],
    },
    {
      id: 'tabs',
      role: 'tablist',
      name: 'Filter',
      children: [
        { id: 'tab-all', role: 'tab', name: 'All', text: 'All', states: { selected: true } },
        { id: 'tab-open', role: 'tab', name: 'Open', text: 'Open', states: { selected: false } },
      ],
    },
    {
      id: 'card',
      role: 'region',
      name: 'Card',
      testId: 'card',
      text: 'Card body',
      attributes: { class: 'card active', 'data-state': 'open' },
    },
    { id: 'map', role: 'image', name: 'Map', rect: { x: 100, y: 300, width: 400, height: 200 } },
    { id: 'drag', role: 'listitem', text: 'Draggable', testId: 'drag' },
    { id: 'drop', role: 'region', name: 'Dropzone', testId: 'drop' },
    { id: 'upload', role: 'button', name: 'Attachment' },
    { id: 'feed', role: 'list', name: 'Feed' },
    { id: 'focus-target', role: 'textbox', name: 'Focus target', value: '' },
    { id: 'city', role: 'textbox', name: 'City', value: '' },
    { id: 'echo', role: 'group', text: 'Echoed', children: [{ id: 'echo-inner', text: 'Echoed' }] },
    reveal,
    advance,
    loadMore,
    lateArrival,
    loading,
    ticker,
    progress,
    save,
    growing,
    { id: 'below', role: 'button', name: 'Below the fold', appearsAfterSwipes: 2 },
    { id: 'stale', role: 'button', name: 'Stale', staleOnce: true },
    {
      id: 'flaky',
      role: 'button',
      name: 'Flaky',
      fail: { tap: { code: 'NOT_ACTIONABLE', message: 'covered by an overlay' } },
    },
    {
      id: 'commit',
      role: 'button',
      name: 'Commit',
      fail: { tap: { code: 'ACTION_MAY_HAVE_COMMITTED', message: 'the tap may have landed' } },
    },
  ];
}
