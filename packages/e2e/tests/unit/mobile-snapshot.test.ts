import { describe, expect, it } from 'vitest';
import { OBSERVED_NAME_LIMIT, OBSERVED_TEXT_LIMIT } from '../../src/driver/index.ts';
import {
  nearestScrollContainer,
  projectSnapshot,
  queryPlaceholder,
  toObservationTree,
  toSemanticNode,
} from '../../src/agent-device/snapshot.ts';
import { buildSnapshot, loginSnapshot, SCREEN } from '../helpers/mobile-snapshot.ts';

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
      '@e1',
      '@e2',
      '@e3',
      '@e4',
      '@e5',
      '@e6',
    ]);
    expect(projected.byRef.get('@e6')?.label).toBe('Continue');
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
    expect(projected.byRef.get('@e3')?.visible).toBe(false);
  });

  it('masks a secure field value and marks the observation tainted', () => {
    const projected = projectSnapshot(loginSnapshot(), 'ios', 'r1');
    const password = projected.byRef.get('@e5')!;
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
    const node = projectSnapshot(snapshot, 'ios', 'r1').byRef.get('@e1')!;
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
    expect(projected.byRef.get('@e1')?.visible).toBe(true);
    expect(projected.byRef.get('@e2')?.visible).toBe(false);
  });

  it('reports the viewport and whether a node sits inside it', () => {
    const snapshot = buildSnapshot([
      {
        type: 'XCUIElementTypeApplication',
        rect: { ...SCREEN },
        children: [
          { type: 'XCUIElementTypeButton', label: 'On screen', rect: { x: 0, y: 100, width: 402, height: 44 } },
          { type: 'XCUIElementTypeButton', label: 'Below fold', rect: { x: 0, y: 2000, width: 402, height: 44 } },
        ],
      },
    ]);
    const projected = projectSnapshot(snapshot, 'ios', 'r1');
    expect(projected.viewport).toEqual({ width: 402, height: 874 });
    const onScreen = projected.byRef.get('@e2')!;
    const belowFold = projected.byRef.get('@e3')!;
    // Scroll position does not affect visibility, matching web semantics.
    expect(belowFold.visible).toBe(true);
    expect(onScreen.withinViewport).toBe(true);
    expect(belowFold.withinViewport).toBe(false);
  });

  it('normalizes the daemon bare ref to the form its commands accept', () => {
    // Snapshot JSON carries `e12`; every interaction requires `@e12`, and a
    // bare ref is parsed as a selector and rejected.
    const snapshot = buildSnapshot([{ type: 'XCUIElementTypeButton', label: 'Go' }]);
    const bare = { ...snapshot.nodes[0]!, ref: 'e1' };
    const projected = projectSnapshot({ ...snapshot, nodes: [bare] }, 'ios', 'r1');
    expect(projected.ordered[0]?.ref).toBe('@e1');
    expect(projected.byRef.has('@e1')).toBe(true);
  });

  it('marks a node the backend reports as covered', () => {
    const snapshot = buildSnapshot([{ type: 'XCUIElementTypeButton', label: 'Behind sheet' }]);
    const covered = { ...snapshot.nodes[0]!, interactionBlocked: 'covered' as const };
    const projected = projectSnapshot({ ...snapshot, nodes: [covered] }, 'ios', 'r1');
    expect(projected.byRef.get('@e1')?.covered).toBe(true);
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
    expect(queryPlaceholder(projected.byRef.get('@e4')!)).toBe('Email');
    const filled = buildSnapshot([
      { type: 'XCUIElementTypeTextField', label: 'Email', value: 'a@b.c' },
    ]);
    const node = projectSnapshot(filled, 'ios', 'r1').byRef.get('@e1')!;
    expect(queryPlaceholder(node)).toBeUndefined();
  });

  it('never matches a non-input role', () => {
    const projected = projectSnapshot(loginSnapshot(), 'ios', 'r1');
    expect(queryPlaceholder(projected.byRef.get('@e6')!)).toBeUndefined();
  });
});

describe('toSemanticNode', () => {
  it('binds every ref to the observation revision', () => {
    const projected = projectSnapshot(loginSnapshot(), 'ios', 'rev-7');
    const node = toSemanticNode(projected.byRef.get('@e6')!, 'rev-7', { bounded: true });
    expect(node.ref).toEqual({ id: '@e6', revision: 'rev-7' });
  });

  it('exposes the identifier as the testId attribute', () => {
    const projected = projectSnapshot(loginSnapshot(), 'ios', 'r1');
    const node = toSemanticNode(projected.byRef.get('@e4')!, 'r1', { bounded: true });
    expect(node.attributes).toEqual({ testId: 'email' });
  });

  it('bounds observation fields but leaves a direct read whole', () => {
    const long = 'x'.repeat(OBSERVED_TEXT_LIMIT + 50);
    const snapshot = buildSnapshot([
      { type: 'XCUIElementTypeStaticText', label: 'y'.repeat(OBSERVED_NAME_LIMIT + 10), value: long },
    ]);
    const node = projectSnapshot(snapshot, 'ios', 'r1').byRef.get('@e1')!;
    const bounded = toSemanticNode(node, 'r1', { bounded: true });
    expect(bounded.name).toHaveLength(OBSERVED_NAME_LIMIT);
    expect(bounded.value).toHaveLength(OBSERVED_TEXT_LIMIT);
    const whole = toSemanticNode(node, 'r1', { bounded: false });
    expect(whole.value).toHaveLength(long.length);
  });

  it('omits an unavailable state instead of guessing it', () => {
    const snapshot = buildSnapshot([{ type: 'XCUIElementTypeButton', label: 'Go' }]);
    const node = projectSnapshot(snapshot, 'ios', 'r1').byRef.get('@e1')!;
    expect(toSemanticNode(node, 'r1', { bounded: true }).states).toBeUndefined();
  });

  it('reports disabled, hidden, secure, and derived checked states', () => {
    const snapshot = buildSnapshot([
      { type: 'XCUIElementTypeSwitch', label: 'Wi-Fi', value: '1', enabled: false, visibleToUser: false },
    ]);
    const node = projectSnapshot(snapshot, 'ios', 'r1').byRef.get('@e1')!;
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
    expect(tree.ref.id).toBe('@e1');
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
    expect(nearestScrollContainer(projected.byRef.get('@e3')!)?.ref).toBe('@e2');
    expect(nearestScrollContainer(projected.byRef.get('@e1')!)).toBeUndefined();
  });
});
