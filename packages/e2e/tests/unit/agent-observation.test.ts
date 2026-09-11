import { describe, expect, it } from 'vitest';
import type { Observation, SemanticNode } from '../../src/engine/surface.ts';
import { interactiveNodeCount, observationShape, prepareObservation, settleObservation } from '../../src/agent/observation.ts';
import { createRedactor } from '../../src/internal/redact.ts';

function node(id: string, extra: Partial<SemanticNode> = {}): SemanticNode {
  return { ref: { id, revision: 'r1' }, ...extra };
}

function observation(tree: SemanticNode, pixels?: Observation['pixels']): Observation {
  return {
    revision: 'r1',
    capturedAt: '2026-01-01T00:00:00.000Z',
    tree,
    viewport: { width: 1280, height: 720, scale: 1 },
    redaction: { secureNodeCount: 1, maskedRegionCount: 0 },
    ...(pixels === undefined ? {} : { pixels }),
  };
}

const NO_REDACT = (text: string): string => text;
const TEST_ID = 'data-testid';

describe('prepareObservation', () => {
  it('withholds pixels whose masking the engine cannot prove and keeps the tree', () => {
    const pixels = { data: new Uint8Array(4), mediaType: 'image/png' as const, width: 2, height: 2, scale: 1 };
    const prepared = prepareObservation(observation(node('root'), pixels), {
      redact: NO_REDACT,
      maxBytes: 4_096,
      testIdAttribute: TEST_ID,
    });
    // One secure node, zero masked regions: the image is not provably redacted.
    expect(prepared.pixels).toBeUndefined();
    expect(prepared.pixelsWithheld).toBe('MASKING_UNPROVEN');
    expect(prepared.text).toBe('#root');
  });

  it('serializes the tree with node references and indentation', () => {
    const tree = node('n1', {
      role: 'document',
      name: 'Home',
      children: [
        node('n2', { role: 'heading', name: 'Welcome' }),
        node('n3', { role: 'button', name: 'Buy', states: { disabled: true } }),
      ],
    });
    const prepared = prepareObservation(observation(tree), {
      redact: NO_REDACT,
      maxBytes: 4_096,
      testIdAttribute: TEST_ID,
    });
    expect(prepared.text.split('\n')).toEqual([
      '#n1 document "Home"',
      ' #n2 heading "Welcome"',
      ' #n3 button "Buy" [disabled]',
    ]);
    expect(prepared.revision).toBe('r1');
    expect([...prepared.nodes.keys()]).toEqual(['n1', 'n2', 'n3']);
    expect(prepared.bytes).toBe(prepared.text.length);
  });

  it('masks secure fields and never renders their value', () => {
    const tree = node('n1', {
      children: [
        node('n2', {
          role: 'textbox',
          name: 'Password',
          value: 'should-not-appear',
          inputPurpose: 'password',
          states: { secure: true },
        }),
      ],
    });
    const prepared = prepareObservation(observation(tree), {
      redact: NO_REDACT,
      maxBytes: 4_096,
      testIdAttribute: TEST_ID,
    });
    expect(prepared.text).toContain('value=<secure>');
    expect(prepared.text).toContain('purpose=password');
    expect(prepared.text).not.toContain('should-not-appear');
  });

  it('replaces every exact registered secret value with its stable name', () => {
    const tree = node('n1', {
      children: [
        node('n2', { role: 'status', text: 'signed in as hunter2 (hunter2)' }),
        node('n3', { role: 'textbox', name: 'hunter2', value: 'hunter2' }),
      ],
    });
    const prepared = prepareObservation(observation(tree), {
      redact: createRedactor(new Map([['member', 'hunter2']])),
      maxBytes: 4_096,
      testIdAttribute: TEST_ID,
    });
    expect(prepared.text).not.toContain('hunter2');
    expect(prepared.text).toContain('<secret:member>');
  });

  it('truncates at the byte limit while keeping the root and flagging truncation', () => {
    const children = Array.from({ length: 200 }, (_, index) =>
      node(`c${index}`, { role: 'button', name: `Button number ${index}` }),
    );
    const prepared = prepareObservation(observation(node('n1', { role: 'document', children })), {
      redact: NO_REDACT,
      maxBytes: 256,
      testIdAttribute: TEST_ID,
    });
    expect(prepared.truncated).toBe(true);
    expect(prepared.text.startsWith('#n1 document')).toBe(true);
    expect(prepared.text).toContain('[observation truncated');
    expect(prepared.nodes.size).toBe(201);
  });

  it('keeps the root even when it alone exceeds the limit', () => {
    const prepared = prepareObservation(
      observation(node('n1', { role: 'document', name: 'x'.repeat(500) })),
      { redact: NO_REDACT, maxBytes: 1_024, testIdAttribute: TEST_ID },
    );
    expect(prepared.text).toContain('#n1 document');
  });

  it('collapses whitespace and strips control characters from app text', () => {
    const prepared = prepareObservation(
      observation(node('n1', { role: 'status', text: 'line\u0007one\n   two  ' })),
      { redact: NO_REDACT, maxBytes: 4_096, testIdAttribute: TEST_ID },
    );
    expect(prepared.text).toContain('text="line\uFFFDone two"');
  });
});

describe('disambiguating attributes', () => {
  it('renders test IDs, hrefs, and unnamed placeholders for the model', () => {
    const tree = node('n1', {
      children: [
        node('n2', { role: 'link', name: 'About', attributes: { href: 'https://app.test/about' } }),
        node('n3', { role: 'listitem', text: 'Alpha', attributes: { 'data-testid': 'item' } }),
        node('n4', { role: 'textbox', attributes: { placeholder: 'you@example.test' } }),
        node('n5', { role: 'textbox', name: 'Email', attributes: { placeholder: 'ignored' } }),
      ],
    });
    const lines = prepareObservation(observation(tree), {
      redact: NO_REDACT,
      maxBytes: 4_096,
      testIdAttribute: TEST_ID,
    }).text.split('\n');

    expect(lines[1]).toBe(' #n2 link "About" href="https://app.test/about"');
    expect(lines[2]).toBe(' #n3 listitem text="Alpha" testid="item"');
    expect(lines[3]).toBe(' #n4 textbox placeholder="you@example.test"');
    expect(lines[4]).toBe(' #n5 textbox "Email"');
  });
});

describe('observation byte budget', () => {
  it('never exceeds the budget, including the truncation marker', () => {
    // The budget is what keeps a request under the per-call token ceiling, so
    // overshooting it by the marker length can tip a large page over.
    const children = Array.from({ length: 400 }, (_, index) =>
      node(`c${index}`, { role: 'button', name: `Button number ${index}` }),
    );
    for (const maxBytes of [200, 512, 2_048, 4_096]) {
      const prepared = prepareObservation(
        observation(node('n1', { role: 'document', children })),
        { redact: NO_REDACT, maxBytes, testIdAttribute: TEST_ID },
      );
      expect(prepared.bytes).toBeLessThanOrEqual(maxBytes);
      expect(prepared.truncated).toBe(true);
      expect(prepared.text).toContain('[observation truncated');
    }
  });
});

describe('observationShape', () => {
  const shapeOf = (text: string): string =>
    observationShape({ text } as unknown as Parameters<typeof observationShape>[0]);

  it('ignores the per-observation node ids', () => {
    expect(shapeOf('#n1 button "Save"\n  #n2 link "Home"')).toBe(
      shapeOf('#n9 button "Save"\n  #n7 link "Home"'),
    );
  });

  it('ignores focus, which moves without the page changing', () => {
    // The browser settling focus after load, a script claiming it, a widget
    // stealing it: none of it changes what a judgment would answer, so none of
    // it may cost a model call.
    expect(shapeOf('#n1 textbox "Email" [focused]')).toBe(shapeOf('#n1 textbox "Email"'));
    expect(shapeOf('#n1 checkbox "Terms" [checked focused]')).toBe(
      shapeOf('#n1 checkbox "Terms" [checked]'),
    );
  });

  it('is shaped by the pixels when a capture carries them, so a canvas that redrew counts as changed', () => {
    const withPixels = (data: number[]) =>
      observationShape({
        text: '#n1 document "Map"',
        pixels: { data: new Uint8Array(data), mediaType: 'image/png', width: 2, height: 1, scale: 1, maskedRegionCount: 0 },
      } as unknown as Parameters<typeof observationShape>[0]);
    expect(withPixels([1, 2, 3])).toBe(withPixels([1, 2, 3]));
    expect(withPixels([1, 2, 3])).not.toBe(withPixels([1, 2, 4]));
    expect(withPixels([1, 2, 3])).not.toBe(shapeOf('#n1 document "Map"'));
  });

  it('still notices a state that is about the page', () => {
    expect(shapeOf('#n1 checkbox "Terms" [checked]')).not.toBe(shapeOf('#n1 checkbox "Terms"'));
    expect(shapeOf('#n1 button "Save" [disabled]')).not.toBe(shapeOf('#n1 button "Save"'));
  });

  it('ignores clock-like values, which tick without the page changing', () => {
    // A timer would end the wait for an action's effect on its first tick and
    // keep a settle from ever seeing two looks agree.
    expect(shapeOf('#n1 status "Elapsed 00:12"')).toBe(shapeOf('#n1 status "Elapsed 00:13"'));
    expect(shapeOf('#n1 text "12:05:59"')).toBe(shapeOf('#n1 text "12:06:00"'));
    expect(shapeOf('#n1 status "Items 12"')).not.toBe(shapeOf('#n1 status "Items 13"'));
  });

  it('notices changed text and changed structure', () => {
    expect(shapeOf('#n1 status "Loading"')).not.toBe(shapeOf('#n1 status "Ready"'));
    expect(shapeOf('#n1 list\n  #n2 listitem "A"')).not.toBe(
      shapeOf('#n1 list\n  #n2 listitem "A"\n  #n3 listitem "B"'),
    );
  });
});

describe('projectTree', () => {
  it('redacts names, text, values, and attributes, and drops secure values and selectors', async () => {
    const { projectTree } = await import('../../src/agent/observation.ts');
    const redact = (text: string): string => text.replaceAll('hunter2', '<password>');
    const tree = node('root', {
      role: 'document',
      children: [
        node('n1', {
          role: 'textbox',
          name: 'Password',
          value: 'hunter2',
          states: { secure: true, focused: true },
          selector: 'input[name=password]',
        }),
        node('n2', {
          role: 'link',
          name: 'hunter2 profile',
          text: 'see hunter2',
          attributes: { href: '/u/hunter2' },
          rect: { x: 1, y: 2, width: 3, height: 4 },
        }),
      ],
    });
    const projected = projectTree(tree, redact);
    expect(projected).toEqual({
      id: 'root',
      role: 'document',
      children: [
        { id: 'n1', role: 'textbox', name: 'Password', states: { secure: true, focused: true } },
        {
          id: 'n2',
          role: 'link',
          name: '<password> profile',
          text: 'see <password>',
          attributes: { href: '/u/<password>' },
          rect: { x: 1, y: 2, width: 3, height: 4 },
        },
      ],
    });
    expect(JSON.stringify(projected)).not.toContain('selector');
  });
});

describe('settleObservation', () => {
  const clock = { remainingMs: () => 60_000, signal: new AbortController().signal };
  const fast = { pollMs: 5, changeWaitMs: 150, stableWaitMs: 30 };

  /** Captures the scripted values in order, then the last one forever. */
  function scripted(values: readonly string[]): { capture: () => Promise<string>; calls: () => number } {
    let index = 0;
    return {
      capture: () => Promise.resolve(values[Math.min(index++, values.length - 1)]!),
      calls: () => index,
    };
  }

  it('waits for the screen to leave the pre-action shape before settling on it', async () => {
    const source = scripted(['old', 'old', 'old', 'new', 'new', 'new']);
    const value = await settleObservation(source.capture, (v) => v, clock, { ...fast, changedFrom: 'old' });
    expect(value).toBe('new');
  });

  it('returns the unchanged screen once the change wait runs out', async () => {
    const source = scripted(['old']);
    const started = Date.now();
    const value = await settleObservation(source.capture, (v) => v, clock, { ...fast, changedFrom: 'old' });
    expect(value).toBe('old');
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it('never settles on a transitional capture while the change wait lasts', async () => {
    const source = scripted(['old', '', '', 'new', 'new']);
    const value = await settleObservation(source.capture, (v) => v, clock, {
      ...fast,
      changedFrom: 'old',
      transitional: (v) => v === '',
    });
    expect(value).toBe('new');
  });

  it('settles on stability alone without a pre-action shape', async () => {
    const source = scripted(['a', 'b', 'b']);
    const value = await settleObservation(source.capture, (v) => v, clock, fast);
    expect(value).toBe('b');
    expect(source.calls()).toBe(3);
  });
});

describe('interactiveNodeCount', () => {
  it('counts the listed nodes the model could act on by id', () => {
    const lines = (...items: string[]) => ({ text: items.join('\n') });
    expect(
      interactiveNodeCount(
        lines('#n1 document "Home"', ' #n2 heading "Welcome"', ' #n3 button "Increment"', ' #n4 status "Counter" text="0"', ' #n5 link "About"', ' #n6 textbox "Email"'),
      ),
    ).toBe(3);
    expect(interactiveNodeCount(lines('#n1 document "Canvas"', ' #n2 heading "Map"', ' #n3 status "Picked"'))).toBe(0);
  });
});
