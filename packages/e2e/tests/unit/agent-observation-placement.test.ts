/**
 * Placement in the serialized observation.
 *
 * Built from geometry measured off a real booking page, because the bug it fixes
 * was invisible in every synthetic fixture: the driver reports a rect for every
 * node and the serializer used to drop all of them, so two controls in completely
 * different places on the page produced byte-identical lines.
 */

import { describe, expect, it } from 'vitest';
import { observationShape, prepareObservation } from '../../src/agent/observation.ts';
import type { Observation, SemanticNode } from '../../src/driver/index.ts';

const VIEWPORT = { width: 1280, height: 720, scale: 1 };

let counter = 0;
function node(partial: Partial<SemanticNode> & { rect?: SemanticNode['rect'] }): SemanticNode {
  counter += 1;
  return { ref: { id: `n${counter}`, revision: 'r1' }, ...partial } as SemanticNode;
}

function observe(children: readonly SemanticNode[], maxBytes = 32_768) {
  const tree = node({ role: 'document', rect: { x: 0, y: 0, width: 1280, height: 720 } });
  const observation = {
    revision: 'r1',
    tree: { ...tree, children },
    viewport: VIEWPORT,
    redaction: { complete: true, secureNodeCount: 0, maskedRegionCount: 0 },
  } as unknown as Observation;
  return prepareObservation(observation, {
    secrets: new Map(),
    maxBytes,
    testIdAttribute: 'data-testid',
  });
}

describe('observation placement', () => {
  // The exact shape of the stall. After tapping "Kup teraz" the page opens a
  // dialog and leaves the original button at y=-2350, far above the fold. Both
  // buttons carry the same role, name, and testid, so the two lines were
  // identical and the agent kept choosing the dead one — it comes first in
  // document order — and gave up on an unchanged screen every run.
  const dead = node({
    role: 'button',
    name: 'Kup teraz',
    attributes: { 'data-testid': 'crosssell-btn-reservation' },
    states: { focused: true },
    rect: { x: 871, y: -2350, width: 314, height: 40 },
  });
  const live = node({
    role: 'button',
    name: 'Kup teraz',
    attributes: { 'data-testid': 'crosssell-btn-reservation' },
    rect: { x: 677, y: 491, width: 508, height: 40 },
  });

  it('tells two otherwise identical controls apart', () => {
    const lines = observe([dead, live]).text.split('\n').slice(1);
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toBe(lines[1]);
    // The one that scrolled away says so; the one in front of the user does not.
    expect(lines[0]).toContain('off-screen above');
    expect(lines[1]).not.toContain('off-screen');
  });

  // Keyed without the volatile states on purpose: the dead button is `focused`
  // precisely because the agent just pressed it, and keying on that made the one
  // node that most needed disambiguating look unique.
  it('gives an ambiguous line its position, and an unambiguous one none', () => {
    const both = observe([dead, live]).text.split('\n').slice(1);
    expect(both[0]).toContain('at=871,-2350');
    expect(both[1]).toContain('at=677,491');

    const alone = observe([live]).text.split('\n').slice(1);
    expect(alone[0]).not.toContain('at=');
  });

  // A repeated control is ordered by y, which is what makes "the first offer"
  // answerable at all. Sixteen of these appear on one real listing page.
  it('orders repeated controls by position', () => {
    const rows = [1119, 1363, 1607].map((y) =>
      node({
        role: 'button',
        name: 'SPRAWDŹ CENĘ',
        rect: { x: 1038, y, width: 166, height: 32 },
      }),
    );
    const lines = observe(rows).text.split('\n').slice(1);
    expect(lines[0]).toContain('at=1038,1119');
    expect(lines[1]).toContain('at=1038,1363');
    expect(lines[2]).toContain('at=1038,1607');
    // All below the fold on a 720px viewport, and each says so.
    for (const line of lines) expect(line).toContain('off-screen below');
  });

  it('marks each direction a node can be outside the viewport', () => {
    const cases: readonly [string, NonNullable<SemanticNode['rect']>][] = [
      ['off-screen above', { x: 10, y: -200, width: 50, height: 20 }],
      ['off-screen below', { x: 10, y: 900, width: 50, height: 20 }],
      ['off-screen left', { x: -400, y: 100, width: 50, height: 20 }],
      ['off-screen right', { x: 1500, y: 100, width: 50, height: 20 }],
    ];
    for (const [expected, rect] of cases) {
      const line = observe([node({ role: 'button', name: 'Go', rect })]).text.split('\n')[1];
      expect(line, expected).toContain(expected);
    }
  });

  it('says nothing about a node inside the viewport', () => {
    const inside = node({ role: 'button', name: 'Go', rect: { x: 10, y: 10, width: 80, height: 30 } });
    const line = observe([inside]).text.split('\n')[1];
    expect(line).not.toContain('off-screen');
    expect(line).not.toContain('at=');
    expect(line).toContain('button "Go"');
  });

  // A control flush against an edge, or one pixel over it, is still the control
  // the user is looking at.
  it('does not call a control on the fold off-screen', () => {
    const straddling = node({
      role: 'button',
      name: 'Go',
      rect: { x: 10, y: 710, width: 80, height: 30 },
    });
    expect(observe([straddling]).text).not.toContain('off-screen');
  });

  it('omits placement for a node the driver gave no rect', () => {
    const line = observe([node({ role: 'button', name: 'Go' })]).text.split('\n')[1];
    expect(line).toMatch(/^ #n\d+ button "Go"$/);
  });

  // Placement is viewport-relative, so scrolling moves every coordinate on the
  // page. Letting that into the shape would make almost any pixel shift read as a
  // changed screen, and the runner's refusal to repeat a submit against an
  // unchanged screen depends on that comparison being strict.
  it('is excluded from the shape used to detect an unchanged screen', () => {
    const scrolledUp = observe([
      node({ role: 'button', name: 'Buy', rect: { x: 100, y: 300, width: 80, height: 30 } }),
    ]);
    counter = 0;
    const scrolledDown = observe([
      node({ role: 'button', name: 'Buy', rect: { x: 100, y: -900, width: 80, height: 30 } }),
    ]);
    expect(scrolledUp.text).not.toBe(scrolledDown.text);
    expect(observationShape(scrolledUp)).toBe(observationShape(scrolledDown));
  });

  it('still keeps a real content change visible in the shape', () => {
    const before = observe([
      node({ role: 'button', name: 'Buy', rect: { x: 100, y: 300, width: 80, height: 30 } }),
    ]);
    const after = observe([
      node({ role: 'button', name: 'Cancel', rect: { x: 100, y: 300, width: 80, height: 30 } }),
    ]);
    expect(observationShape(before)).not.toBe(observationShape(after));
  });

  // The suffix costs bytes, and the budget is what keeps a request under the
  // per-call token ceiling.
  it('still truncates at the byte budget with placement attached', () => {
    const many = Array.from({ length: 400 }, (_, index) =>
      node({
        role: 'button',
        name: `Row ${index} with a reasonably long accessible name`,
        rect: { x: 10, y: 900 + index, width: 80, height: 30 },
      }),
    );
    const result = observe(many, 2_048);
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(2_048);
    expect(result.text).toContain('truncated');
  });
});
