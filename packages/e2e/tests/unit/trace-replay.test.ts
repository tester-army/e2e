/** Zero-turn replay: typed dispatch, relocation backoff, divergence. */

import { describe, expect, it } from 'vitest';
import { AgentError } from '../../src/agent/error.ts';
import type { ExecutorActions } from '../../src/agent/executor.ts';
import { replayTrace, verifyAnchors, type ReplayHost } from '../../src/agent/replay.ts';
import type { ActionTrace, RecordedAction } from '../../src/cache/trace.ts';
import type { SemanticNode } from '../../src/engine/surface.ts';

const upgrade: SemanticNode = { ref: { id: 'n1', revision: 'r1' }, role: 'button', name: 'Upgrade' };
const email: SemanticNode = { ref: { id: 'n2', revision: 'r1' }, role: 'textbox', name: 'Email' };

function trace(actions: RecordedAction[]): ActionTrace {
  return { actions, executor: { name: 'test' }, summary: 'done' };
}

const tapUpgrade: RecordedAction = {
  name: 'tap',
  summary: 'tap button "Upgrade"',
  target: { role: 'button', name: 'Upgrade' },
};

const VIEWPORT = { width: 1280, height: 720 };

function makeHost(options: {
  nodes?: SemanticNode[];
  viewport?: { width: number; height: number };
  onAction?: (name: string, detail: unknown) => void | Promise<void>;
  remainingMs?: number;
}): ReplayHost & { calls: string[]; observations: number } {
  const calls: string[] = [];
  const act = (name: string, detail?: unknown) => {
    calls.push(name);
    return Promise.resolve(options.onAction?.(name, detail)).then(() => undefined);
  };
  const actions: ExecutorActions = {
    tap: (t) => act('tap', t),
    type: (t, value) => act('type', { t, value }),
    typeSecret: (t, name) => act('typeSecret', { t, name }),
    press: (t, key) => act('press', { t, key }),
    select: (t, value) => act('select', { t, value }),
    scroll: (direction, t) => act('scroll', { direction, t }),
    navigate: (url) => act('navigate', url),
    tapAt: async (point) => {
      await act('tapAt', point);
      return { point, summary: 'scripted' };
    },
    hitTest: (point) => Promise.resolve({ point, summary: 'scripted' }),
    typeText: (value, typing) => act('typeText', { value, replace: typing?.replace === true }),
    pressKey: (key) => act('pressKey', key),
    dismissKeyboard: () => act('dismissKeyboard'),
  };
  const host = {
    calls,
    traceEligible: true,
    observations: 0,
    observe: async () => {
      host.observations += 1;
      return screen(options.nodes ?? [upgrade, email], options.viewport);
    },
    // Settled looks come from the same source; `host.observe` is read at call
    // time so a test may swap the screen sequence in after construction.
    observeSettled: () => host.observe(),
    actions,
    signal: new AbortController().signal,
    remainingMs: () => options.remainingMs ?? 60_000,
    redact: (text: string) => text,
  };
  return host;
}

/** One observed screen over the given nodes. */
function screen(nodes: readonly SemanticNode[], viewport = VIEWPORT) {
  return { kind: 'semantic' as const, nodes: new Map(nodes.map((n) => [n.ref.id, n])), viewport };
}

describe('verifyAnchors', () => {
  const saved: SemanticNode = { ref: { id: 'm', revision: 'r1' }, role: 'status', name: 'Marker', text: 'saved' };
  const savedAnchor = { role: 'status', name: 'Marker', text: 'saved' };

  it('holds trivially for a trace without anchors, without observing', async () => {
    const host = makeHost({});
    await expect(verifyAnchors(host, [])).resolves.toBe(true);
    expect(host.observations).toBe(0);
  });

  it('holds when every anchor is present, counting an ambiguous match as presence', async () => {
    const twin: SemanticNode = { ...saved, ref: { id: 'm2', revision: 'r1' } };
    const host = makeHost({ nodes: [upgrade, saved, twin] });
    await expect(verifyAnchors(host, [savedAnchor, { role: 'button', name: 'Upgrade' }])).resolves.toBe(true);
  });

  it('fails when any anchor is missing once the clock leaves no room to wait', async () => {
    const host = makeHost({ nodes: [upgrade, email], remainingMs: 50 });
    await expect(verifyAnchors(host, [{ role: 'button', name: 'Upgrade' }, savedAnchor])).resolves.toBe(false);
  });

  it('treats a surface that cannot be observed as a mismatch, never as a step failure', async () => {
    const host = makeHost({});
    host.observe = async () => {
      throw new Error('no surface to observe');
    };
    await expect(verifyAnchors(host, [savedAnchor])).resolves.toBe(false);
  });

  it('rethrows a runtime hard stop raised while looking', async () => {
    const host = makeHost({});
    host.observe = async () => {
      throw new AgentError('STEP_TIMEOUT', 'out of time');
    };
    await expect(verifyAnchors(host, [savedAnchor])).rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
  });

  it('waits out a slow effect before giving up', async () => {
    let shown = false;
    const host = makeHost({});
    host.observe = async () => {
      host.observations += 1;
      // Present from the second look on: the effect landed after the last action.
      const list = host.observations >= 3 ? [upgrade, saved] : [upgrade];
      shown = host.observations >= 3;
      return screen(list);
    };
    await expect(verifyAnchors(host, [savedAnchor])).resolves.toBe(true);
    expect(shown).toBe(true);
  });
});

describe('replayTrace', () => {
  it('replays a full trace and reports completion', async () => {
    const host = makeHost({});
    const outcome = await replayTrace(
      host,
      trace([
        { name: 'navigate', summary: 'navigate to "/"', url: '/' },
        tapUpgrade,
        { name: 'type', summary: 'type "x"', target: { role: 'textbox', name: 'Email' }, value: 'x' },
        { name: 'scroll', summary: 'scroll down', direction: 'down' },
      ]),
    );
    expect(outcome).toMatchObject({ completed: true, executed: 4, total: 4 });
    expect(host.calls).toEqual(['navigate', 'tap', 'type', 'scroll']);
    expect(outcome.summaries).toHaveLength(4);
  });

  it('ends the prefix at a gap without executing it', async () => {
    const host = makeHost({});
    const outcome = await replayTrace(
      host,
      trace([tapUpgrade, { name: 'tool', summary: 'tool seed_cart' }, tapUpgrade]),
    );
    expect(outcome).toMatchObject({ completed: false, executed: 1, stopReason: 'gap' });
    expect(host.calls).toEqual(['tap']);
  });

  it('diverges with target-not-found when relocation never matches', async () => {
    const host = makeHost({ nodes: [email] });
    const outcome = await replayTrace(host, trace([tapUpgrade]));
    expect(outcome).toMatchObject({ completed: false, executed: 0, stopReason: 'target-not-found' });
  }, 15_000);

  it('keeps looking while a positioned target is ambiguous, since a form still rendering shows fewer twins', async () => {
    const unnamed = (id: string): SemanticNode => ({ ref: { id, revision: 'r1' }, role: 'textbox' });
    const host = makeHost({ nodes: [unnamed('a')] });
    let looks = 0;
    host.observe = async () => {
      looks += 1;
      // The first look shows one unnamed textbox where the recording counted two; the form finishes rendering after that.
      return screen(looks < 3 ? [unnamed('a')] : [unnamed('a'), unnamed('b')]);
    };
    const outcome = await replayTrace(host, trace([{ name: 'type', summary: 'type "x" into textbox (2 of 2)', target: { role: 'textbox', position: { index: 1, of: 2 } }, value: 'x' }]));
    expect(outcome).toMatchObject({ completed: true, executed: 1 });
    expect(host.calls).toEqual(['type']);
  });

  it('still diverges at once on ambiguity for a target with no recorded position', async () => {
    const twin: SemanticNode = { ref: { id: 'n9', revision: 'r1' }, role: 'button', name: 'Upgrade' };
    const host = makeHost({ nodes: [upgrade, twin, email] });
    const outcome = await replayTrace(host, trace([tapUpgrade]));
    expect(outcome).toMatchObject({ completed: false, executed: 0, stopReason: 'target-ambiguous' });
    expect(host.observations).toBeLessThan(3);
  });

  it('relocates by semantic identity when a recorded test id churned', async () => {
    const churned: SemanticNode = {
      ref: { id: 'n5', revision: 'r1' },
      role: 'button',
      name: 'Activate plan',
      testId: 'toggle-zz9-r4-0',
    };
    const host = makeHost({ nodes: [churned, email] });
    const outcome = await replayTrace(
      host,
      trace([
        {
          name: 'tap',
          summary: 'tap button "Activate plan"',
          target: { role: 'button', name: 'Activate plan', testId: 'toggle-aa1-r0-0' },
        },
      ]),
    );
    expect(outcome).toMatchObject({ completed: true, executed: 1 });
    expect(host.calls).toEqual(['tap']);
  });

  it('diverges immediately on ambiguity', async () => {
    const twin: SemanticNode = { ref: { id: 'n9', revision: 'r1' }, role: 'button', name: 'Upgrade' };
    const host = makeHost({ nodes: [upgrade, twin] });
    const outcome = await replayTrace(host, trace([tapUpgrade]));
    expect(outcome).toMatchObject({ completed: false, stopReason: 'target-ambiguous' });
    expect(host.calls).toEqual([]);
  });

  it('absorbs an action failure as divergence, never as a step failure', async () => {
    const host = makeHost({
      onAction: (name) => {
        if (name === 'tap') throw new AgentError('ACTION_FAILED', 'element detached');
      },
    });
    const outcome = await replayTrace(
      host,
      trace([{ name: 'navigate', summary: 'navigate', url: '/' }, tapUpgrade]),
    );
    expect(outcome).toMatchObject({ completed: false, executed: 1, stopReason: 'action-failed' });
  });

  it('surfaces an unknown commit state as action-uncertain with the action named', async () => {
    const host = makeHost({
      onAction: (name) => {
        if (name === 'tap') {
          const uncertain = new Error('input may have reached the app') as Error & { code: string };
          uncertain.code = 'ACTION_MAY_HAVE_COMMITTED';
          throw new Error('action failed', { cause: uncertain });
        }
      },
    });
    const outcome = await replayTrace(
      host,
      trace([{ name: 'navigate', summary: 'navigate', url: '/' }, tapUpgrade]),
    );
    expect(outcome).toMatchObject({
      completed: false,
      executed: 1,
      stopReason: 'action-uncertain',
      uncertainAction: 'tap button "Upgrade"',
    });
  });

  it('rethrows runtime hard stops untouched', async () => {
    const host = makeHost({
      onAction: () => {
        throw new AgentError('STEP_BUDGET_EXHAUSTED', 'out of actions');
      },
    });
    await expect(replayTrace(host, trace([tapUpgrade]))).rejects.toMatchObject({
      code: 'STEP_BUDGET_EXHAUSTED',
    });
  });
});

describe('replayTrace: bare-point taps', () => {
  const pin: RecordedAction = {
    name: 'tapAt',
    summary: 'tap the point (300, 60)',
    point: { x: 300, y: 60 },
    viewport: VIEWPORT,
  };

  it('replays the recorded point as given when the viewport is the recorded size', async () => {
    const points: unknown[] = [];
    const host = makeHost({ onAction: (name, detail) => void (name === 'tapAt' && points.push(detail)) });
    const outcome = await replayTrace(host, trace([pin]));
    expect(outcome).toMatchObject({ completed: true, executed: 1 });
    expect(points).toEqual([{ x: 300, y: 60 }]);
  });

  it('hands off with viewport-changed when the viewport is another size, without tapping', async () => {
    const host = makeHost({ viewport: { width: 390, height: 844 } });
    const outcome = await replayTrace(host, trace([pin]));
    expect(outcome).toMatchObject({ completed: false, executed: 0, stopReason: 'viewport-changed' });
    expect(host.calls).toEqual([]);
  });

  it('follows the node the point was placed in: the same place inside its live box', async () => {
    const map: SemanticNode = { ref: { id: 'm', revision: 'r1' }, role: 'img', name: 'Map', rect: { x: 100, y: 200, width: 400, height: 200 } };
    const points: unknown[] = [];
    const host = makeHost({ nodes: [map, email], onAction: (name, detail) => void (name === 'tapAt' && points.push(detail)) });
    const outcome = await replayTrace(
      host,
      trace([{ ...pin, within: { target: { role: 'img', name: 'Map' }, fx: 0.75, fy: 0.3 } }]),
    );
    expect(outcome).toMatchObject({ completed: true, executed: 1 });
    // The recording had the map at (0, 0) with the pin at (300, 60); the live map moved to (100, 200).
    expect(points).toEqual([{ x: 400, y: 260 }]);
  });

  it('hands off when the node the point was placed in is gone or has no box, never tapping the bare point', async () => {
    const within = { target: { role: 'img', name: 'Map' }, fx: 0.5, fy: 0.5 };
    const host = makeHost({ nodes: [email] });
    const outcome = await replayTrace(host, trace([{ ...pin, within }]));
    expect(outcome).toMatchObject({ completed: false, executed: 0, stopReason: 'target-not-found' });
    expect(host.calls).toEqual([]);
    const boxless: SemanticNode = { ref: { id: 'm', revision: 'r1' }, role: 'img', name: 'Map' };
    const flat = makeHost({ nodes: [boxless] });
    expect(await replayTrace(flat, trace([{ ...pin, within }]))).toMatchObject({ completed: false, stopReason: 'target-not-found' });
    expect(flat.calls).toEqual([]);
  });

  it('lets the recorded point pick among look-alikes when it lies inside exactly one of them', async () => {
    const left: SemanticNode = { ref: { id: 'a', revision: 'r1' }, role: 'img', name: 'Map', rect: { x: 0, y: 0, width: 200, height: 200 } };
    const right: SemanticNode = { ref: { id: 'b', revision: 'r1' }, role: 'img', name: 'Map', rect: { x: 200, y: 0, width: 200, height: 200 } };
    const within = { target: { role: 'img', name: 'Map' }, fx: 0.5, fy: 0.5 };
    const points: unknown[] = [];
    const host = makeHost({ nodes: [left, right], onAction: (name, detail) => void (name === 'tapAt' && points.push(detail)) });
    const outcome = await replayTrace(host, trace([{ ...pin, within }]));
    expect(outcome).toMatchObject({ completed: true, executed: 1 });
    // (300, 60) lies in the right-hand map; the tap lands at its recorded place inside that box.
    expect(points).toEqual([{ x: 300, y: 100 }]);
  });

  it('hands off among look-alikes when the point settles nothing or the viewport changed', async () => {
    const left: SemanticNode = { ref: { id: 'a', revision: 'r1' }, role: 'img', name: 'Map', rect: { x: 0, y: 0, width: 200, height: 200 } };
    const right: SemanticNode = { ref: { id: 'b', revision: 'r1' }, role: 'img', name: 'Map', rect: { x: 200, y: 0, width: 200, height: 200 } };
    const within = { target: { role: 'img', name: 'Map' }, fx: 0.5, fy: 0.5 };
    const off = await replayTrace(makeHost({ nodes: [left, right] }), trace([{ ...pin, point: { x: 600, y: 60 }, within }]));
    expect(off).toMatchObject({ completed: false, executed: 0, stopReason: 'target-ambiguous' });
    const resized = await replayTrace(makeHost({ nodes: [left, right], viewport: { width: 390, height: 844 } }), trace([{ ...pin, within }]));
    expect(resized).toMatchObject({ completed: false, executed: 0, stopReason: 'target-ambiguous' });
  });

  it('repeats a folded scroll as many times as recorded', async () => {
    const host = makeHost({});
    const outcome = await replayTrace(host, trace([{ name: 'scroll', summary: 'scroll down x4', direction: 'down', times: 4 }]));
    expect(outcome).toMatchObject({ completed: true, executed: 1 });
    expect(host.calls).toEqual(['scroll', 'scroll', 'scroll', 'scroll']);
  });

  it('scrolls the viewport when a list that filled the screen cannot be re-found', async () => {
    const targets: unknown[] = [];
    const host = makeHost({ nodes: [email], onAction: (name, detail) => void (name === 'scroll' && targets.push(detail)) });
    const list = { role: 'group', name: 'Rows 1 to 12' };
    const outcome = await replayTrace(host, trace([{ name: 'scroll', summary: 'scroll down x2', direction: 'down', target: list, times: 2, spans: 0.92 }]));
    expect(outcome).toMatchObject({ completed: true, executed: 1 });
    expect(targets).toEqual([{ direction: 'down', t: undefined }, { direction: 'down', t: undefined }]);
  });

  it('counts the repeats of a folded scroll that ran before a later one lost the list', async () => {
    const list: SemanticNode = { ref: { id: 'g1', revision: 'r1' }, role: 'group', name: 'Rows 1 to 12', rect: { x: 0, y: 0, width: 390, height: 300 } };
    const host = makeHost({ nodes: [list, email] });
    host.observe = async () => {
      host.observations += 1;
      // The list leaves the tree after the first scroll.
      return screen(host.calls.includes('scroll') ? [email] : [list, email]);
    };
    const outcome = await replayTrace(host, trace([{ name: 'scroll', summary: 'scroll down x3', direction: 'down', target: { role: 'group', name: 'Rows 1 to 12' }, times: 3, spans: 0.3 }]));
    expect(outcome).toMatchObject({ completed: false, executed: 1, stopReason: 'target-not-found' });
    expect(outcome.summaries).toEqual(['scroll down x3 (1 of 3 repeats)']);
    expect(host.calls).toEqual(['scroll']);
  });

  it('hands off when a smaller scrolled region cannot be re-found, never scrolling the viewport for it', async () => {
    const host = makeHost({ nodes: [email] });
    const carousel = { role: 'group', name: 'Recommended' };
    const outcome = await replayTrace(host, trace([{ name: 'scroll', summary: 'scroll right', direction: 'right', target: carousel, spans: 0.18 }]));
    expect(outcome).toMatchObject({ completed: false, executed: 0, stopReason: 'target-not-found' });
    expect(host.calls).toEqual([]);
    const unknown = await replayTrace(makeHost({ nodes: [email] }), trace([{ name: 'scroll', summary: 'scroll right', direction: 'right', target: carousel }]));
    expect(unknown).toMatchObject({ completed: false, executed: 0, stopReason: 'target-not-found' });
  });

});
