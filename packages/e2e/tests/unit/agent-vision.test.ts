import { describe, expect, it } from 'vitest';
import { hitTest } from '../../src/agent/locate.ts';
import { prepareObservation, type AgentObservation } from '../../src/agent/observation.ts';
import { imageTokenUpperBound } from '../../src/agent/model/adapter.ts';
import { buildPrompt } from '../../src/agent/prompts.ts';
import type { Observation, ObservationPixels, SemanticNode } from '../../src/driver/index.ts';
import { readPngSize } from '../../src/playwright/support.ts';

const NO_SECRETS = new Map<string, string>();
const TEST_ID = 'data-testid';

/** A 2x2 PNG; only its IHDR header matters to these tests. */
const PNG_2X2 = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4AWP4z8DAwMgABYNKAAAeAAHUL6H5AAAAAElFTkSuQmCC',
  ),
  (character) => character.charCodeAt(0),
);

function node(id: string, extra: Partial<SemanticNode> = {}): SemanticNode {
  return { ref: { id, revision: 'r1' }, ...extra };
}

function pixels(extra: Partial<ObservationPixels> = {}): ObservationPixels {
  return {
    data: PNG_2X2,
    mediaType: 'image/png',
    width: 1280,
    height: 720,
    scale: 1,
    ...extra,
  };
}

function observation(options: {
  tree?: SemanticNode;
  pixels?: ObservationPixels;
  secureNodeCount?: number;
  maskedRegionCount?: number;
}): Observation {
  return {
    revision: 'r1',
    capturedAt: '2026-01-01T00:00:00.000Z',
    tree: options.tree ?? node('root', { role: 'document' }),
    viewport: { width: 1280, height: 720, scale: 1 },
    redaction: {
      secureNodeCount: options.secureNodeCount ?? 0,
      maskedRegionCount: options.maskedRegionCount ?? 0,
      complete: true,
    },
    ...(options.pixels === undefined ? {} : { pixels: options.pixels }),
  };
}

function prepare(raw: Observation): AgentObservation {
  return prepareObservation(raw, {
    secrets: NO_SECRETS,
    maxBytes: 4_096,
    testIdAttribute: TEST_ID,
  });
}

describe('pixel evidence clearance', () => {
  it('carries captured pixels through with their masked region count', () => {
    const prepared = prepare(
      observation({ pixels: pixels(), secureNodeCount: 1, maskedRegionCount: 1 }),
    );
    expect(prepared.pixels).toMatchObject({
      mediaType: 'image/png',
      width: 1280,
      height: 720,
      maskedRegionCount: 1,
      bytes: PNG_2X2.byteLength,
    });
    expect(prepared.pixelsWithheld).toBeUndefined();
  });

  it('withholds pixels when fewer regions were masked than secure nodes seen', () => {
    // The driver saw two secure fields and covered one: the image cannot be
    // proven redacted, so it is dropped while the tree still goes out.
    const prepared = prepare(
      observation({ pixels: pixels(), secureNodeCount: 2, maskedRegionCount: 1 }),
    );
    expect(prepared.pixels).toBeUndefined();
    expect(prepared.pixelsWithheld).toBe('MASKING_UNPROVEN');
    expect(prepared.text).not.toBe('');
  });

  it('reports nothing about pixels when none were captured', () => {
    const prepared = prepare(observation({}));
    expect(prepared.pixels).toBeUndefined();
    expect(prepared.pixelsWithheld).toBeUndefined();
  });
});

describe('pixel prompt framing', () => {
  const promptFor = (attached: ObservationPixels): string =>
    buildPrompt({
      request: 'Select one node.',
      instruction: 'the red pin',
      observation: prepare(observation({ pixels: attached })),
    });

  it('states the exact bounds and rules out relative coordinates', () => {
    const prompt = promptFor(pixels());
    expect(prompt).toContain('1280x720 pixels');
    expect(prompt).toContain('x is pixels from');
    expect(prompt).toContain('[0, 1279]');
    expect(prompt).toContain('[0, 719]');
    expect(prompt).toContain('Never return');
    expect(prompt).toContain('percentage');
  });

  it('claims CSS pixel equivalence only for a CSS-scale capture', () => {
    expect(promptFor(pixels())).toContain('CSS-scale capture');
    expect(promptFor(pixels({ width: 2560, height: 1440, scale: 2 }))).not.toContain(
      'CSS-scale capture',
    );
  });

  it('tells the model how many regions are masked', () => {
    const prepared = prepareObservation(
      observation({ pixels: pixels(), secureNodeCount: 1, maskedRegionCount: 1 }),
      { secrets: NO_SECRETS, maxBytes: 4_096, testIdAttribute: TEST_ID },
    );
    const prompt = buildPrompt({ request: 'r', instruction: 'i', observation: prepared });
    expect(prompt).toContain('1 region(s) are masked');
  });
});

describe('hitTest', () => {
  const tree = node('root', {
    role: 'document',
    rect: { x: 0, y: 0, width: 1280, height: 720 },
    children: [
      node('canvas', { role: 'generic', rect: { x: 0, y: 0, width: 800, height: 600 } }),
      node('card', {
        role: 'group',
        rect: { x: 100, y: 100, width: 400, height: 200 },
        children: [
          node('buy', {
            role: 'button',
            name: 'Buy',
            rect: { x: 120, y: 120, width: 80, height: 40 },
          }),
        ],
      }),
      node('hidden', {
        role: 'button',
        states: { hidden: true },
        rect: { x: 120, y: 120, width: 10, height: 10 },
      }),
      node('empty', { role: 'button', rect: { x: 900, y: 10, width: 0, height: 0 } }),
    ],
  });
  const prepared = prepare(observation({ tree }));

  it('returns the innermost node containing the point', () => {
    expect(hitTest(prepared, { x: 150, y: 130 })?.ref.id).toBe('buy');
    expect(hitTest(prepared, { x: 450, y: 280 })?.ref.id).toBe('card');
    expect(hitTest(prepared, { x: 700, y: 500 })?.ref.id).toBe('canvas');
  });

  it('never returns the document root, so "nothing is there" stays reportable', () => {
    expect(hitTest(prepared, { x: 1200, y: 700 })).toBeNull();
  });

  it('skips hidden and zero-area nodes', () => {
    expect(hitTest(prepared, { x: 122, y: 122 })?.ref.id).toBe('buy');
    expect(hitTest(prepared, { x: 900, y: 10 })).toBeNull();
  });
});

describe('readPngSize', () => {
  it('reads dimensions out of the image bytes', () => {
    expect(readPngSize(PNG_2X2)).toEqual({ width: 2, height: 2 });
  });

  it('returns null for truncated bytes and non-PNG data', () => {
    expect(readPngSize(PNG_2X2.slice(0, 20))).toBeNull();
    expect(readPngSize(new Uint8Array(64))).toBeNull();
  });
});

describe('imageTokenUpperBound', () => {
  it('bounds an image by the patches covering it, not its byte length', () => {
    // 1280x720 CSS pixels -> ceil(1280/28) * ceil(720/28) patches.
    expect(imageTokenUpperBound({ width: 1280, height: 720 })).toBe(46 * 26);
    expect(imageTokenUpperBound({ width: 1, height: 1 })).toBe(1);
    expect(imageTokenUpperBound({ width: 0, height: 0 })).toBe(1);
  });

  it('stays under the default per-call token ceiling for a large viewport', () => {
    expect(imageTokenUpperBound({ width: 1920, height: 1080 })).toBeLessThan(4_096);
  });
});
