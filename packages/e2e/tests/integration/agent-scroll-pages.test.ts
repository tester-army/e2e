/** Scrolling to text reads each page once when it landed, and keeps reading when it may not have. */

import { describe, expect, it } from 'vitest';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { createFakeEngine, FAKE_APP, FAKE_APP_URL } from '../helpers/fake-engine.ts';
import { createProject, runExisting } from '../helpers/run-project.ts';
import type { ScriptedNode } from '../helpers/scripted-scene.ts';

const SUITE = `import { test } from 'e2e';
test('reaches the row', async ({ app, agent }) => {
  await app.open();
  await agent.act('reach the row');
});`;

const PER_PAGE = 3;

/** How a swipe turns the page: now, late, or through a thinner page first. */
type Turning = 'now' | 'late' | 'drawn-late' | 'never';

interface Paged {
  /** Engine observations between each swipe and the next one, the last one up to the end of the scroll. */
  readonly capturesPerPage: number[];
  readonly swipes: number;
  readonly error: string | undefined;
  readonly found: string | undefined;
}

function rowsOf(page: number, count = PER_PAGE): ScriptedNode[] {
  return Array.from({ length: count }, (_unused, at) => ({
    id: `row-${String(at)}`,
    role: 'listitem',
    text: `Row ${String(page * PER_PAGE + at)}`,
    rect: { x: 0, y: 20 + at * 40, width: 100, height: 40 },
  }));
}

/** A clock that reads a minute later on every capture, as one ticking on the screen does. */
function clockText(minute: number): string {
  return `12:${String(minute % 60).padStart(2, '0')}`;
}

async function scrollTo(text: string, turning: Turning, withClock = false): Promise<Paged> {
  let observations = 0;
  let page = 0;
  const atSwipe: number[] = [];
  const list: ScriptedNode = { id: 'list', role: 'list', name: 'Ledger', children: rowsOf(0) };
  const clock: ScriptedNode = { id: 'clock', role: 'status', name: 'Clock', text: clockText(0), rect: { x: 0, y: 0, width: 100, height: 20 } };
  const turn = (to: number, count = PER_PAGE) => {
    page = to;
    list.children = rowsOf(to, count);
  };
  const fake = createFakeEngine({
    actions: ['swipe'],
    observe: () => {
      observations += 1;
      clock.text = clockText(observations);
    },
    perform: (_ref, action) => {
      if (action.kind !== 'swipe') return;
      atSwipe.push(observations);
      const next = turning === 'never' ? page : page + 1;
      if (turning === 'now') turn(next);
      if (turning === 'late') setTimeout(() => turn(page + 1), 40);
      if (turning === 'drawn-late') {
        turn(next, 1);
        setTimeout(() => turn(next), 60);
      }
    },
    scene: () => (withClock ? [clock, list] : [list]),
  });
  let error: string | undefined;
  let found: string | undefined;
  let capturesPerPage: number[] = [];
  const executor: StepExecutor = {
    name: 'scroll-pages',
    async runStep(context) {
      await context.observe();
      try {
        await context.actions.scrollUntil(text, 'down');
        found = list.children?.map((row) => row.text).join(', ');
      } catch (cause) {
        error = (cause as { code?: string }).code;
      }
      const ends = [...atSwipe.slice(1), observations];
      capturesPerPage = ends.map((end, index) => end - atSwipe[index]!);
      return { status: 'passed', summary: 'scrolled' };
    },
  };
  const project = createProject({ 'tests/scroll.e2e.ts': SUITE });
  try {
    const outcome = await runExisting(project, {
      appUrl: FAKE_APP_URL,
      config: { tests: 'tests/**/*.e2e.ts', targets: [{ name: 'device', platform: 'ios' as const, engine: fake.engine, app: FAKE_APP }], agents: { default: { executor } } },
    });
    expect(outcome.exitCode, JSON.stringify(outcome.report.run.errors)).toBe(0);
  } finally {
    project.cleanup();
  }
  return { capturesPerPage, swipes: atSwipe.length, error, found };
}

describe('scroll_to a text, reads per page', () => {
  it('reads each page once when the swipe landed', async () => {
    const result = await scrollTo('Row 13', 'now');
    expect(result.error).toBeUndefined();
    expect(result.found).toContain('Row 13');
    expect(result.swipes).toBe(4);
    expect(result.capturesPerPage).toEqual([1, 1, 1, 1]);
  });

  it('keeps reading a page the swipe had not turned yet, and does not page past it', async () => {
    const result = await scrollTo('Row 7', 'late');
    expect(result.error).toBeUndefined();
    expect(result.found).toContain('Row 7');
    expect(result.swipes).toBe(2);
    expect(result.capturesPerPage.every((captures) => captures >= 2)).toBe(true);
  });

  it('keeps reading a windowed list that draws its rows after the scroll', async () => {
    const result = await scrollTo('Row 4', 'drawn-late');
    expect(result.error).toBeUndefined();
    expect(result.found).toContain('Row 4');
    expect(result.swipes).toBe(1);
    expect(result.capturesPerPage[0]).toBeGreaterThanOrEqual(2);
  });

  it('still ends a list that stops moving with LOCATOR_NOT_FOUND', async () => {
    const result = await scrollTo('Row 99', 'never');
    expect(result.error).toBe('LOCATOR_NOT_FOUND');
    expect(result.swipes).toBe(3);
  });

  describe('with a clock ticking on the screen', () => {
    it('reads each page once when the swipe landed', async () => {
      const result = await scrollTo('Row 13', 'now', true);
      expect(result.error).toBeUndefined();
      expect(result.found).toContain('Row 13');
      expect(result.swipes).toBe(4);
      expect(result.capturesPerPage).toEqual([1, 1, 1, 1]);
    });

    it('does not take the tick for a turned page, and does not page past the row', async () => {
      const result = await scrollTo('Row 4', 'late', true);
      expect(result.error).toBeUndefined();
      expect(result.found).toContain('Row 4');
      expect(result.swipes).toBe(1);
      expect(result.capturesPerPage.every((captures) => captures >= 2)).toBe(true);
    });

    it('still ends a list that stops moving with LOCATOR_NOT_FOUND, not at the screen cap', async () => {
      const result = await scrollTo('Row 99', 'never', true);
      expect(result.error).toBe('LOCATOR_NOT_FOUND');
      expect(result.swipes).toBe(3);
    });
  });
});
