/**
 * Point taps, pure half: how a point named in a screenshot lands on the
 * observation, and what the model is told about it.
 */

import { assert, describe, expect, it } from 'vitest';
import type { Observation, SemanticNode } from '../../src/engine/surface.ts';
import { prepareObservation } from '../../src/agent/observation.ts';
import { describePointAction, hitTest, imagePointToViewport, nodeLine } from '../../src/agent/point-tap.ts';

function node(id: string, extra: Partial<SemanticNode> = {}): SemanticNode {
  return { ref: { id, revision: 'r1' }, ...extra };
}

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

function observationOf(tree: SemanticNode) {
  const raw: Observation = {
    kind: 'semantic',
    root: tree.ref,
    truncated: false,
    revision: 'b3',
    capturedAt: '2026-01-01T00:00:00.000Z',
    tree,
    viewport: { width: 1280, height: 720 },
    redaction: { secureNodeCount: 0, maskedRegionCount: 0 },
  };
  const result = prepareObservation(raw, { redact: (text) => text, redactCut: (text) => text, maxBytes: 65_536 });
  assert(result.kind === 'semantic');
  return result;
}

const screen = observationOf(
  node('root', {
    role: 'document',
    rect: rect(0, 0, 1280, 720),
    children: [
      node('n1', {
        role: 'region',
        name: 'Toolbar',
        rect: rect(0, 0, 1280, 60),
        children: [
          node('n2', { role: 'button', name: 'Save', rect: rect(10, 10, 100, 40) }),
          node('n3', { role: 'button', name: 'Ghost', rect: rect(200, 10, 100, 40), states: { hidden: true } }),
          node('n4', { role: 'button', name: 'Off', rect: rect(400, 10, 100, 40), states: { disabled: true } }),
        ],
      }),
      node('n5', { role: 'paragraph', text: 'Body copy', rect: rect(0, 100, 1280, 40) }),
      node('n6', {
        role: 'button',
        name: 'Framed',
        rect: rect(10, 200, 100, 40),
        framePath: ['iframe#child'],
      }),
      node('n7', { role: 'textbox', name: 'Email', rect: rect(10, 300, 300, 40) }),
    ],
  }),
);

describe('hitTest', () => {
  it('resolves a point inside a control to the innermost control', () => {
    const hit = hitTest(screen, { x: 50, y: 30 });
    expect(hit.control?.ref.id).toBe('n2');
    expect(hit.under?.ref.id).toBe('n2');
  });

  it('reports what is under a point that lands on no control', () => {
    const hit = hitTest(screen, { x: 640, y: 120 });
    expect(hit.control).toBeUndefined();
    expect(hit.under?.ref.id).toBe('n5');
  });

  it('skips hidden and disabled controls', () => {
    expect(hitTest(screen, { x: 250, y: 30 }).control).toBeUndefined();
    expect(hitTest(screen, { x: 250, y: 30 }).under?.ref.id).toBe('n1');
    expect(hitTest(screen, { x: 450, y: 30 }).control).toBeUndefined();
  });

  it('finds a control inside a nested document, whose box is in top-level viewport pixels too', () => {
    const framed = hitTest(screen, { x: 50, y: 220 });
    expect(framed.control?.ref.id).toBe('n6');
    expect(framed.under?.ref.id).toBe('n6');
  });

  it('treats the box as half-open so adjacent controls never share an edge', () => {
    expect(hitTest(screen, { x: 110, y: 30 }).control).toBeUndefined();
    expect(hitTest(screen, { x: 109, y: 30 }).control?.ref.id).toBe('n2');
  });
});

describe('imagePointToViewport', () => {
  it('divides by the image scale and rounds: a 3x device screenshot maps to logical points', () => {
    const pixels = { width: 1170, height: 2532, scale: 3 };
    expect(imagePointToViewport({ x: 585, y: 1266 }, pixels, { width: 390, height: 844 })).toEqual({ x: 195, y: 422 });
  });

  it('is the identity for a CSS-scale capture', () => {
    const pixels = { width: 1280, height: 720, scale: 1 };
    expect(imagePointToViewport({ x: 140.4, y: 220 }, pixels, { width: 1280, height: 720 })).toEqual({ x: 140, y: 220 });
  });

  it('clamps a point the model placed off the image and off the viewport', () => {
    const pixels = { width: 1280, height: 720, scale: 1 };
    expect(imagePointToViewport({ x: -5, y: 9_999 }, pixels, { width: 1280, height: 720 })).toEqual({ x: 0, y: 719 });
    expect(imagePointToViewport({ x: 1279, y: 719 }, pixels, { width: 1000, height: 500 })).toEqual({ x: 999, y: 499 });
  });
});

describe('describePointAction', () => {
  it('names the control the point resolved to, by the line the model already reads', () => {
    const text = describePointAction({
      verb: 'tapAt',
      point: { x: 50, y: 30 },
      control: screen.nodes.get('n2'),
      under: screen.nodes.get('n2'),
      observation: screen,
    });
    expect(text).toBe('Tapped #n2 button "Save", the control at (50, 30).');
  });

  it('says a bare point landed on nothing listed, with what sits under it', () => {
    const text = describePointAction({
      verb: 'tapAt',
      point: { x: 640, y: 120 },
      control: undefined,
      under: screen.nodes.get('n5'),
      observation: screen,
    });
    expect(text).toBe('Tapped the point (640, 120); no listed control is there (under it: #n5 paragraph text="Body copy").');
  });

  it('falls back to the id when the line was cut from the text', () => {
    expect(nodeLine({ text: '#n1 document' }, 'n9')).toBe('#n9');
  });
});
