import { describe, expect, it } from 'vitest';
import type { Observation } from 'e2e-core/lib/engine/surface';
import { judgmentShape, prepareObservation } from 'e2e-core/lib/agent/observation';
import { buildPrompt, EXTRACT_REQUEST, JUDGMENT_REQUEST } from 'e2e-core/lib/agent/prompts';

const REDACT = (text: string): string => text.replaceAll('hunter2', '<secret:token>');

/** One capture at `location`, prepared as a judgment prepares it. */
function capture(location: string | undefined) {
  const root = { id: 'root', revision: 'r1' };
  const raw: Observation = {
    kind: 'semantic',
    root,
    truncated: false,
    revision: 'r1',
    capturedAt: '2026-01-01T00:00:00.000Z',
    tree: { ref: root, role: 'document' },
    viewport: { width: 800, height: 600 },
    redaction: { secureNodeCount: 0, maskedRegionCount: 0 },
    ...(location === undefined ? {} : { location }),
  };
  return prepareObservation(raw, { redact: REDACT, redactCut: REDACT, maxBytes: 4_096, appOrigin: 'https://app.test' });
}

/** The prompt for one capture at `location`, as a judgment builds it. */
function promptAt(location: string | undefined, options: { withholdTree?: boolean } = {}): string {
  return buildPrompt({ request: JUDGMENT_REQUEST, instruction: 'the URL path is /tasks', observation: capture(location), ...options });
}

/** What a wait compares for a capture at `location`. */
function shapeAt(location: string, treeWithheld = false): string | undefined {
  return judgmentShape(capture(location), { treeWithheld });
}

describe('buildPrompt', () => {
  it('names a location on the app as its path', () => {
    expect(promptAt('https://app.test/tasks')).toContain('<observation revision="r1" location="/tasks" viewport="800x600">');
  });

  it('keeps the origin off the app, so another site never reads as an app route', () => {
    expect(promptAt('https://idp.test/login')).toContain('location="https://idp.test/login"');
  });

  it('keeps the query and fragment, redacted, as the acting agent reads them', () => {
    const prompt = promptAt('https://app.test/tasks?status=active&token=hunter2#done');
    expect(prompt).toContain('location="/tasks?status=active&token=%3Csecret:token%3E#done"');
    expect(prompt).not.toContain('hunter2');
  });

  it('never shows userinfo', () => {
    const prompt = promptAt('https://user:pw@idp.test/cb');
    expect(prompt).toContain('location="https://idp.test/cb"');
    expect(prompt).not.toContain('user:pw');
  });

  it('keeps a location that is no http(s) URL as it is', () => {
    expect(promptAt('about:blank')).toContain('location="about:blank"');
    expect(promptAt('blob:https://other.test/x')).toContain('location="blob:https://other.test/x"');
    expect(promptAt('chrome-error://chromewebdata/')).toContain('location="chrome-error://chromewebdata/"');
  });

  it('cuts a long location, so a long query cannot overrun the request', () => {
    const prompt = promptAt(`https://app.test/tasks?state=${'a'.repeat(3_000)}`);
    expect(prompt).toContain('…" viewport');
    expect(prompt).not.toContain('a'.repeat(300));
  });

  it('cuts a long device location too', () => {
    const prompt = promptAt(`com.example / ${'x'.repeat(300)}`);
    expect(prompt).toContain('…" viewport');
    expect(prompt).not.toContain('x'.repeat(300));
  });

  it('leaves the attribute out when the engine reports no location', () => {
    expect(promptAt(undefined)).toContain('<observation revision="r1" viewport="800x600">');
  });

  it('keeps a location that is not a URL inside its attribute', () => {
    // A device reports `<app> / <screen title>`, and the title is the app's text.
    expect(promptAt('com.example / Say "hi"')).toContain(String.raw`location="com.example / Say \"hi\"" viewport`);
  });

  it('sends no location when the tree is withheld', () => {
    expect(promptAt('https://app.test/tasks', { withholdTree: true })).not.toContain('/tasks"');
  });

  it('tells a judgment and an extraction what the location is evidence for', () => {
    expect(JUDGMENT_REQUEST).toContain("The observation's location is the address of the screen: it is evidence only for an instruction about the address or route");
    expect(EXTRACT_REQUEST).toContain("The observation's location is the address of the screen: take a value from it only when the instruction asks about the address or route.");
  });
});

describe('judgmentShape', () => {
  it('ignores a clock in a device title, as the screen shape does', () => {
    expect(shapeAt('com.example / Recording 00:12')).toBe(shapeAt('com.example / Recording 00:13'));
    // A title alone, when the app is unknown, can parse as a URL with a `timer:` scheme.
    expect(shapeAt('Timer: 00:12')).toBe(shapeAt('Timer: 00:13'));
  });

  it('tells two addresses apart', () => {
    expect(shapeAt('https://app.test/a')).not.toBe(shapeAt('https://app.test/b'));
  });

  it('sees a time change in a URL, which names another page', () => {
    expect(shapeAt('https://app.test/at/10:15')).not.toBe(shapeAt('https://app.test/at/10:16'));
  });

  it('sees a change in the query', () => {
    expect(shapeAt('https://app.test/a?page=1')).not.toBe(shapeAt('https://app.test/a?page=2'));
  });

  it('sees no location change when the tree is withheld, since the judgment is not shown it', () => {
    expect(shapeAt('https://app.test/a', true)).toBe(shapeAt('https://app.test/b', true));
  });
});
