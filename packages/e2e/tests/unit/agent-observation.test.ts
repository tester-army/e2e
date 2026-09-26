import { assert, describe, expect, it, vi } from 'vitest';
import type { Observation, SemanticNode } from '../../src/engine/surface.ts';
import { changeShape, interactiveNodeCount, isTransitionalObservation, observationShape, prepareObservation, projectTree, settleObservation } from '../../src/agent/observation.ts';
import { OBSERVED_NAME_LIMIT, OBSERVED_TEXT_LIMIT } from '../../src/engine/contract.ts';
import { SecretLedger } from '../../src/internal/redact.ts';

function node(id: string, extra: Partial<SemanticNode> = {}): SemanticNode {
  return { ref: { id, revision: 'r1' }, ...extra };
}

function observation(tree: SemanticNode, pixels?: Observation['pixels']): Extract<Observation, { kind: 'semantic' }> {
  return {
    kind: 'semantic',
    root: tree.ref,
    truncated: false,
    revision: 'r1',
    capturedAt: '2026-01-01T00:00:00.000Z',
    tree,
    viewport: { width: 1280, height: 720 },
    redaction: { secureNodeCount: 1, maskedRegionCount: 0 },
    ...(pixels === undefined ? {} : { pixels }),
  };
}

const NO_REDACT = (text: string): string => text;

describe('prepareObservation', () => {
  it('keeps unavailable semantics separate from an empty tree and requires permitted masked evidence', () => {
    const pixels = { data: new Uint8Array(4), mediaType: 'image/png' as const, width: 2, height: 2, scale: 1 };
    const unavailable: Observation = {
      kind: 'pixels', root: node('root').ref, revision: 'r1', capturedAt: '',
      viewport: { width: 2, height: 2 }, pixels,
      redaction: { secureNodeCount: 1, maskedRegionCount: 0 },
    };
    const prepare = (raw: Observation, pixelsAllowed = true) => prepareObservation(raw, { redact: NO_REDACT, redactCut: NO_REDACT, maxBytes: 4_096, pixelsAllowed });
    expect(() => prepare(unavailable)).toThrow(/proven-masked screenshot/);
    const proven = { ...unavailable, redaction: { secureNodeCount: 1, maskedRegionCount: 1 } };
    const prepared = prepare(proven);
    expect(prepared.kind).toBe('pixels');
    expect(prepared.text).toContain('semantic capture unavailable');
    expect(prepared.text).toContain('previous node ids are no longer valid');
    expect(prepared.text).toContain('never infer absence');
    expect(prepared).not.toHaveProperty('nodes');
    expect(prepared).not.toHaveProperty('tree');
    expect(() => prepare(proven, false)).toThrow(/permitted/);
    const empty = prepare(observation(node('root')));
    expect(empty.kind).toBe('semantic');
    expect(empty.text).not.toContain('unavailable');
  });

  it('keeps the whole address after the origin as the path, fragment included, for the route check to read', () => {
    const at = (location: string) => prepareObservation({ ...observation(node('root')), location }, { redact: NO_REDACT, redactCut: NO_REDACT, maxBytes: 4_096, pixelsAllowed: true }).path;
    expect(at('https://app.example.test/companies?search=a#/orders/42')).toBe('/companies?search=a#/orders/42');
    expect(at('https://app.example.test/companies#top')).toBe('/companies#top');
    expect(at('Settings')).toBe('Settings');
  });

  it('returns evidence without a comparable shape without repeating capture', async () => {
    let captures = 0;
    const result = await settleObservation(
      async () => { captures += 1; return { kind: 'pixels' }; },
      () => undefined,
      { remainingMs: () => 10_000, signal: new AbortController().signal },
      { stableWaitMs: 30 },
    );
    expect(result.kind).toBe('pixels');
    expect(captures).toBe(1);
  });
  it('withholds pixels whose masking the engine cannot prove and keeps the tree', () => {
    const pixels = { data: new Uint8Array(4), mediaType: 'image/png' as const, width: 2, height: 2, scale: 1 };
    const prepared = prepareObservation(observation(node('root'), pixels), {
      redact: NO_REDACT,
      redactCut: NO_REDACT,
      maxBytes: 4_096,
    });
    // One secure node, zero masked regions: the image is not provably redacted.
    expect(prepared.pixels).toBeUndefined();
    assert(prepared.kind === 'semantic');
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
      redactCut: NO_REDACT,
      maxBytes: 4_096,
    });
    expect(prepared.text.split('\n')).toEqual([
      '#n1 document "Home"',
      ' #n2 heading "Welcome"',
      ' #n3 button "Buy" [disabled]',
    ]);
    expect(prepared.revision).toBe('r1');
    assert(prepared.kind === 'semantic');
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
      redactCut: NO_REDACT,
      maxBytes: 4_096,
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
    const ledger = new SecretLedger([['member', 'hunter2']]);
    const prepared = prepareObservation(observation(tree), {
      redact: ledger.redact,
      redactCut: ledger.redactCut,
      maxBytes: 4_096,
    });
    expect(prepared.text).not.toContain('hunter2');
    expect(prepared.text).toContain('<secret:member>');
  });

  it('redacts the leading part of a secret a field cut at its limit ends with, and leaves a cut plain value and a whole field alone', () => {
    const secret = 'cut-secret-Kq7ZrT2mWx9pLd4sNv8bHc3jFg6yQa1eUo5iRk0tYw2zXn7uM';
    const ledger = new SecretLedger([['apiKey', secret]]);
    const cutText = (tail: string): string => `${'0'.repeat(OBSERVED_TEXT_LIMIT - tail.length)}${tail}`;
    const kept = secret.slice(0, 59);
    const tree = node('n1', {
      children: [
        node('n2', { role: 'paragraph', text: cutText(kept) }),
        node('n3', { role: 'button', name: `${'0'.repeat(OBSERVED_NAME_LIMIT - 40)}${secret.slice(0, 40)}` }),
        node('n4', { role: 'textbox', value: cutText(secret.slice(0, 20)), selection: cutText(secret.slice(0, 12)) }),
        node('n5', { role: 'paragraph', text: cutText('plain-control-plain') }),
        node('n6', { role: 'paragraph', text: `whole ${secret.slice(0, 20)}` }),
        node('n7', { role: 'textbox', value: `0${cutText(secret.slice(0, 20))}` }),
      ],
    });
    const prepared = prepareObservation(observation(tree), { redact: ledger.redact, redactCut: ledger.redactCut, maxBytes: 16_384 });
    assert(prepared.kind === 'semantic');
    const cutLines = prepared.text.split('\n').filter((line) => /#n[234] /.test(line));
    expect(cutLines).toHaveLength(3);
    for (const line of cutLines) expect(line).not.toContain(secret.slice(0, 12));
    // The textbox's value holds the secret, so its selection is withheld rather than redacted.
    expect(cutLines.join('\n').match(/<secret:apiKey>/g)).toHaveLength(3);
    expect(prepared.nodes.get('n4')?.selection).toBeUndefined();
    expect(prepared.nodes.get('n2')?.text).toBe(`${'0'.repeat(OBSERVED_TEXT_LIMIT - kept.length)}<secret:apiKey>`);
    expect(JSON.stringify(['n2', 'n3', 'n4'].map((id) => prepared.nodes.get(id)))).not.toContain(secret.slice(0, 12));
    expect(prepared.tree.children?.[0]).toBe(prepared.nodes.get('n2'));
    expect(prepared.nodes.get('n5')?.text).toBe(cutText('plain-control-plain'));
    // A field under its limit was not cut, so a fragment inside it is only app text.
    expect(prepared.nodes.get('n6')?.text).toBe(`whole ${secret.slice(0, 20)}`);
    expect(prepared.nodes.get('n6')).toBe(tree.children?.[4]);
    // A value longer than the limit is a native control's, which no engine cuts.
    expect(prepared.nodes.get('n7')).toBe(tree.children?.[5]);
  });

  it('truncates at the byte limit while keeping the root and flagging truncation', () => {
    const children = Array.from({ length: 200 }, (_, index) =>
      node(`c${index}`, { role: 'button', name: `Button number ${index}` }),
    );
    const prepared = prepareObservation(observation(node('n1', { role: 'document', children })), {
      redact: NO_REDACT,
      redactCut: NO_REDACT,
      maxBytes: 256,
    });
    assert(prepared.kind === 'semantic');
    expect(prepared.truncated).toBe(true);
    expect(prepared.text.startsWith('#n1 document')).toBe(true);
    expect(prepared.text).toContain('[observation truncated');
    expect(prepared.nodes.size).toBe(201);
  });

  it('carries an engine-reported cut through as truncated, with its own marker', () => {
    const tree = node('n1', { role: 'document', children: [node('n2', { role: 'button', name: 'One' })] });
    const prepared = prepareObservation(
      { ...observation(tree), truncated: true },
      { redact: NO_REDACT, redactCut: NO_REDACT, maxBytes: 4_096 },
    );
    assert(prepared.kind === 'semantic');
    expect(prepared.truncated).toBe(true);
    expect(prepared.text.split('\n')).toEqual([
      '#n1 document',
      ' #n2 button "One"',
      '[observation truncated: the engine stopped listing nodes at its limit]',
    ]);
    expect(prepared.bytes).toBe(new TextEncoder().encode(prepared.text).byteLength);
    expect(prepared.nodes.size).toBe(2);
  });

  it('reports the byte cut, not the engine cut, when both apply', () => {
    const children = Array.from({ length: 200 }, (_, index) =>
      node(`c${index}`, { role: 'button', name: `Button ${index}` }),
    );
    const prepared = prepareObservation(
      { ...observation(node('n1', { role: 'document', children })), truncated: true },
      { redact: NO_REDACT, redactCut: NO_REDACT, maxBytes: 256 },
    );
    assert(prepared.kind === 'semantic');
    expect(prepared.truncated).toBe(true);
    expect(prepared.bytes).toBeLessThanOrEqual(256);
    expect(prepared.text.endsWith('[observation truncated at the resolved observation byte limit]')).toBe(true);
    expect(prepared.text).not.toContain('engine stopped');
  });

  it('keeps the root even when it alone exceeds the limit', () => {
    const prepared = prepareObservation(
      observation(node('n1', { role: 'document', name: 'x'.repeat(500) })),
      { redact: NO_REDACT, redactCut: NO_REDACT, maxBytes: 1_024 },
    );
    expect(prepared.text).toContain('#n1 document');
  });

  it('collapses whitespace and strips control characters from app text', () => {
    const prepared = prepareObservation(
      observation(node('n1', { role: 'status', text: 'line\u0007one\n   two  ' })),
      { redact: NO_REDACT, redactCut: NO_REDACT, maxBytes: 4_096 },
    );
    expect(prepared.text).toContain('text="line\uFFFDone two"');
  });
});

describe('disambiguating attributes', () => {
  it('renders test IDs, hrefs, and unnamed placeholders for the model', () => {
    const tree = node('n1', {
      children: [
        node('n2', { role: 'link', name: 'About', attributes: { href: 'https://app.test/about' } }),
        node('n3', { role: 'listitem', text: 'Alpha', testId: 'item' }),
        node('n4', { role: 'textbox', attributes: { placeholder: 'you@example.test' } }),
        node('n5', { role: 'textbox', name: 'Email', attributes: { placeholder: 'ignored' } }),
      ],
    });
    const lines = prepareObservation(observation(tree), {
      redact: NO_REDACT,
      redactCut: NO_REDACT,
      maxBytes: 4_096,
    }).text.split('\n');

    expect(lines[1]).toBe(' #n2 link "About" href="https://app.test/about"');
    expect(lines[2]).toBe(' #n3 listitem text="Alpha" testid="item"');
    expect(lines[3]).toBe(' #n4 textbox placeholder="you@example.test"');
    expect(lines[4]).toBe(' #n5 textbox "Email"');
  });

  it('renders the selected text of a focused field verbatim after its value, a lone space included, never for a secure one', () => {
    const tree = node('n1', {
      children: [
        node('n2', { role: 'textbox', value: 'release approved', selection: 'approved', states: { focused: true } }),
        node('n3', { role: 'textbox', value: 'two\nlines', selection: 'two\nli', states: { focused: true } }),
        node('n4', { role: 'textbox', name: 'Password', value: 'hunter2', selection: 'hunter2', states: { focused: true, secure: true } }),
        node('n5', { role: 'textbox', value: 'caret only', selection: '' }),
        node('n6', { role: 'textbox', value: 'alpha beta', selection: ' ', states: { focused: true } }),
      ],
    });
    const lines = prepareObservation(observation(tree), {
      redact: NO_REDACT,
      redactCut: NO_REDACT,
      maxBytes: 4_096,
    }).text.split('\n');

    expect(lines[1]).toBe(' #n2 textbox value="release approved" selection="approved" [focused]');
    expect(lines[2]).toBe(' #n3 textbox value="two\\nlines" selection="two\\nli" [focused]');
    expect(lines[3]).toBe(' #n4 textbox "Password" value=<secure> [focused secure]');
    expect(lines[4]).toBe(' #n5 textbox value="caret only"');
    expect(lines[5]).toBe(' #n6 textbox value="alpha beta" selection=" " [focused]');
  });

  it('withholds the selection of a plain field that holds a registered secret, everywhere the tree goes', () => {
    const secret = 'plain-secret-Kq7ZrT2mWx9pLd4sNv8bHc3jFg6yQa1eUo5iRk0tYw2zXn7u';
    const fragment = secret.slice(5, 45);
    const tree = node('n1', {
      children: [
        node('n2', { role: 'textbox', name: 'Token', value: secret, selection: fragment, states: { focused: true } }),
        node('n3', { role: 'textbox', name: 'Note', value: 'release approved', selection: 'approved' }),
        node('n4', { role: 'textbox', name: 'Rich', text: `key ${secret}`, selection: fragment }),
      ],
    });
    const ledger = new SecretLedger([['member', secret]]);
    const prepared = prepareObservation(observation(tree), { redact: ledger.redact, redactCut: ledger.redactCut, maxBytes: 4_096 });
    assert(prepared.kind === 'semantic');

    expect(prepared.text.split('\n').slice(1)).toEqual([
      ' #n2 textbox "Token" value="<secret:member>" [focused]',
      ' #n3 textbox "Note" value="release approved" selection="approved"',
      ' #n4 textbox "Rich" text="key <secret:member>"',
    ]);
    expect(prepared.nodes.get('n2')?.selection).toBeUndefined();
    expect(prepared.nodes.get('n4')?.selection).toBeUndefined();
    expect(prepared.nodes.get('n3')?.selection).toBe('approved');
    expect(JSON.stringify(projectTree(prepared.tree, ledger.redact))).not.toContain(fragment);
  });

  it('withholds the selection of a field cut at its limit that may hold a secret the cut hides', () => {
    const secret = 'plain-secret-Kq7ZrT2mWx9pLd4sNv8bHc3jFg6yQa1eUo5iRk0tYw2zXn7u';
    const filler = 'lorem ipsum. '.repeat(50);
    const cut = (tail: string): string => `${filler.slice(0, OBSERVED_TEXT_LIMIT - tail.length)}${tail}`;
    const tree = node('n1', {
      children: [
        node('n2', { role: 'textbox', value: cut(secret.slice(0, 30)), selection: secret.slice(5, 25) }),
        node('n3', { role: 'textbox', value: cut(''), selection: secret.slice(5, 45) }),
        node('n4', { role: 'textbox', value: cut(''), selection: 'ipsum' }),
      ],
    });
    const ledger = new SecretLedger([['member', secret]]);
    const prepared = prepareObservation(observation(tree), { redact: ledger.redact, redactCut: ledger.redactCut, maxBytes: 4_096 });
    assert(prepared.kind === 'semantic');

    // The value ends in the start of the secret, cut short there.
    expect(prepared.nodes.get('n2')?.selection).toBeUndefined();
    // Nothing shown holds a secret, but the selection is not in what is shown: it came from the cut-off rest.
    expect(prepared.nodes.get('n3')?.selection).toBeUndefined();
    expect(prepared.nodes.get('n4')?.selection).toBe('ipsum');
    expect(prepared.text).not.toContain(secret.slice(13, 25));
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
        { redact: NO_REDACT, redactCut: NO_REDACT, maxBytes },
      );
      expect(prepared.bytes).toBeLessThanOrEqual(maxBytes);
      assert(prepared.kind === 'semantic');
    expect(prepared.truncated).toBe(true);
      expect(prepared.text).toContain('[observation truncated');
    }
  });
});

describe('observationShape', () => {
  const shapeOf = (text: string): string | undefined =>
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
  it('redacts names, text, values, selections, and attributes, and drops secure values, secure selections, and selectors', () => {
    const redact = (text: string): string => text.replaceAll('hunter2', '<password>');
    const tree = node('root', {
      role: 'document',
      children: [
        node('n1', {
          role: 'textbox',
          name: 'Password',
          value: 'hunter2',
          selection: 'hunter2',
          states: { secure: true, focused: true },
          selector: 'input[name=password]',
        }),
        node('n3', { role: 'textbox', value: 'hunter2 stays', selection: 'hunter2' }),
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
        { id: 'n3', role: 'textbox', value: '<password> stays', selection: '<password>' },
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
  const fast = { pollMs: 5, stableWaitMs: 30 };
  /** The pre-action shape and the window to leave it in. */
  const leaving = () => ({ shape: 'old', deadlineMs: Date.now() + 150 });

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
    const value = await settleObservation(source.capture, (v) => v, clock, { ...fast, changedFrom: leaving() });
    expect(value).toBe('new');
  });

  it('returns the unchanged screen once the change wait runs out', async () => {
    const source = scripted(['old']);
    const started = Date.now();
    const value = await settleObservation(source.capture, (v) => v, clock, { ...fast, changedFrom: leaving() });
    expect(value).toBe('old');
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it('never settles on a transitional capture while the change wait lasts', async () => {
    const source = scripted(['old', '', '', 'new', 'new']);
    const value = await settleObservation(source.capture, (v) => v, clock, {
      ...fast,
      changedFrom: leaving(),
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

  it('accepts a stable empty screen when no action is pending', async () => {
    const source = scripted(['', '', 'new']);
    const value = await settleObservation(source.capture, (v) => v, clock, {
      ...fast,
      transitional: (v) => v === '',
    });
    expect(value).toBe('');
    expect(source.calls()).toBe(2);
  });

  it('counts a slow first capture toward the change window, then still checks stability', async () => {
    vi.useFakeTimers();
    try {
      const started = Date.now();
      let captures = 0;
      const pending = settleObservation(async () => {
        captures += 1;
        await new Promise((resolve) => setTimeout(resolve, 400));
        return 'old';
      }, (value) => value, clock, {
        changedFrom: { shape: 'old', deadlineMs: started + 500 },
        stableWaitMs: 1_000,
        pollMs: 100,
      });
      await vi.runAllTimersAsync();
      expect(await pending).toBe('old');
      expect(Date.now() - started).toBe(1_400);
      expect(captures).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a fresh stability check when the action window expired before observation', async () => {
    vi.useFakeTimers();
    try {
      const started = Date.now();
      const source = scripted(['old', 'new', 'new']);
      const pending = settleObservation(source.capture, (value) => value, clock, {
        changedFrom: { shape: 'old', deadlineMs: started - 1 },
        stableWaitMs: 1_000,
        pollMs: 100,
      });
      await vi.runAllTimersAsync();
      expect(await pending).toBe('new');
      expect(Date.now() - started).toBe(200);
      expect(source.calls()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not treat matching empty navigation captures as stable after the action deadline', async () => {
    vi.useFakeTimers();
    try {
      const started = Date.now();
      const source = scripted(['', '', 'new', 'new']);
      const pending = settleObservation(source.capture, (value) => value, clock, {
        changedFrom: { shape: 'old', deadlineMs: started - 1 },
        transitional: (value) => value === '',
        stableWaitMs: 1_000,
        pollMs: 100,
      });
      await vi.runAllTimersAsync();
      expect(await pending).toBe('new');
      expect(Date.now() - started).toBe(300);
      expect(source.calls()).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the stability check when navigation stays empty after the action deadline', async () => {
    vi.useFakeTimers();
    try {
      const started = Date.now();
      const source = scripted(['']);
      const pending = settleObservation(source.capture, (value) => value, clock, {
        changedFrom: { shape: 'old', deadlineMs: started - 1 },
        transitional: (value) => value === '',
        stableWaitMs: 1_000,
        pollMs: 100,
      });
      await vi.runAllTimersAsync();
      expect(await pending).toBe('');
      expect(Date.now() - started).toBe(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles a changed canvas from matching permitted screenshots instead of waiting out both windows', async () => {
    vi.useFakeTimers();
    try {
      const started = Date.now();
      const prepare = (data: number) => prepareObservation({
        ...observation(node('root', { role: 'screen' }), {
          data: new Uint8Array([data]), mediaType: 'image/png', width: 1, height: 1, scale: 1,
        }),
        redaction: { secureNodeCount: 0, maskedRegionCount: 0 },
      }, { redact: NO_REDACT, redactCut: NO_REDACT, maxBytes: 4_096 });
      const before = prepare(1);
      const after = prepare(2);
      const capture = vi.fn(async () => after);
      const pending = settleObservation(capture, observationShape, clock, {
        changedFrom: { shape: changeShape(before)!, deadlineMs: started + 2_000 },
        changeShapeOf: changeShape,
        transitional: isTransitionalObservation,
        stableWaitMs: 1_000,
        pollMs: 100,
      });
      await vi.runAllTimersAsync();
      expect(await pending).toBe(after);
      expect(capture).toHaveBeenCalledTimes(2);
      expect(Date.now() - started).toBe(100);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('isTransitionalObservation', () => {
  it.each(['document', 'screen', 'window'])('recognizes an empty %s without treating a lone control as an empty screen', (role) => {
    const prepare = (tree: SemanticNode) => prepareObservation(observation(tree), { redact: NO_REDACT, redactCut: NO_REDACT, maxBytes: 4_096 });
    expect(isTransitionalObservation(prepare(node('root', { role })))).toBe(true);
    expect(isTransitionalObservation(prepare(node('root', { role: 'button', name: 'Continue' })))).toBe(false);
    expect(isTransitionalObservation(prepare(node('root', { role: 'textbox', name: 'Password', states: { secure: true } })))).toBe(false);
    expect(isTransitionalObservation(prepare(node('root', { role, children: [node('child', { role: 'text', text: 'Ready' })] })))).toBe(false);
    const unproven = observation(node('root', { role }), {
      data: new Uint8Array([1]), mediaType: 'image/png', width: 1, height: 1, scale: 1,
    });
    const withheld = prepareObservation(unproven, { redact: NO_REDACT, redactCut: NO_REDACT, maxBytes: 4_096 });
    expect(withheld.pixels).toBeUndefined();
    expect(isTransitionalObservation(withheld)).toBe(true);
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
