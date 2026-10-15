/**
 * Step screens: each step keeps how the last screen it saw differs from the
 * one the step before saw, by node id where a browser keeps ids and by text
 * where a device mints new ones, focus left out, bounded; and the session
 * hands the trace every screen an engine reports, dropping malformed ones.
 */

import { describe, expect, it } from 'vitest';
import { createEngineSession } from '../../src/engine/session.ts';
import type { EngineSnapshot } from '../../src/engine/index.ts';
import type { Observation } from '../../src/engine/surface.ts';
import type { SessionSecrecy } from '../../src/run/secrecy.ts';
import { compareScreens, traceScreen } from '../../src/run/step-screens.ts';
import { StepRecorder } from '../../src/run/steps.ts';

/** A screen from listing-like lines, `#id description` each; the description is what the trace compares. */
const screen = (...lines: string[]) => ({
  location: 'http://app.test/todos',
  lines: lines.flatMap((line) => line.split('\n')).map((line) => {
    const [id, ...rest] = line.trim().split(' ');
    return { id: id!.slice(1), text: rest.join(' ') };
  }),
});

describe('compareScreens', () => {
  it('tells a first screen by its size and where it was', () => {
    expect(compareScreens(undefined, screen('#root document "Todos"', ' #n2 button "Add"'))).toEqual({ location: 'http://app.test/todos', nodes: 2, changes: [] });
  });

  it('pairs a node by id as changed, and by text where ids are new', () => {
    const before = screen('#root document', ' #n2 textbox "New todo"', ' #n3 button "Add"', ' #n4 text="0 left"');
    const after = screen('#root document', ' #n2 textbox "New todo" value="Milk"', ' #n9 button "Add"', ' #n10 listitem "Milk"');
    expect(compareScreens({ step: 1, screen: before }, after)).toMatchObject({
      since: 1,
      nodes: 4,
      changes: ['changed textbox "New todo" value="Milk" (was: textbox "New todo")', 'added listitem "Milk"', 'removed text="0 left"'],
    });
  });

  it('reads an unchanged screen as no changes, and counts the changes past its bound', () => {
    const lines = ['#root document', ...Array.from({ length: 20 }, (_, index) => ` #a${index} button "Item ${index}"`)];
    expect(compareScreens({ step: 0, screen: screen(...lines) }, screen(...lines)).changes).toEqual([]);
    const grown = compareScreens({ step: 0, screen: screen('#root document') }, screen(...lines));
    expect(grown.changes).toHaveLength(12);
    expect(grown.more).toBe(8);
  });
});

describe('traceScreen', () => {
  const secrecy = { ledger: { redact: (text: string) => text.replaceAll('hunter2', '<secret:pw>'), redactCut: (text: string) => text } } as unknown as SessionSecrecy;
  const observed = (tree: Extract<Observation, { kind: 'semantic' }>['tree']): Observation => ({
    kind: 'semantic',
    root: tree.ref,
    revision: 'r1',
    capturedAt: '2026-01-01T00:00:00.000Z',
    location: 'http://app.test/hunter2',
    viewport: { width: 1, height: 1 },
    redaction: { secureNodeCount: 0, maskedRegionCount: 0 },
    tree,
    truncated: false,
  });

  it('describes each node as its line reads, without the id or focus, redacted, in screen order', () => {
    const kept = traceScreen(
      observed({
        ref: { id: 'root', revision: 'r1' },
        role: 'document',
        children: [{ ref: { id: 'n2', revision: 'r1' }, role: 'textbox', name: 'Password hint', value: 'hunter2', states: { focused: true, disabled: true } }],
      }),
      { secrecy, maxBytes: 10_000, appOrigin: undefined },
    );
    expect(kept).toEqual({
      location: 'http://app.test/<secret:pw>',
      lines: [
        { id: 'root', text: 'document' },
        { id: 'n2', text: 'textbox "Password hint" value="<secret:pw>" [disabled]' },
      ],
    });
  });

  it('counts its budget in UTF-8 bytes, so a screen in another script is bounded the same', () => {
    const children = Array.from({ length: 50 }, (_, index) => ({ ref: { id: `n${index}`, revision: 'r1' }, role: 'button', name: `購入する商品${index}` }));
    const kept = traceScreen(observed({ ref: { id: 'root', revision: 'r1' }, role: 'document', children }), { secrecy, maxBytes: 200, appOrigin: undefined });
    const bytes = kept!.lines.reduce((total, line) => total + Buffer.byteLength(line.text, 'utf8') + 1, 0);
    expect(bytes).toBeLessThanOrEqual(200);
    expect(kept!.lines.length).toBeGreaterThan(1);
  });

  it('stops at its byte budget, keeping at least the root', () => {
    const children = Array.from({ length: 50 }, (_, index) => ({ ref: { id: `n${index}`, revision: 'r1' }, role: 'button', name: `Item ${index}` }));
    const kept = traceScreen(observed({ ref: { id: 'root', revision: 'r1' }, role: 'document', children }), { secrecy, maxBytes: 60, appOrigin: undefined });
    expect(kept!.lines.length).toBeGreaterThan(1);
    expect(kept!.lines.length).toBeLessThan(10);
  });
});

describe('StepRecorder.recordScreen', () => {
  it("compares each step's last screen with the step before's, reads it once at the step's end, and ignores a screen outside a step", async () => {
    const steps = new StepRecorder('attempt');
    let reads = 0;
    const seen = (text: string) => () => {
      reads += 1;
      return screen(text);
    };
    steps.recordScreen(seen('#root document'));
    await steps.run('app', 'app.open', '/', async () => {
      steps.recordScreen(seen('#root document\n #n2 button "Old"'));
      steps.recordScreen(seen('#root document\n #n2 button "Add"'));
    });
    await steps.run('assertion', 'expect.toBeVisible', 'x', async () => undefined);
    await steps.run('screen', 'locator.tap', 'Add', async () => {
      steps.recordScreen(seen('#root document\n #n2 button "Add"\n #n3 listitem "Milk"'));
    });
    const [open, look, tap] = steps.all();
    expect(reads).toBe(2);
    expect(open!.screen).toEqual({ location: 'http://app.test/todos', nodes: 2, changes: [] });
    expect(look!.screen).toBeUndefined();
    expect(tap!.screen).toMatchObject({ since: 0, changes: ['added listitem "Milk"'] });
  });
});

describe('the session screen route and environment', () => {
  const snapshot = (name: string): EngineSnapshot => ({
    root: { ref: { id: 'root', revision: '' }, role: 'document', children: [{ ref: { id: 'n1', revision: '' }, role: 'button', name }] },
    viewport: { width: 390, height: 844 },
    location: 'com.example.app',
  });

  it('hands every engine screen to the routed sink as a semantic observation, and drops malformed ones', () => {
    const session = createEngineSession({ engine: undefined, targetName: 'phone', traced: true });
    const heard: Observation[] = [];
    session.screens.push(snapshot('before any sink'));
    session.screens.route((observation) => heard.push(observation));
    session.screens.push(snapshot('Add'));
    session.screens.push({ viewport: { width: 1, height: 1 } } as unknown as EngineSnapshot);
    session.screens.push({ ...snapshot('hidden'), treeUnavailable: true });
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ kind: 'semantic', location: 'com.example.app', revision: 's1' });
    session.screens.route(undefined);
    session.screens.push(snapshot('after'));
    expect(heard).toHaveLength(1);
  });

  it('takes no screen at all for an attempt that keeps no trace', () => {
    const session = createEngineSession({ engine: undefined, targetName: 'phone' });
    const heard: Observation[] = [];
    session.screens.route((observation) => heard.push(observation));
    session.screens.push(snapshot('Add'));
    expect(session.screens.traced).toBe(false);
    expect(heard).toEqual([]);
  });

  it('merges environment facts, overwriting a name, dropping non-strings, and keeping a handful, redacted before they are clipped', () => {
    const session = createEngineSession({ engine: undefined, targetName: 'web' });
    expect(session.environment.read((text) => text)).toBeUndefined();
    session.environment.push({ browser: 'chromium 140' });
    // A secret that straddles the value's clip: redacted whole first, so no head of it is left.
    session.environment.push({ browser: 'chromium 141', count: 3 as unknown as string, 'user agent': `Mozilla ${'x'.repeat(190)}hunter2-secret` });
    for (let index = 0; index < 10; index += 1) session.environment.push({ [`fact ${index}`]: 'yes' });
    const facts = session.environment.read((text) => text.replaceAll('hunter2-secret', '<secret:ua>'))!;
    expect(facts.browser).toBe('chromium 141');
    expect(facts).not.toHaveProperty('count');
    expect(facts['user agent']).toHaveLength(200);
    expect(facts['user agent']).not.toContain('hu');
    expect(Object.keys(facts)).toHaveLength(8);
  });

  it('redacts a secret longer than anything held before, whole', () => {
    const session = createEngineSession({ engine: undefined, targetName: 'web' });
    const secret = `sk-${'z'.repeat(6000)}`;
    session.environment.push({ token: secret });
    const facts = session.environment.read((text) => text.replaceAll(secret, '<secret:token>'))!;
    expect(facts['token']).toBe('<secret:token>');
  });
});
