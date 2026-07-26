import { describe, expect, it } from 'vitest';
import type { Observation, SemanticNode } from '../../src/driver/index.ts';
import { prepareObservation } from '../../src/agent/observation.ts';

function node(id: string, extra: Partial<SemanticNode> = {}): SemanticNode {
  return { ref: { id, revision: 'r1' }, ...extra };
}

function observation(tree: SemanticNode, complete = true): Observation {
  return {
    revision: 'r1',
    capturedAt: '2026-01-01T00:00:00.000Z',
    tree,
    viewport: { width: 1280, height: 720, scale: 1 },
    redaction: { secureNodeCount: 1, maskedRegionCount: 0, complete },
  };
}

const NO_SECRETS = new Map<string, string>();
const TEST_ID = 'data-testid';

describe('prepareObservation', () => {
  it('rejects an observation whose masking the driver cannot prove', () => {
    expect(() =>
      prepareObservation(observation(node('root'), false), {
        secrets: NO_SECRETS,
        maxBytes: 4_096,
        testIdAttribute: TEST_ID,
      }),
    ).toThrow(/masking is complete/);
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
      secrets: NO_SECRETS,
      maxBytes: 4_096,
      testIdAttribute: TEST_ID,
    });
    expect(prepared.text.split('\n')).toEqual([
      '#n1 document "Home"',
      '  #n2 heading "Welcome"',
      '  #n3 button "Buy" [disabled]',
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
      secrets: NO_SECRETS,
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
      secrets: new Map([['member', 'hunter2']]),
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
      secrets: NO_SECRETS,
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
      { secrets: NO_SECRETS, maxBytes: 1_024, testIdAttribute: TEST_ID },
    );
    expect(prepared.text).toContain('#n1 document');
  });

  it('collapses whitespace and strips control characters from app text', () => {
    const prepared = prepareObservation(
      observation(node('n1', { role: 'status', text: 'line\u0007one\n   two  ' })),
      { secrets: NO_SECRETS, maxBytes: 4_096, testIdAttribute: TEST_ID },
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
      secrets: NO_SECRETS,
      maxBytes: 4_096,
      testIdAttribute: TEST_ID,
    }).text.split('\n');

    expect(lines[1]).toBe('  #n2 link "About" href="https://app.test/about"');
    expect(lines[2]).toBe('  #n3 listitem text="Alpha" testid="item"');
    expect(lines[3]).toBe('  #n4 textbox placeholder="you@example.test"');
    expect(lines[4]).toBe('  #n5 textbox "Email"');
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
        { secrets: NO_SECRETS, maxBytes, testIdAttribute: TEST_ID },
      );
      expect(prepared.bytes).toBeLessThanOrEqual(maxBytes);
      expect(prepared.truncated).toBe(true);
      expect(prepared.text).toContain('[observation truncated');
    }
  });
});
