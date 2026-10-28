import { createServer, type Server } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActPosition, StepExecutor, StepExecutorContext } from '../../src/index.ts';
import { createProject, resultByTitle, runExisting, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';
import { readEntries } from '../helpers/trace-cache.ts';
import { assertValidReport } from '../helpers/report-schema.ts';

const FILE = 'tests/inbox.e2e.ts';
const TITLE = 'open an inbox item';

/** A stable test identity for positional replay and optional action observers. */
function source(position?: ActPosition, expectedStatus = 'Opened', observeActions = false): string {
  const observers = observeActions ? `,
    onBeforeAction: async ({ index, source }) => {
      await expect(screen.getByRole('status')).toHaveText(index === 1 ? 'Waiting' : 'Ready');
      await app.screenshot(\`before \${index} \${source}\`);
    },
    onAction: async ({ index }) => {
      await expect(screen.getByRole('status')).toHaveText(index === 1 ? 'Ready' : 'Opened');
    }` : '';
  return `import { test, expect } from 'e2e';
test('${TITLE}', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('prepare the inbox and open an item', { ...${JSON.stringify(position === undefined ? {} : { position })}${observers} });
  await expect(screen.getByRole('status')).toHaveText(${JSON.stringify(expectedStatus)});
});`;
}

/** Capture synchronous input effects before an intentionally failed step closes its page. */
function pointSource(): string {
  return `import { test } from '@e2e-dev/web';
import { writeFileSync } from 'node:fs';
test('${TITLE}', async ({ app, agent, browser }) => {
  await app.open();
  try {
    await agent.act('open the first inbox item', { position: { testId: 'inbox-item', at: 'first' } });
  } finally {
    const effects = await browser.evaluate(() => ({
      selected: Reflect.get(window, 'pointSelected'), hovered: Reflect.get(window, 'pointHovered'),
    }));
    writeFileSync(new URL('../point-input.json', import.meta.url), JSON.stringify(effects));
  }
});`;
}

/** The agent step's replay result, separate from the subsequent live assertion. */
function cacheInfo(outcome: RunOutcome) {
  return resultByTitle(outcome, TITLE).attempts.at(-1)!.steps.find((step) => step.api === 'agent.act')!.cache;
}

describe('explicit positional replay through the built runner', () => {
  let server: Server;
  let url: string;
  let items: string[];
  let selected: string | undefined;
  let showTitle = false;
  let trackPoints = false;
  let remount: 'hover' | 'prepare' | undefined;
  let replacementItems = ['Gamma', 'Delta', 'Epsilon'];

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url?.startsWith('/selected?') === true) {
        selected = new URL(request.url, 'http://fixture.test').searchParams.get('title')!;
        response.end('ok');
        return;
      }
      const rows = (titles: readonly string[]) => titles.map((title) => `<li><span>${title}</span><div tabindex="0" role="group" data-testid="inbox-item" data-title="${title}">Open</div></li>`).join('');
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><html lang="en"><title>Inbox</title><body>
        <h1>Your inbox</h1><button data-testid="prepare">Prepare</button>
        <div draggable="true" role="button" aria-label="Card" data-testid="card">Card</div>
        <ul>${rows(items)}</ul>
        <p role="status">Waiting</p><script>
        if (${JSON.stringify(trackPoints)}) { window.pointSelected = null; window.pointHovered = null; }
        let remounted = false;
        function remountRows() {
          if (remounted) return;
          remounted = true;
          document.querySelector('ul').innerHTML = ${JSON.stringify(rows(replacementItems))};
          bindRows();
        }
        document.querySelector('button').onclick = () => {
          document.querySelector('[role="status"]').textContent = 'Ready';
          if (${JSON.stringify(remount)} === 'prepare') remountRows();
        };
        document.querySelector('[data-testid="card"]').ondragstart = (event) => event.dataTransfer.setData('text/plain', 'card');
        function bindRows() { document.querySelectorAll('[data-testid="inbox-item"]').forEach((row) => {
          if (${JSON.stringify(remount)} === 'hover') row.onpointerenter = remountRows;
          else if (${JSON.stringify(trackPoints)}) row.onpointerenter = () => { window.pointHovered = row.dataset.title; };
          row.ondragover = (event) => event.preventDefault();
          row.onclick = row.ondrop = async (event) => {
          event.preventDefault();
          if (${JSON.stringify(trackPoints)}) window.pointSelected = row.dataset.title;
          await fetch('/selected?title=' + encodeURIComponent(row.dataset.title));
          document.querySelector('ul').remove();
          document.querySelector('[role="status"]').textContent = ${showTitle ? "'Opened ' + row.dataset.title" : "'Opened'"};
        }; }); } bindRows();</script></body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('fixture did not bind a port');
    url = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  });

  /** An executor that performs an unrelated action before selecting its requested row. */
  function executor(at: 'first' | 'last', calls: { count: number }): StepExecutor {
    return {
      name: 'positional-inbox',
      async runStep(context: StepExecutorContext) {
        calls.count += 1;
        if (context.replayedPrefix?.replayedActions.length === 2) return { status: 'passed', summary: 'The replay opened the item' };
        const initial = await context.observe();
        const prepare = /#(\S+) button "Prepare"/u.exec(initial.text)?.[1];
        if (prepare === undefined) throw new Error('Prepare button missing');
        await context.actions.tap({ id: prepare });
        const observation = await context.observe();
        const rows = observation.text.split('\n').filter((line) => line.includes('testid="inbox-item"'));
        const row = at === 'first' ? rows[0] : rows.at(-1);
        const id = row === undefined ? undefined : /#(\S+)/u.exec(row)?.[1];
        if (id === undefined) throw new Error('No inbox item');
        await context.actions.tap({ id });
        return { status: 'passed', summary: 'Opened an inbox item' };
      },
    };
  }

  /** A second action addresses the old screen after an unrelated control replaces its rows. */
  function batchedExecutor(action: 'tap' | 'drag'): StepExecutor {
    return {
      name: 'batched-remount',
      async runStep(context) {
        const observation = await context.observe();
        const prepare = /#(\S+) button "Prepare"/u.exec(observation.text)?.[1];
        const card = /#(\S+) button "Card"/u.exec(observation.text)?.[1];
        const row = observation.text.split('\n').findLast((line) => line.includes('testid="inbox-item"'));
        const id = row === undefined ? undefined : /#(\S+)/u.exec(row)?.[1];
        if (prepare === undefined || card === undefined || id === undefined) throw new Error('Fixture nodes missing');
        await context.actions.tap({ id: prepare });
        await context.observe();
        if (action === 'tap') await context.actions.tap({ id });
        else await context.actions.drag({ id: card }, { id });
        return { status: 'passed', summary: 'Opened the current last item' };
      },
    };
  }

  /** Run against the current inbox with a fresh browser and the same recording directory. */
  function run(project: FixtureProject, brain: StepExecutor, strict = false, maxObservationBytes?: number) {
    selected = undefined;
    return runExisting(project, { appUrl: url, config: {
      tests: 'tests/*.e2e.ts', agents: { default: { executor: brain, ...(maxObservationBytes === undefined ? {} : { maxObservationBytes }) } },
      cache: { mode: 'read-write', strict }, timeout: 8_000,
    } });
  }

  it.each(['first', 'last'] as const)('records and replays %s across list changes without invoking the executor', async (at) => {
    const calls = { count: 0 };
    const brain = executor(at, calls);
    const project = createProject({ [FILE]: source({ testId: 'inbox-item', at }, 'Opened', true) });
    const captures = (outcome: RunOutcome) => resultByTitle(outcome, TITLE).attempts.at(-1)!.steps
      .filter(step => step.api === 'app.screenshot').map(step => step.label);
    try {
      items = ['Alpha', 'Beta'];
      const recorded = await run(project, brain);
      expect(recorded.exitCode).toBe(0);
      expect(captures(recorded)).toEqual(['before 1 model', 'before 2 model']);
      expect(calls.count).toBe(1);
      const [recording] = readEntries(project);
      expect(recording!.entry.payload.actions).toMatchObject([
        { name: 'tap', target: { testId: 'prepare', name: 'Prepare' } },
        { name: 'tap', target: { role: 'group', testId: 'inbox-item', ordinal: at } },
      ]);
      expect(recording!.entry.payload.actions[1]).toHaveProperty('target.ordinal', at);
      expect(recording!.entry.payload.recordedFor?.positionDigest).toMatch(/^[a-f0-9]{64}$/u);
      for (const next of [['Gamma', 'Delta', 'Epsilon'], ['Only'], ['Epsilon', 'Alpha', 'Beta', 'Gamma']]) {
        items = next;
        const replay = await run(project, brain, true);
        expect(replay.exitCode).toBe(0);
        expect(captures(replay)).toEqual(['before 1 replay', 'before 2 replay']);
        expect(cacheInfo(replay)).toMatchObject({ mode: 'self-finalized', replayedActions: 2 });
        expect(selected).toBe(at === 'first' ? next[0] : next.at(-1));
        expect(calls.count).toBe(1);
        assertValidReport(replay.report);
      }
    } finally {
      project.cleanup();
    }
  }, 90_000);

  it.each(['first', 'last'] as const)('retains %s intent when the row remounts before input', async (at) => {
    const project = createProject({ [FILE]: source({ testId: 'inbox-item', at }) });
    try {
      items = ['Alpha', 'Beta'];
      remount = 'hover';
      const outcome = await run(project, executor(at, { count: 0 }));
      expect(resultByTitle(outcome, TITLE).attempts.at(-1)!.error).toBeUndefined();
      expect(outcome.exitCode).toBe(0);
      expect(selected).toBe(at === 'first' ? 'Gamma' : 'Epsilon');
      const step = resultByTitle(outcome, TITLE).attempts.at(-1)!.steps.find((entry) => entry.api === 'agent.act')!;
      expect(step.events.some((event) => event.kind === 'observation' && event.name === 'relocate')).toBe(true);
      expect(step.metrics!.actionSteps).toBe(2);
    } finally {
      remount = undefined;
      project.cleanup();
    }
  }, 30_000);

  it.each(['tap', 'drag'] as const)('re-finds an old positional %s target after another action remounts the list', async (action) => {
    const project = createProject({ [FILE]: source({ testId: 'inbox-item', at: 'last' }) });
    const brain = batchedExecutor(action);
    try {
      items = ['Alpha', 'Beta'];
      remount = 'prepare';
      const outcome = await run(project, brain);
      expect(resultByTitle(outcome, TITLE).attempts.at(-1)!.error).toBeUndefined();
      expect(outcome.exitCode).toBe(0);
      expect(selected).toBe('Epsilon');
    } finally {
      remount = undefined;
      project.cleanup();
    }
  }, 30_000);

  it.each(['hover', 'tap', 'drag'] as const)('refuses an incomplete remounted list during %s without selecting a row', async (mode) => {
    const project = createProject({ [FILE]: source({ testId: 'inbox-item', at: mode === 'hover' ? 'first' : 'last' }) });
    try {
      items = ['Alpha', 'Beta'];
      remount = mode === 'hover' ? 'hover' : 'prepare';
      replacementItems = Array.from({ length: 60 }, (_, index) => `Message ${index}`);
      const brain = mode === 'hover' ? executor('first', { count: 0 }) : batchedExecutor(mode);
      const outcome = await run(project, brain, false, 1_024);
      expect(outcome.exitCode).not.toBe(0);
      expect(resultByTitle(outcome, TITLE).attempts.at(-1)!.error?.code).toBe('POLICY_DENIED');
      expect(selected).toBeUndefined();
      expect(readEntries(project)).toHaveLength(0);
    } finally {
      remount = undefined;
      replacementItems = ['Gamma', 'Delta', 'Epsilon'];
      project.cleanup();
    }
  }, 30_000);

  it('tells the executor about the edge before any input', async () => {
    const project = createProject({ [FILE]: source({ testId: 'inbox-item', at: 'first' }) });
    const base = executor('first', { count: 0 });
    const brain: StepExecutor = {
      name: 'edge-instruction',
      async runStep(context) {
        expect(context.step.instruction).toContain('For controls with test ID "inbox-item", choose the current first match');
        return base.runStep(context);
      },
    };
    try {
      items = ['Alpha', 'Beta'];
      expect((await run(project, brain)).exitCode).toBe(0);
      expect(selected).toBe('Alpha');
    } finally {
      project.cleanup();
    }
  }, 30_000);

  it('isolates ordinary, first, last and another test-id hint in one cache', async () => {
    const calls = { count: 0 };
    const project = createProject({ [FILE]: source() });
    try {
      items = ['Alpha', 'Beta'];
      for (const position of [undefined, { testId: 'inbox-item', at: 'first' as const }, { testId: 'inbox-item', at: 'last' as const }, { testId: 'other-item', at: 'first' as const }]) {
        writeFileSync(path.join(project.dir, FILE), source(position));
        const brain = executor(position?.at ?? 'first', calls);
        const before = calls.count;
        const cold = await run(project, brain, true);
        expect(cold.exitCode).toBe(0);
        expect(cacheInfo(cold)).toMatchObject({ mode: 'missed', reason: 'no-entry' });
        expect(calls.count).toBe(before + 1);
        expect((await run(project, brain)).exitCode).toBe(0);
        expect((await run(project, brain, true)).exitCode).toBe(0);
        expect(calls.count).toBe(before + 2);
      }
      expect(readEntries(project)).toHaveLength(4);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('hands off an empty list without selecting a row', async () => {
    const calls = { count: 0 };
    const brain = executor('first', calls);
    const project = createProject({ [FILE]: source({ testId: 'inbox-item', at: 'first' }) });
    try {
      items = ['Alpha', 'Beta'];
      expect((await run(project, brain)).exitCode).toBe(0);
      items = [];
      const missing = await run(project, brain, true);
      expect(missing.exitCode).not.toBe(0);
      expect(cacheInfo(missing)).toMatchObject({ reason: 'target-not-found', replayedActions: 1 });
      expect(calls.count).toBe(1);
      expect(selected).toBeUndefined();
    } finally {
      project.cleanup();
    }
  }, 45_000);

  it('refuses a live selection that contradicts the requested edge before clicking it', async () => {
    const project = createProject({ [FILE]: source({ testId: 'inbox-item', at: 'first' }) });
    try {
      items = ['Alpha', 'Beta'];
      const wrong = await run(project, executor('last', { count: 0 }));
      expect(wrong.exitCode).not.toBe(0);
      expect(resultByTitle(wrong, TITLE).attempts.at(-1)!.error?.code).toBe('ACTION_FAILED');
      expect(selected).toBeUndefined();
      expect(readEntries(project)).toHaveLength(0);
    } finally {
      project.cleanup();
    }
  }, 30_000);

  it('refuses live and cached edge selection from truncated observations', async () => {
    const calls = { count: 0 };
    const brain = executor('first', calls);
    const position: ActPosition = { testId: 'inbox-item', at: 'first' };
    const project = createProject({ [FILE]: source(position) });
    const fresh = createProject({ [FILE]: source(position) });
    try {
      items = ['Alpha', 'Beta'];
      expect((await run(project, brain)).exitCode).toBe(0);
      items = Array.from({ length: 60 }, (_, index) => `Message ${index}`);
      const cached = await run(project, brain, true, 1_024);
      expect(cached.exitCode).not.toBe(0);
      expect(calls.count).toBe(1);
      expect(selected).toBeUndefined();
      const live = await run(fresh, brain, false, 1_024);
      expect(live.exitCode).not.toBe(0);
      expect(resultByTitle(live, TITLE).attempts.at(-1)!.error?.code).toBe('POLICY_DENIED');
      expect(selected).toBeUndefined();
      expect(readEntries(fresh)).toHaveLength(0);
    } finally {
      project.cleanup();
      fresh.cleanup();
    }
  }, 45_000);

  it.each([['tapAt', false], ['hoverAt', false], ['tapAt', true], ['hoverAt', true]] as const)('validates the edge before %s sends point input (truncated=%s)', async (verb, truncated) => {
    const project = createProject({ [FILE]: pointSource() });
    const brain: StepExecutor = {
      name: 'wrong-point',
      async runStep(context) {
        const observation = await context.observe({ tree: true });
        const row = observation.text.split('\n').findLast(line => line.includes('testid="inbox-item"'));
        const id = row === undefined ? undefined : /#(\S+)/u.exec(row)?.[1];
        const pending = observation.tree === undefined ? [] : [observation.tree];
        while (pending.length > 0) {
          const node = pending.pop()!;
          if (node.id === id && node.rect !== undefined) {
            await context.actions[verb]({ x: node.rect.x + node.rect.width * 0.75, y: node.rect.y + node.rect.height / 2 });
            return { status: 'passed', summary: 'Acted on the row' };
          }
          pending.push(...node.children ?? []);
        }
        throw new Error('Point fixture row missing');
      },
    };
    try {
      items = truncated ? Array.from({ length: 60 }, (_, index) => `Message ${index}`) : ['Alpha', 'Beta'];
      trackPoints = true;
      const outcome = await run(project, brain, false, truncated ? 1_024 : undefined);
      expect(outcome.exitCode).not.toBe(0);
      expect(resultByTitle(outcome, TITLE).attempts.at(-1)!.error?.code).toBe(truncated ? 'POLICY_DENIED' : 'ACTION_FAILED');
      expect(JSON.parse(readFileSync(path.join(project.dir, 'point-input.json'), 'utf8'))).toEqual({ selected: null, hovered: null });
      expect(readEntries(project)).toHaveLength(0);
    } finally {
      trackPoints = false;
      project.cleanup();
    }
  }, 30_000);

  it('validates the drag destination before sending input', async () => {
    const project = createProject({ [FILE]: source({ testId: 'inbox-item', at: 'first' }) });
    const brain: StepExecutor = {
      name: 'wrong-drop',
      async runStep(context) {
        const observation = await context.observe();
        const card = /#(\S+) button "Card"/u.exec(observation.text)?.[1];
        const row = observation.text.split('\n').findLast((line) => line.includes('testid="inbox-item"'));
        const destination = row === undefined ? undefined : /#(\S+)/u.exec(row)?.[1];
        if (card === undefined || destination === undefined) throw new Error('Drag fixture nodes missing');
        await context.actions.drag({ id: card }, { id: destination });
        return { status: 'passed', summary: 'Dropped the card' };
      },
    };
    try {
      items = ['Alpha', 'Beta'];
      expect((await run(project, brain)).exitCode).not.toBe(0);
      expect(selected).toBeUndefined();
    } finally {
      project.cleanup();
    }
  }, 30_000);

  it('keeps content-dependent end-state checks conservative after ordinal relocation', async () => {
    const calls = { count: 0 };
    const brain = executor('first', calls);
    const position: ActPosition = { testId: 'inbox-item', at: 'first' };
    const project = createProject({ [FILE]: source(position, 'Opened Alpha') });
    try {
      showTitle = true;
      items = ['Alpha', 'Beta'];
      expect((await run(project, brain)).exitCode).toBe(0);
      items = ['Gamma', 'Delta'];
      writeFileSync(path.join(project.dir, FILE), source(position, 'Opened Gamma'));
      const changed = await run(project, brain);
      expect(changed.exitCode).toBe(0);
      expect(cacheInfo(changed)).toMatchObject({ reason: 'end-mismatch', replayedActions: 2 });
      expect(calls.count).toBe(2);
      expect(selected).toBe('Gamma');
    } finally {
      showTitle = false;
      project.cleanup();
    }
  }, 45_000);
});
