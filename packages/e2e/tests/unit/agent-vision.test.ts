/**
 * The act loop's pixel tier, runner half: how a point the vision model names
 * lands on the observation, and what the model is told about it.
 */

import { describe, expect, it } from 'vitest';
import type { Observation, SemanticNode } from '../../src/engine/surface.ts';
import { prepareObservation } from '../../src/agent/observation.ts';
import {
  abstainAdvice,
  describeVisualTap,
  hitTest,
  imagePointToViewport,
  nodeLine,
  pointSystemRules,
  renderLook,
  validateLookResponse,
  validatePointResponse,
} from '../../src/agent/vision.ts';

function node(id: string, extra: Partial<SemanticNode> = {}): SemanticNode {
  return { ref: { id, revision: 'r1' }, ...extra };
}

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

function observationOf(tree: SemanticNode) {
  const raw: Observation = {
    revision: 'b3',
    capturedAt: '2026-01-01T00:00:00.000Z',
    tree,
    viewport: { width: 1280, height: 720, scale: 1 },
    redaction: { secureNodeCount: 0, maskedRegionCount: 0 },
  };
  return prepareObservation(raw, { redact: (text) => text, maxBytes: 65_536, testIdAttribute: 'data-testid' });
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

  it('skips hidden and disabled controls, and nodes inside nested documents', () => {
    expect(hitTest(screen, { x: 250, y: 30 }).control).toBeUndefined();
    expect(hitTest(screen, { x: 250, y: 30 }).under?.ref.id).toBe('n1');
    expect(hitTest(screen, { x: 450, y: 30 }).control).toBeUndefined();
    const framed = hitTest(screen, { x: 50, y: 220 });
    expect(framed.control).toBeUndefined();
    expect(framed.under?.ref.id).toBe('root');
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

describe('agent-point-1', () => {
  const found = {
    protocolVersion: 'agent-point-1',
    found: true,
    x: 12.5,
    y: 40,
    kind: 'clickable',
    abstainReason: null,
    expectedText: 'Save',
    reason: 'the blue button',
  };

  it('accepts a found point and an abstain', () => {
    expect(validatePointResponse(found)).toEqual({ ok: true, value: found });
    const abstain = { ...found, found: false, x: null, y: null, kind: null, abstainReason: 'foreground_layer', expectedText: null, reason: null };
    expect(validatePointResponse(abstain)).toEqual({ ok: true, value: abstain });
  });

  it('rejects a found target without coordinates, unknown enums, and extra fields', () => {
    expect(validatePointResponse({ ...found, x: null }).ok).toBe(false);
    expect(validatePointResponse({ ...found, x: Number.NaN }).ok).toBe(false);
    expect(validatePointResponse({ ...found, kind: 'button' }).ok).toBe(false);
    expect(validatePointResponse({ ...found, abstainReason: 'tired' }).ok).toBe(false);
    expect(validatePointResponse({ ...found, confidence: 0.9 }).ok).toBe(false);
    expect(validatePointResponse({ ...found, protocolVersion: 'agent-point-2' }).ok).toBe(false);
  });

  it('states the image size and coordinate bounds before the targeting rules', () => {
    const rules = pointSystemRules('ios', { width: 1170, height: 2532 });
    expect(rules).toContain('1170 by 2532 pixels');
    expect(rules).toContain('in [0, 1169]');
    expect(rules).toContain('in [0, 2531]');
    expect(rules).toContain('thumb');
    expect(pointSystemRules('web', { width: 10, height: 10 })).toContain('Calendar navigation');
  });
});

describe('describeVisualTap', () => {
  it('names the control the point resolved to, by the line the model already reads', () => {
    const text = describeVisualTap({
      description: 'the Save button',
      point: { x: 50, y: 30 },
      control: screen.nodes.get('n2'),
      under: screen.nodes.get('n2'),
      observation: screen,
      kind: 'clickable',
    });
    expect(text).toBe('Tapped #n2 button "Save", the control at (50, 30) for "the Save button".');
  });

  it('says a bare point landed on nothing listed, and warns when a text field was expected', () => {
    const text = describeVisualTap({
      description: 'the search box',
      point: { x: 640, y: 120 },
      control: undefined,
      under: screen.nodes.get('n5'),
      observation: screen,
      kind: 'text_entry',
    });
    expect(text).toContain('Tapped the point (640, 120) for "the search box"; no listed control is there (under it: #n5 paragraph text="Body copy").');
    expect(text).toContain('Nothing listed at that point accepts typed text.');
  });

  it('keeps the typing warning off a text field that is one', () => {
    const text = describeVisualTap({
      description: 'the email field',
      point: { x: 20, y: 310 },
      control: screen.nodes.get('n7'),
      under: screen.nodes.get('n7'),
      observation: screen,
      kind: 'text_entry',
    });
    expect(text).not.toContain('accepts typed text');
  });

  it('falls back to the id when the line was cut from the text', () => {
    expect(nodeLine({ text: '#n1 region "Toolbar"' }, 'n9')).toBe('#n9');
    expect(nodeLine({ text: '  #n1 region "Toolbar"\n   #n2 button "Save"' }, 'n2')).toBe('#n2 button "Save"');
  });

  it('gives a recovery for every abstain reason', () => {
    expect(abstainAdvice('foreground_layer')).toContain('Dismiss');
    expect(abstainAdvice('offscreen_or_clipped')).toContain('Scroll');
    expect(abstainAdvice('ambiguous')).toContain('exact text');
    expect(abstainAdvice(null)).toContain('node id');
  });
});

describe('agent-look-1', () => {
  const look = {
    protocolVersion: 'agent-look-1',
    topLayer: 'none',
    summary: 'A grey map with two pins.',
    interactiveElements: ['red pin, circle, top right', 'blue pin, circle, bottom left'],
    formFields: [],
    errors: [],
    answer: 'red and blue',
  };

  it('accepts a description and drops blank list entries', () => {
    const value = validateLookResponse({ ...look, formFields: ['  '] });
    expect(value).toEqual({ ok: true, value: { ...look, formFields: [] } });
  });

  it('rejects a list of non-strings and an unknown field', () => {
    expect(validateLookResponse({ ...look, errors: [1] }).ok).toBe(false);
    expect(validateLookResponse({ ...look, recommendedAction: 'tap it' }).ok).toBe(false);
  });

  it('renders as text a tree-only model can read, with the answer last', () => {
    const rendered = renderLook({ ...look, protocolVersion: 'agent-look-1', answer: 'red and blue' } as never, { revision: 'b3' });
    expect(rendered).toContain('Screen as seen in pixels (observation b3)');
    expect(rendered).toContain('- red pin, circle, top right');
    expect(rendered).toContain('Form fields:\n- none');
    expect(rendered.endsWith('Answer: red and blue')).toBe(true);
  });
});
