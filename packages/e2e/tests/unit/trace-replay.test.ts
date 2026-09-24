/** Zero-turn replay: typed dispatch, relocation backoff, divergence. */

import { describe, expect, it } from 'vitest';
import { AgentError } from '../../src/agent/error.ts';
import type { ExecutorActions } from '../../src/agent/executor.ts';
import { replayTrace, verifyAnchors, type ObservedScreen, type ReplayHost } from '../../src/agent/replay.ts';
import type { SettleMode } from '../../src/agent/settle-policy.ts';
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

const typeEmail: RecordedAction = { name: 'type', summary: 'type "x"', target: { role: 'textbox', name: 'Email' }, value: 'x' };

const VIEWPORT = { width: 1280, height: 720 };

/** A host whose every look, however far it settles, reads `capture`; tests swap the screen sequence in through it. */
type TestHost = ReplayHost & {
  calls: string[];
  observations: number;
  /** How far each look asked to settle, in order. */
  looks: SettleMode[];
  capture: () => Promise<ObservedScreen>;
};

function makeHost(options: {
  nodes?: SemanticNode[];
  viewport?: { width: number; height: number };
  onAction?: (name: string, detail: unknown) => void | Promise<void>;
  remainingMs?: number;
}): TestHost {
  const calls: string[] = [];
  const act = (name: string, detail?: unknown) => {
    calls.push(name);
    return Promise.resolve(options.onAction?.(name, detail)).then(() => undefined);
  };
  const actions: ExecutorActions = {
    tap: (t) => act('tap', t),
    doubleTap: (t) => act('doubleTap', t),
    longPress: (t) => act('longPress', t),
    secondaryTap: (t) => act('secondaryTap', t),
    hover: (t) => act('hover', t),
    type: (t, value) => act('type', { t, value }),
    typeSecret: (t, name) => act('typeSecret', { t, name }),
    press: (t, key) => act('press', { t, key }),
    select: (t, value) => act('select', { t, value }),
    check: (t, checked) => act('check', { t, checked }),
    drag: (source, destination) => act('drag', { source, destination }),
    scrollTo: (t) => act('scrollTo', t),
    scrollUntil: (text, direction, list) => act('scrollUntil', { text, direction, list }),
    upload: (t, paths) => act('upload', { t, paths }),
    scroll: (direction, t) => act('scroll', { direction, t }),
    navigate: (url) => act('navigate', url),
    back: () => act('back'),
    tapAt: async (point) => {
      await act('tapAt', point);
      return { point, summary: 'scripted' };
    },
    hoverAt: async (point) => {
      await act('hoverAt', point);
      return { point, summary: 'scripted' };
    },
    hitTest: (point) => Promise.resolve({ point, summary: 'scripted' }),
    typeText: (value, typing) => act('typeText', { value, replace: typing?.replace === true }),
    pressKey: (key) => act('pressKey', key),
    dismissKeyboard: () => act('dismissKeyboard'),
  };
  const host: TestHost = {
    calls,
    traceEligible: true,
    observations: 0,
    looks: [],
    // `host.capture` is read at call time so a test may swap the screen
    // sequence in after construction.
    observe: (mode) => {
      host.looks.push(mode);
      return host.capture();
    },
    capture: async () => {
      host.observations += 1;
      return screen(options.nodes ?? [upgrade, email], options.viewport);
    },
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
    host.capture = async () => {
      throw new Error('no surface to observe');
    };
    await expect(verifyAnchors(host, [savedAnchor])).resolves.toBe(false);
  });

  it('rethrows a runtime hard stop raised while looking', async () => {
    const host = makeHost({});
    host.capture = async () => {
      throw new AgentError('STEP_TIMEOUT', 'out of time');
    };
    await expect(verifyAnchors(host, [savedAnchor])).rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
  });

  it('waits out a slow effect before giving up', async () => {
    let shown = false;
    const host = makeHost({});
    host.capture = async () => {
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
        typeEmail,
        { name: 'scroll', summary: 'scroll down', direction: 'down' },
      ]),
    );
    expect(outcome).toMatchObject({ completed: true, executed: 4, total: 4 });
    expect(host.calls).toEqual(['navigate', 'tap', 'type', 'scroll']);
    expect(outcome.summaries).toHaveLength(4);
  });

  it('reads the start capture for the first look instead of observing the same screen again', async () => {
    const host = makeHost({});
    const outcome = await replayTrace(host, trace([tapUpgrade]), { initial: screen([upgrade, email]) });
    expect(outcome).toMatchObject({ completed: true, executed: 1 });
    expect(host.calls).toEqual(['tap']);
    expect(host.observations).toBe(0);
  });

  it("settles each look as far as the previous action's policy asks: held still after a tap, after the change after a fill", async () => {
    const host = makeHost({});
    const outcome = await replayTrace(
      host,
      trace([
        tapUpgrade,
        typeEmail,
        tapUpgrade,
        { name: 'typeText', summary: 'type "y"', value: 'y', replace: false },
        tapUpgrade,
        { name: 'typeSecret', summary: 'fill secret', target: { role: 'textbox', name: 'Email' }, secret: 'password' },
        tapUpgrade,
        { name: 'select', summary: 'select "Pro"', target: { role: 'textbox', name: 'Email' }, value: 'Pro' },
        tapUpgrade,
      ]),
    );
    expect(outcome).toMatchObject({ completed: true, executed: 9 });
    // The first look holds still; so does the look after each tap or select.
    // The look after a typed fill waits for its value only, and a typeText
    // takes no look of its own, so the tap after it is the one that reads
    // the first post-change capture. A secret fill is masked out of the tree,
    // so the look after it holds still: there is no change to wait for.
    expect(host.looks).toEqual([
      'held-still',
      'held-still',
      'after-change',
      'after-change',
      'held-still',
      'held-still',
      'held-still',
      'held-still',
    ]);
  });

  it('takes one look per repeat of a folded scroll on a list', async () => {
    const list: SemanticNode = { ref: { id: 'g1', revision: 'r1' }, role: 'group', name: 'Rows 1 to 12', rect: { x: 0, y: 0, width: 390, height: 300 } };
    const host = makeHost({ nodes: [list, email] });
    const outcome = await replayTrace(host, trace([{ name: 'scroll', summary: 'scroll down x3', direction: 'down', target: { role: 'group', name: 'Rows 1 to 12' }, times: 3, spans: 0.3 }]));
    expect(outcome).toMatchObject({ completed: true, executed: 1 });
    expect(host.calls).toEqual(['scroll', 'scroll', 'scroll']);
    expect(host.observations).toBe(3);
    expect(host.looks).toEqual(['held-still', 'held-still', 'held-still']);
  });

  it('ends the prefix at a gap without executing it', async () => {
    const host = makeHost({});
    const outcome = await replayTrace(
      host,
      trace([tapUpgrade, { name: 'tool', summary: 'tool seed_cart' }, tapUpgrade]),
    );
    expect(outcome).toMatchObject({ completed: false, executed: 1, stopReason: 'gap' });
    expect(outcome.derived).toBeUndefined();
    expect(host.calls).toEqual(['tap']);
  });

  it('names the rule behind a run-time value gap, so the report can cite it', async () => {
    const outcome = await replayTrace(
      makeHost({}),
      trace([tapUpgrade, { name: 'tool', summary: 'tool type (run-time value)', derived: 'minted-token' }, typeEmail]),
    );
    expect(outcome).toMatchObject({ completed: false, executed: 1, stopReason: 'gap', derived: 'minted-token' });
  });

  it('hands off with action-failed when the look before the second action throws, leaving the first action done', async () => {
    const host = makeHost({});
    host.capture = async () => {
      throw new Error('the surface went away');
    };
    const outcome = await replayTrace(host, trace([tapUpgrade, typeEmail]), { initial: screen([upgrade, email]) });
    expect(outcome).toMatchObject({ completed: false, executed: 1, stopReason: 'action-failed' });
    expect(outcome.summaries).toEqual(['tap button "Upgrade"']);
    expect(host.calls).toEqual(['tap']);
    // The first look was the start capture; the failed one was the fill's.
    expect(host.looks).toEqual(['held-still']);
  });

  it('replays every node verb through its own grammar call, with the recorded state and files', async () => {
    const details: unknown[] = [];
    const host = makeHost({ onAction: (_name, detail) => void details.push(detail) });
    const target = { role: 'button', name: 'Upgrade' };
    const outcome = await replayTrace(
      host,
      trace([
        { name: 'hover', summary: 'hover', target },
        { name: 'doubleTap', summary: 'double', target },
        { name: 'longPress', summary: 'long', target },
        { name: 'secondaryTap', summary: 'secondary', target },
        { name: 'scrollTo', summary: 'scroll to', target },
        { name: 'check', summary: 'uncheck', target, checked: false },
        { name: 'upload', summary: 'upload', target, paths: ['fixtures/a.txt'] },
        { name: 'back', summary: 'back' },
      ]),
    );
    expect(outcome).toMatchObject({ completed: true, executed: 8, total: 8 });
    expect(host.calls).toEqual(['hover', 'doubleTap', 'longPress', 'secondaryTap', 'scrollTo', 'check', 'upload', 'back']);
    expect(details[5]).toEqual({ t: { id: 'n1' }, checked: false });
    expect(details[6]).toEqual({ t: { id: 'n1' }, paths: ['fixtures/a.txt'] });
  });

  it('re-finds both ends of a drag on one screen before dragging', async () => {
    const details: unknown[] = [];
    const host = makeHost({ onAction: (_name, detail) => void details.push(detail) });
    const outcome = await replayTrace(
      host,
      trace([{ name: 'drag', summary: 'drag', target: { role: 'button', name: 'Upgrade' }, destination: { role: 'textbox', name: 'Email' } }]),
    );
    expect(outcome).toMatchObject({ completed: true, executed: 1 });
    expect(host.calls).toEqual(['drag']);
    expect(details[0]).toEqual({ source: { id: 'n1' }, destination: { id: 'n2' } });
  });

  it('hands a drag off when either end cannot be re-found, never dragging half of it', async () => {
    const host = makeHost({ nodes: [upgrade] });
    const outcome = await replayTrace(
      host,
      trace([{ name: 'drag', summary: 'drag', target: { role: 'button', name: 'Upgrade' }, destination: { role: 'textbox', name: 'Email' } }]),
    );
    expect(outcome).toMatchObject({ completed: false, executed: 0, stopReason: 'target-not-found' });
    expect(host.calls).toEqual([]);
  }, 15_000);

  it('replays a bare-point hover through hoverAt, on the recorded viewport only', async () => {
    const host = makeHost({});
    const hoverAt = { name: 'hoverAt' as const, summary: 'hover over the point (300, 60)', point: { x: 300, y: 60 }, viewport: VIEWPORT };
    expect(await replayTrace(host, trace([hoverAt]))).toMatchObject({ completed: true, executed: 1 });
    expect(host.calls).toEqual(['hoverAt']);
    const other = makeHost({ viewport: { width: 800, height: 600 } });
    expect(await replayTrace(other, trace([hoverAt]))).toMatchObject({ completed: false, stopReason: 'viewport-changed' });
    expect(other.calls).toEqual([]);
  });

  it('diverges with target-not-found when relocation never matches', async () => {
    const host = makeHost({ nodes: [email] });
    const outcome = await replayTrace(host, trace([tapUpgrade]));
    expect(outcome).toMatchObject({ completed: false, executed: 0, stopReason: 'target-not-found' });
  }, 15_000);

  it('keeps looking while a positioned target is ambiguous, since a form still rendering shows fewer twins', async () => {
    const unnamed = (id: string): SemanticNode => ({ ref: { id, revision: 'r1' }, role: 'textbox' });
    const host = makeHost({ nodes: [unnamed('a')] });
    let captures = 0;
    host.capture = async () => {
      captures += 1;
      // The first look shows one unnamed textbox where the recording counted two; the form finishes rendering after that.
      return screen(captures < 3 ? [unnamed('a')] : [unnamed('a'), unnamed('b')]);
    };
    const outcome = await replayTrace(host, trace([{ name: 'type', summary: 'type "x" into textbox (2 of 2)', target: { role: 'textbox', position: { index: 1, of: 2 } }, value: 'x' }]));
    expect(outcome).toMatchObject({ completed: true, executed: 1 });
    expect(host.calls).toEqual(['type']);
    // The retries between the backoff delays read the screen raw.
    expect(host.looks).toEqual(['held-still', 'raw', 'raw']);
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

  it('ignores a hidden look-alike that keeps its box, as the hit test that recorded the point did', async () => {
    const shown: SemanticNode = { ref: { id: 'a', revision: 'r1' }, role: 'img', name: 'Map', rect: { x: 200, y: 0, width: 200, height: 200 } };
    const hidden: SemanticNode = { ...shown, ref: { id: 'h', revision: 'r1' }, states: { hidden: true } };
    const within = { target: { role: 'img', name: 'Map' }, fx: 0.5, fy: 0.5 };
    const points: unknown[] = [];
    const host = makeHost({ nodes: [shown, hidden], onAction: (name, detail) => void (name === 'tapAt' && points.push(detail)) });
    const outcome = await replayTrace(host, trace([{ ...pin, within }]));
    expect(outcome).toMatchObject({ completed: true, executed: 1 });
    expect(points).toEqual([{ x: 300, y: 100 }]);
  });

  it('taps the recorded point when several nested look-alikes hold it, as a host view and the view inside it do', async () => {
    const host: SemanticNode = { ref: { id: 'h', revision: 'r1' }, role: 'group', name: 'Form', rect: { x: 0, y: 0, width: 400, height: 200 } };
    const inner: SemanticNode = { ref: { id: 'i', revision: 'r1' }, role: 'group', name: 'Form', rect: { x: 10, y: 10, width: 380, height: 180 } };
    const within = { target: { role: 'group', name: 'Form' }, fx: 0.75, fy: 0.3 };
    const points: unknown[] = [];
    const nested = makeHost({ nodes: [host, inner], onAction: (name, detail) => void (name === 'tapAt' && points.push(detail)) });
    const outcome = await replayTrace(nested, trace([{ ...pin, within }]));
    expect(outcome).toMatchObject({ completed: true, executed: 1 });
    expect(points).toEqual([{ x: 300, y: 60 }]);
    // An anonymous container among its kind, the merged tree of a screen built for pixels, is the same case.
    const groups: SemanticNode[] = [
      { ref: { id: 'a', revision: 'r1' }, role: 'group', rect: { x: 0, y: 0, width: 400, height: 400 } },
      { ref: { id: 'b', revision: 'r1' }, role: 'group', rect: { x: 0, y: 0, width: 400, height: 100 } },
      { ref: { id: 'c', revision: 'r1' }, role: 'group', rect: { x: 0, y: 300, width: 400, height: 100 } },
    ];
    const anonymous = await replayTrace(makeHost({ nodes: groups, onAction: (name, detail) => void (name === 'tapAt' && points.push(detail)) }), trace([{ ...pin, within: { target: { role: 'group' }, fx: 0.75, fy: 0.6 } }]));
    expect(anonymous).toMatchObject({ completed: true, executed: 1 });
    expect(points).toEqual([{ x: 300, y: 60 }, { x: 300, y: 60 }]);
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

  it('pages to a text on the viewport, on the re-found list, on the viewport for a lost list that filled the screen, and hands off for a lost small one', async () => {
    const calls: unknown[] = [];
    const list: SemanticNode = { ref: { id: 'l', revision: 'r1' }, role: 'list', name: 'Ledger', rect: { x: 0, y: 0, width: 1280, height: 200 } };
    const host = makeHost({ nodes: [list], onAction: (name, detail) => void (name === 'scrollUntil' && calls.push(detail)) });
    const viewport = await replayTrace(host, trace([{ name: 'scrollUntil', summary: 'scroll down until "Row 333" shows', text: 'Row 333', direction: 'down' }]));
    expect(viewport).toMatchObject({ completed: true, executed: 1 });
    const onList = await replayTrace(host, trace([{ name: 'scrollUntil', summary: 's', text: 'Row 333', direction: 'down', target: { role: 'list', name: 'Ledger' }, spans: 0.3 }]));
    expect(onList).toMatchObject({ completed: true, executed: 1 });
    expect(calls).toEqual([
      { text: 'Row 333', direction: 'down', list: undefined },
      { text: 'Row 333', direction: 'down', list: { id: 'l' } },
    ]);
    const lostFull = await replayTrace(makeHost({ nodes: [] }), trace([{ name: 'scrollUntil', summary: 's', text: 'Row 333', direction: 'down', target: { role: 'list', name: 'Ledger' }, spans: 0.9 }]));
    expect(lostFull).toMatchObject({ completed: true, executed: 1 });
    const lostSmall = await replayTrace(makeHost({ nodes: [] }), trace([{ name: 'scrollUntil', summary: 's', text: 'Row 333', direction: 'down', target: { role: 'list', name: 'Ledger' }, spans: 0.3 }]));
    expect(lostSmall).toMatchObject({ completed: false, executed: 0, stopReason: 'target-not-found' });
  });

  it('repeats a folded viewport scroll as many times as recorded, with a settled look between repeats', async () => {
    const host = makeHost({});
    const outcome = await replayTrace(host, trace([{ name: 'scroll', summary: 'scroll down x4', direction: 'down', times: 4 }]));
    expect(outcome).toMatchObject({ completed: true, executed: 1 });
    expect(host.calls).toEqual(['scroll', 'scroll', 'scroll', 'scroll']);
    // Nothing to relocate, so the first repeat takes no look; each later one holds still first.
    expect(host.looks).toEqual(['held-still', 'held-still', 'held-still']);
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
    host.capture = async () => {
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
