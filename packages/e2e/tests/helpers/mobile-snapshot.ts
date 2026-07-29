/**
 * Builders for agent-device snapshot fixtures. They mirror the real flat
 * `index`/`parentIndex` wire shape so projection and locator tests exercise the
 * same conversion the driver performs against a device.
 */

import type { SnapshotNode, SnapshotResult } from '../../src/agent-device/client.ts';

export interface NodeSpec {
  readonly type?: string;
  readonly role?: string;
  readonly subrole?: string;
  readonly label?: string;
  readonly value?: string;
  readonly identifier?: string;
  readonly rect?: { x: number; y: number; width: number; height: number };
  readonly enabled?: boolean;
  readonly selected?: boolean;
  readonly focused?: boolean;
  readonly visibleToUser?: boolean;
  readonly hittable?: boolean;
  readonly presentationHints?: readonly string[];
  readonly children?: readonly NodeSpec[];
}

/** iPhone-sized screen in points, matching a real iOS snapshot root rect. */
export const SCREEN = { x: 0, y: 0, width: 402, height: 874 } as const;

/**
 * Flattens a nested spec into the backend's flat node array, assigning
 * `@e{n}` refs and `index`/`parentIndex` in depth-first document order.
 *
 * Every node gets geometry unless the spec sets it, because a real iOS node
 * always has a rect and the projection derives visibility from it. Roots cover
 * the screen; other nodes are stacked down the screen in declaration order.
 */
export function buildSnapshot(
  roots: readonly NodeSpec[],
  options: { readonly refsGeneration?: number } = {},
): SnapshotResult {
  const nodes: SnapshotNode[] = [];
  let next = 1;
  let stackY = 0;

  const walk = (spec: NodeSpec, parentIndex: number | undefined, depth: number): void => {
    const index = next++;
    const rect = spec.rect ?? defaultRect(parentIndex === undefined, () => (stackY += 48));
    const node = {
      index,
      ref: `@e${index}`,
      depth,
      rect,
      ...(parentIndex !== undefined ? { parentIndex } : {}),
      ...(spec.type !== undefined ? { type: spec.type } : {}),
      ...(spec.role !== undefined ? { role: spec.role } : {}),
      ...(spec.subrole !== undefined ? { subrole: spec.subrole } : {}),
      ...(spec.label !== undefined ? { label: spec.label } : {}),
      ...(spec.value !== undefined ? { value: spec.value } : {}),
      ...(spec.identifier !== undefined ? { identifier: spec.identifier } : {}),
      ...(spec.enabled !== undefined ? { enabled: spec.enabled } : {}),
      ...(spec.selected !== undefined ? { selected: spec.selected } : {}),
      ...(spec.focused !== undefined ? { focused: spec.focused } : {}),
      ...(spec.visibleToUser !== undefined ? { visibleToUser: spec.visibleToUser } : {}),
      ...(spec.hittable !== undefined ? { hittable: spec.hittable } : {}),
      ...(spec.presentationHints !== undefined
        ? { presentationHints: [...spec.presentationHints] }
        : {}),
    } as SnapshotNode;
    nodes.push(node);
    for (const child of spec.children ?? []) walk(child, index, depth + 1);
  };

  for (const root of roots) walk(root, undefined, 0);
  return {
    nodes,
    truncated: false,
    identifiers: {},
    ...(options.refsGeneration !== undefined ? { refsGeneration: options.refsGeneration } : {}),
  } as SnapshotResult;
}

/** Geometry for a node whose spec left it out. */
function defaultRect(
  isRoot: boolean,
  nextY: () => number,
): { x: number; y: number; width: number; height: number } {
  if (isRoot) return { ...SCREEN };
  const y = nextY();
  return { x: 0, y, width: SCREEN.width, height: 44 };
}

/** A small login screen used across projection and locator tests. */
export function loginSnapshot(): SnapshotResult {
  return buildSnapshot([
    {
      type: 'Application',
      label: 'Example',
      children: [
        {
          type: 'Other',
          identifier: 'login-form',
          children: [
            { type: 'StaticText', label: 'Sign in' },
            {
              type: 'TextField',
              label: 'Email',
              identifier: 'email',
              rect: { x: 20, y: 100, width: 280, height: 44 },
            },
            {
              type: 'SecureTextField',
              label: 'Password',
              value: 'hunter2',
              identifier: 'password',
              rect: { x: 20, y: 160, width: 280, height: 44 },
            },
            {
              type: 'Button',
              label: 'Continue',
              rect: { x: 20, y: 220, width: 280, height: 48 },
            },
          ],
        },
      ],
    },
  ]);
}
