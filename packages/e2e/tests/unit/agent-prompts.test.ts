import { describe, expect, it } from 'vitest';
import type { Observation } from '../../src/engine/surface.ts';
import { locationShape, prepareObservation } from '../../src/agent/observation.ts';
import { buildPrompt } from '../../src/agent/prompts.ts';

const REDACT = (text: string): string => text.replaceAll('hunter2', '<secret:token>');

/** The prompt for one capture at `location`, as a judgment builds it. */
function promptAt(location: string | undefined, options: { withholdTree?: boolean; appOrigin?: string } = {}): string {
  return buildPrompt({ request: 'judge', instruction: 'the URL path is /tasks', observation: capture(location), ...options });
}

/** One capture at `location`. */
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
  return prepareObservation(raw, { redact: REDACT, redactCut: REDACT, maxBytes: 4_096 });
}

const APP = { appOrigin: 'https://app.test' };

describe('buildPrompt', () => {
  it('names a location on the app as its path', () => {
    expect(promptAt('https://app.test/tasks', APP)).toContain('<observation revision="r1" location="/tasks" viewport="800x600">');
  });

  it('keeps the origin off the app, so another site never reads as an app route', () => {
    expect(promptAt('https://idp.test/login', APP)).toContain('location="https://idp.test/login"');
  });

  it('keeps the query and fragment, redacted, as the acting agent reads them', () => {
    const prompt = promptAt('https://app.test/tasks?status=active&token=hunter2#done', APP);
    expect(prompt).toContain('location="/tasks?status=active&token=%3Csecret:token%3E#done"');
    expect(prompt).not.toContain('hunter2');
  });

  it('never shows userinfo', () => {
    const prompt = promptAt('https://user:pw@idp.test/cb', APP);
    expect(prompt).toContain('location="https://idp.test/cb"');
    expect(prompt).not.toContain('user:pw');
  });

  it('keeps a location that is no http(s) URL as it is', () => {
    expect(promptAt('about:blank', APP)).toContain('location="about:blank"');
    expect(promptAt('blob:https://other.test/x', APP)).toContain('location="blob:https://other.test/x"');
    expect(promptAt('chrome-error://chromewebdata/', APP)).toContain('location="chrome-error://chromewebdata/"');
  });

  it('cuts a long location, so a long query cannot overrun the request', () => {
    const prompt = promptAt(`https://app.test/tasks?state=${'a'.repeat(3_000)}`, APP);
    expect(prompt).toContain('…" viewport');
    expect(prompt.length).toBeLessThan(600);
  });

  it('leaves the attribute out when the engine reports no location', () => {
    expect(promptAt(undefined)).toContain('<observation revision="r1" viewport="800x600">');
  });

  it('keeps a location that is not a URL inside its attribute', () => {
    // A device reports `<app> / <screen title>`, and the title is the app's text.
    expect(promptAt('com.example / Say "hi"')).toContain(String.raw`location="com.example / Say \"hi\"" viewport`);
  });

  it('sends no location when the tree is withheld', () => {
    expect(promptAt('https://app.test/tasks', { ...APP, withholdTree: true })).not.toContain('/tasks"');
  });
});

describe('locationShape', () => {
  it('ignores a clock in a device title, as the screen shape does', () => {
    expect(locationShape(capture('com.example / Recording 00:12'))).toBe(locationShape(capture('com.example / Recording 00:13')));
  });

  it('tells two addresses apart', () => {
    expect(locationShape(capture('https://app.test/a'))).not.toBe(locationShape(capture('https://app.test/b')));
  });

  it('sees a change in the query', () => {
    expect(locationShape(capture('https://app.test/a?page=1'))).not.toBe(locationShape(capture('https://app.test/a?page=2')));
  });
});
