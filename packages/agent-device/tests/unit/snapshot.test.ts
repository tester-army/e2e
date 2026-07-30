import { describe, expect, it } from 'vitest';
import { OBSERVED_NAME_LIMIT, OBSERVED_TEXT_LIMIT } from 'e2e/driver';
import {
  clientRef,
  controlOf,
  nearestScrollContainer,
  projectSnapshot,
  queryPlaceholder,
  toObservationTree,
  toSemanticNode,
} from '../../src/snapshot.ts';
import { buildSnapshot, loginSnapshot, SCREEN } from '../helpers/snapshot.ts';

describe('projectSnapshot', () => {
  it('rebuilds the tree from the flat parentIndex wire shape', () => {
    const projected = projectSnapshot(loginSnapshot(), 'ios', 'r1');
    expect(projected.roots).toHaveLength(1);
    const root = projected.roots[0]!;
    expect(root.role).toBe('application');
    const form = root.children[0]!;
    expect(form.children.map((node) => node.role)).toEqual([
      'paragraph',
      'textbox',
      'textbox',
      'button',
    ]);
    expect(form.children[0]!.parent).toBe(form);
  });

  it('keeps platform document order and indexes every ref', () => {
    const projected = projectSnapshot(loginSnapshot(), 'ios', 'r1');
    expect(projected.ordered.map((node) => node.ref)).toEqual([
      'e1',
      'e2',
      'e3',
      'e4',
      'e5',
      'e6',
    ]);
    expect(projected.byRef.get('e6')?.label).toBe('Continue');
  });

  it('includes off-screen nodes rather than dropping them', () => {
    const snapshot = buildSnapshot([
      {
        type: 'XCUIElementTypeScrollView',
        children: [
          { type: 'XCUIElementTypeButton', label: 'Visible' },
          { type: 'XCUIElementTypeButton', label: 'Below', visibleToUser: false },
        ],
      },
    ]);
    const projected = projectSnapshot(snapshot, 'ios', 'r1');
    expect(projected.ordered).toHaveLength(3);
    expect(projected.byRef.get('e3')?.visible).toBe(false);
  });

  it('masks a secure field value and marks the observation tainted', () => {
    const projected = projectSnapshot(loginSnapshot(), 'ios', 'r1');
    const password = projected.byRef.get('e5')!;
    expect(password.secure).toBe(true);
    expect(password.value).toBeUndefined();
    expect(password.inputPurpose).toBe('password');
    expect(projected.secureVisible).toBe(true);
  });

  it('reports no secure taint when a secure field is not visible', () => {
    const snapshot = buildSnapshot([
      { type: 'XCUIElementTypeSecureTextField', label: 'Password', visibleToUser: false },
    ]);
    expect(projectSnapshot(snapshot, 'ios', 'r1').secureVisible).toBe(false);
  });

  it('derives a one-time-code purpose ahead of password', () => {
    const snapshot = buildSnapshot([
      {
        type: 'XCUIElementTypeTextField',
        label: 'Code',
        presentationHints: ['oneTimeCode'],
      },
    ]);
    const node = projectSnapshot(snapshot, 'ios', 'r1').byRef.get('e1')!;
    expect(node.inputPurpose).toBe('one-time-code');
  });

  it('derives visibility from geometry, because iOS omits a visibility flag', () => {
    // Real iOS snapshots carry no visibleToUser and report hittable: false for
    // plainly tappable controls, so neither flag can gate visibility.
    const snapshot = buildSnapshot([
      { type: 'XCUIElementTypeButton', label: 'Tappable', hittable: false },
      { type: 'XCUIElementTypeButton', label: 'No geometry', rect: { x: 0, y: 0, width: 0, height: 0 } },
    ]);
    const projected = projectSnapshot(snapshot, 'ios', 'r1');
    expect(projected.byRef.get('e1')?.visible).toBe(true);
    expect(projected.byRef.get('e2')?.visible).toBe(false);
  });

  it('reports the viewport and whether a node sits inside it', () => {
    const snapshot = buildSnapshot([
      {
        type: 'XCUIElementTypeApplication',
        rect: { ...SCREEN },
        children: [
          {
            // A scroll container: its content extends past its own frame.
            type: 'XCUIElementTypeTable',
            rect: { ...SCREEN },
            children: [
              { type: 'XCUIElementTypeButton', label: 'On screen', rect: { x: 0, y: 100, width: 402, height: 44 } },
              { type: 'XCUIElementTypeButton', label: 'Below fold', rect: { x: 0, y: 2000, width: 402, height: 44 } },
            ],
          },
        ],
      },
    ]);
    const projected = projectSnapshot(snapshot, 'ios', 'r1');
    expect(projected.viewport).toEqual({ width: 402, height: 874 });
    const onScreen = projected.byRef.get('e3')!;
    const belowFold = projected.byRef.get('e4')!;
    // Scroll position does not affect visibility, matching web semantics.
    expect(belowFold.visible).toBe(true);
    expect(onScreen.withinViewport).toBe(true);
    expect(belowFold.withinViewport).toBe(false);
  });

  it('canonicalizes a node id by dropping the backend sigil', () => {
    // A node id is printed into a model observation as `#id`, so `#@e1` reads
    // as two sigils: models drop the `@` and the answer is then rejected.
    const snapshot = buildSnapshot([{ type: 'XCUIElementTypeButton', label: 'Go' }]);
    for (const wire of ['e1', '@e1']) {
      const node = { ...snapshot.nodes[0]!, ref: wire };
      const projected = projectSnapshot({ ...snapshot, nodes: [node] }, 'ios', 'r1');
      expect(projected.ordered[0]?.ref).toBe('e1');
      expect(projected.byRef.has('e1')).toBe(true);
      // The backend still receives the spelling its commands require.
      expect(clientRef(projected.ordered[0]!)).toBe('@e1');
    }
  });

  it('rejects the stale geometry iOS gives a scrolled-away row', () => {
    // Verbatim shape from an iOS Accessibility list: the Cell sits below the
    // fold at y=1057 inside a Table whose frame is the visible screen, while
    // its own descendants claim y=116 or a zero rect. Believing those makes an
    // unreachable row look reachable and hands its label to a node that cannot
    // be seen or tapped.
    const snapshot = buildSnapshot([
      {
        type: 'XCUIElementTypeApplication',
        rect: { ...SCREEN },
        children: [
          {
            type: 'XCUIElementTypeTable',
            label: 'Accessibility',
            rect: { ...SCREEN },
            children: [
              {
                type: 'XCUIElementTypeCell',
                label: 'Keyboards & Typing',
                rect: { x: 20, y: 1057, width: 362, height: 53 },
                children: [
                  {
                    type: 'XCUIElementTypeOther',
                    label: 'Keyboards & Typing',
                    rect: { x: 0, y: 116, width: 332, height: 53 },
                    children: [
                      {
                        type: 'XCUIElementTypeStaticText',
                        label: 'Keyboards & Typing',
                        rect: { x: 0, y: 0, width: 0, height: 0 },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const projected = projectSnapshot(snapshot, 'ios', 'r1');

    // The scroll container imposes no bounds, so the row keeps its geometry.
    const cell = projected.byRef.get('e3')!;
    expect(cell.rect?.y).toBe(1057);
    expect(cell.visible).toBe(true);
    expect(cell.withinViewport).toBe(false);

    // The stale and zeroed descendants have no usable geometry at all.
    expect(projected.byRef.get('e4')?.rect).toBeUndefined();
    expect(projected.byRef.get('e5')?.rect).toBeUndefined();

    // So the row itself owns the label and is what a text query resolves to.
    expect(cell.ownsLabel).toBe(true);
    expect(projected.byRef.get('e4')?.ownsLabel).toBe(false);
  });

  it('marks a node the backend reports as covered', () => {
    const snapshot = buildSnapshot([{ type: 'XCUIElementTypeButton', label: 'Behind sheet' }]);
    const covered = { ...snapshot.nodes[0]!, interactionBlocked: 'covered' as const };
    const projected = projectSnapshot({ ...snapshot, nodes: [covered] }, 'ios', 'r1');
    expect(projected.byRef.get('e1')?.covered).toBe(true);
  });

  it('treats an unresolvable parent reference as a root', () => {
    const snapshot = buildSnapshot([{ type: 'XCUIElementTypeButton', label: 'Orphan' }]);
    const detached = { ...snapshot.nodes[0]!, parentIndex: 99 };
    const projected = projectSnapshot({ ...snapshot, nodes: [detached] }, 'ios', 'r1');
    expect(projected.roots).toHaveLength(1);
  });
});

describe('queryPlaceholder', () => {
  it('matches an empty text field label and nothing once it holds a value', () => {
    const projected = projectSnapshot(loginSnapshot(), 'ios', 'r1');
    expect(queryPlaceholder(projected.byRef.get('e4')!)).toBe('Email');
    const filled = buildSnapshot([
      { type: 'XCUIElementTypeTextField', label: 'Email', value: 'a@b.c' },
    ]);
    const node = projectSnapshot(filled, 'ios', 'r1').byRef.get('e1')!;
    expect(queryPlaceholder(node)).toBeUndefined();
  });

  it('never matches a non-input role', () => {
    const projected = projectSnapshot(loginSnapshot(), 'ios', 'r1');
    expect(queryPlaceholder(projected.byRef.get('e6')!)).toBeUndefined();
  });
});

describe('toSemanticNode', () => {
  it('binds every ref to the observation revision', () => {
    const projected = projectSnapshot(loginSnapshot(), 'ios', 'rev-7');
    const node = toSemanticNode(projected.byRef.get('e6')!, 'rev-7', { bounded: true });
    expect(node.ref).toEqual({ id: 'e6', revision: 'rev-7' });
  });

  it('exposes the identifier as the testId attribute', () => {
    const projected = projectSnapshot(loginSnapshot(), 'ios', 'r1');
    const node = toSemanticNode(projected.byRef.get('e4')!, 'r1', { bounded: true });
    expect(node.attributes).toEqual({ testId: 'email' });
  });

  it('bounds observation fields but leaves a direct read whole', () => {
    const long = 'x'.repeat(OBSERVED_TEXT_LIMIT + 50);
    const snapshot = buildSnapshot([
      { type: 'XCUIElementTypeStaticText', label: 'y'.repeat(OBSERVED_NAME_LIMIT + 10), value: long },
    ]);
    const node = projectSnapshot(snapshot, 'ios', 'r1').byRef.get('e1')!;
    const bounded = toSemanticNode(node, 'r1', { bounded: true });
    expect(bounded.name).toHaveLength(OBSERVED_NAME_LIMIT);
    expect(bounded.value).toHaveLength(OBSERVED_TEXT_LIMIT);
    const whole = toSemanticNode(node, 'r1', { bounded: false });
    expect(whole.value).toHaveLength(long.length);
  });

  it('omits an unavailable state instead of guessing it', () => {
    const snapshot = buildSnapshot([{ type: 'XCUIElementTypeButton', label: 'Go' }]);
    const node = projectSnapshot(snapshot, 'ios', 'r1').byRef.get('e1')!;
    expect(toSemanticNode(node, 'r1', { bounded: true }).states).toBeUndefined();
  });

  it('reports disabled, hidden, secure, and derived checked states', () => {
    const snapshot = buildSnapshot([
      { type: 'XCUIElementTypeSwitch', label: 'Wi-Fi', value: '1', enabled: false, visibleToUser: false },
    ]);
    const node = projectSnapshot(snapshot, 'ios', 'r1').byRef.get('e1')!;
    expect(toSemanticNode(node, 'r1', { bounded: true }).states).toEqual({
      disabled: true,
      hidden: true,
      checked: true,
    });
  });
});

describe('toObservationTree', () => {
  it('returns the single root as-is', () => {
    const tree = toObservationTree(projectSnapshot(loginSnapshot(), 'ios', 'r1'));
    expect(tree.ref.id).toBe('e1');
  });

  it('wraps several window roots in one synthetic root', () => {
    const snapshot = buildSnapshot([
      { type: 'XCUIElementTypeWindow', label: 'App' },
      { type: 'XCUIElementTypeWindow', label: 'Keyboard' },
    ]);
    const tree = toObservationTree(projectSnapshot(snapshot, 'ios', 'r1'));
    expect(tree.ref.id).toBe('root');
    expect(tree.children).toHaveLength(2);
  });
});

describe('toObservationTree pruning', () => {
  it('collapses layout wrappers that only repeat a descendant label', () => {
    // A real Settings row nests four generic wrappers that each repeat the
    // row's label; sending them costs tokens and asks the model to choose
    // between identical candidates.
    const snapshot = buildSnapshot([
      {
        type: 'XCUIElementTypeApplication',
        children: [
          {
            type: 'XCUIElementTypeCell',
            label: 'General',
            children: [
              {
                type: 'XCUIElementTypeOther',
                label: 'General',
                children: [
                  {
                    type: 'XCUIElementTypeOther',
                    label: 'General',
                    children: [
                      {
                        type: 'XCUIElementTypeButton',
                        label: 'General',
                        children: [{ type: 'XCUIElementTypeStaticText', label: 'General' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const tree = toObservationTree(projectSnapshot(snapshot, 'ios', 'r1'));
    const roles: string[] = [];
    const walk = (node: { role?: string; children?: readonly unknown[] }) => {
      if (node.role !== undefined) roles.push(node.role);
      for (const child of node.children ?? []) walk(child as typeof node);
    };
    walk(tree);
    // The wrappers and the duplicate text are gone. The row and the control
    // inside it remain: a role query addresses the control, and a container
    // repeating its label must not make it disappear.
    expect(roles).toEqual(['listitem', 'button']);
  });

  it('keeps a wrapper that carries its own label or an identifier', () => {
    const snapshot = buildSnapshot([
      {
        type: 'XCUIElementTypeApplication',
        children: [
          { type: 'XCUIElementTypeOther', label: 'Section heading' },
          { type: 'XCUIElementTypeOther', identifier: 'login-form' },
          { type: 'XCUIElementTypeOther' },
        ],
      },
    ]);
    const tree = toObservationTree(projectSnapshot(snapshot, 'ios', 'r1'));
    // The bare wrapper is dropped; the labelled and identified ones remain.
    expect(tree.children).toHaveLength(2);
  });
});

describe('controlOf', () => {
  it('descends to the inner control of a same-role wrapper', () => {
    // Real iOS: the named switch spans the whole row, so its center lands on
    // the label and receives nothing; the inner switch is the toggle.
    const snapshot = buildSnapshot([
      {
        type: 'XCUIElementTypeSwitch',
        label: 'Reduce Motion',
        value: '1',
        rect: { x: 36, y: 146, width: 330, height: 28 },
        children: [
          {
            type: 'XCUIElementTypeSwitch',
            label: '1',
            value: '1',
            rect: { x: 305, y: 146, width: 63, height: 28 },
          },
        ],
      },
    ]);
    const projected = projectSnapshot(snapshot, 'ios', 'r1');
    const outer = projected.byRef.get('e1')!;
    expect(outer.role).toBe('switch');
    expect(controlOf(outer).ref).toBe('e2');
  });

  it('returns the node itself when no same-role descendant is smaller', () => {
    const snapshot = buildSnapshot([
      {
        type: 'XCUIElementTypeCell',
        label: 'General',
        children: [{ type: 'XCUIElementTypeButton', label: 'General' }],
      },
    ]);
    const projected = projectSnapshot(snapshot, 'ios', 'r1');
    const cell = projected.byRef.get('e1')!;
    // A different role is a different node, and substituting it would retarget.
    expect(controlOf(cell).ref).toBe('e1');
  });
});

describe('nearestScrollContainer', () => {
  it('finds the closest scrollable ancestor, or none', () => {
    const snapshot = buildSnapshot([
      {
        type: 'XCUIElementTypeOther',
        children: [
          {
            type: 'XCUIElementTypeScrollView',
            children: [{ type: 'XCUIElementTypeButton', label: 'Deep' }],
          },
        ],
      },
    ]);
    const projected = projectSnapshot(snapshot, 'ios', 'r1');
    expect(nearestScrollContainer(projected.byRef.get('e3')!)?.ref).toBe('e2');
    expect(nearestScrollContainer(projected.byRef.get('e1')!)).toBeUndefined();
  });
});

describe('observation contains only addressable nodes', () => {
  it('drops the inner copies of a row label, keeping the row', () => {
    // iOS repeats a row's label on its inner button. Advertising it there lets
    // a model select a node that no derived query resolves to, which the agent
    // tier rejects as unaddressable.
    const snapshot = buildSnapshot([
      {
        type: 'XCUIElementTypeCell',
        label: 'Keyboards & Typing',
        children: [{ type: 'XCUIElementTypeButton', label: 'Keyboards & Typing' }],
      },
    ]);
    const projected = projectSnapshot(snapshot, 'ios', 'r1');
    // The row owns the label; its inner copy does not, so the observation
    // contains the row alone and everything in it is addressable.
    expect(projected.byRef.get('e1')?.ownsLabel).toBe(true);
    expect(projected.byRef.get('e2')?.ownsLabel).toBe(false);
    const tree = toObservationTree(projected);
    expect(tree.name).toBe('Keyboards & Typing');
    // The inner button survives as a control; a plain text copy would not.
    expect(tree.children?.map((child) => child.role)).toEqual(['button']);
  });
});
