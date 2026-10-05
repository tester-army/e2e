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
import { compareScreens } from '../../src/run/step-screens.ts';
import { StepRecorder } from '../../src/run/steps.ts';

const screen = (...lines: string[]) => ({ location: 'http://app.test/todos', text: lines.join('\n') });

describe('compareScreens', () => {
  it('tells a first screen by its size and where it was', () => {
    expect(compareScreens(undefined, screen('#root document "Todos"', ' #n2 button "Add"'))).toEqual({ location: 'http://app.test/todos', nodes: 2, changes: [] });
  });

  it('pairs a node by id as changed, and by text where ids are new, leaving focus out', () => {
    const before = screen('#root document', ' #n2 textbox "New todo" [focused]', ' #n3 button "Add"', ' #n4 text="0 left"');
    const after = screen('#root document', ' #n2 textbox "New todo" value="Milk"', ' #n9 button "Add" [focused]', ' #n10 listitem "Milk"');
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

describe('StepRecorder.recordAppLog info', () => {
  it('counts info apart, so chatter past its cap never crowds out an error', async () => {
    const steps = new StepRecorder('attempt');
    await steps.run('app', 'app.open', '/', async () => {
      for (let index = 0; index < 150; index += 1) steps.recordAppLog({ source: 'console', level: 'info', text: `tick ${index}` });
      steps.recordAppLog({ source: 'console', level: 'error', text: 'boom' });
    });
    const events = steps.all()[0]!.events;
    expect(events.filter((event) => event.level === 'info')).toHaveLength(100);
    expect(events.at(-1)).toMatchObject({ level: 'error', detail: 'boom' });
  });
});

describe('the session screen route and environment', () => {
  const snapshot = (name: string): EngineSnapshot => ({
    root: { ref: { id: 'root', revision: '' }, role: 'document', children: [{ ref: { id: 'n1', revision: '' }, role: 'button', name }] },
    viewport: { width: 390, height: 844 },
    location: 'com.example.app',
  });

  it('hands every engine screen to the routed sink as a semantic observation, and drops malformed ones', () => {
    const session = createEngineSession({ engine: undefined, targetName: 'phone' });
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

  it('merges environment facts, overwriting a name, dropping non-strings, and keeping a handful, clipped', () => {
    const session = createEngineSession({ engine: undefined, targetName: 'web' });
    session.environment.push({ browser: 'chromium 140' });
    session.environment.push({ browser: 'chromium 141', count: 3 as unknown as string, 'user agent': `Mozilla ${'x'.repeat(300)}` });
    for (let index = 0; index < 10; index += 1) session.environment.push({ [`fact ${index}`]: 'yes' });
    const facts = session.environment.read();
    expect(facts.browser).toBe('chromium 141');
    expect(facts).not.toHaveProperty('count');
    expect(facts['user agent']).toHaveLength(200);
    expect(Object.keys(facts)).toHaveLength(8);
  });
});
