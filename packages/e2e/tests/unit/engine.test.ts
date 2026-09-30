import { assert, describe, expect, it } from 'vitest';
import {
  defineEngine,
  isEngineHandle,
  LOCATOR_ACTION_KINDS,
  parseKey,
  type Engine,
  type EngineCleanupContext,
  type EngineSnapshot,
} from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import { secrets } from '../../src/secrets.ts';
import { snapshot } from '../helpers/snapshot.ts';
import type { OperationContext, SemanticNode } from '../../src/engine/surface.ts';

const OP: OperationContext = {
  signal: new AbortController().signal,
  timeoutMs: 1_000,
  runId: 'run',
  attemptId: 'attempt',
  origin: 'test',
};

const node = (id: string, name: string): SemanticNode => ({
  ref: { id, revision: '' },
  role: 'button',
  name,
});

function observingEngine(extra: Partial<Engine> = {}): Engine {
  return {
    name: 'toy',
    version: '1.0.0',
    spiVersion: 1,
    observe: async () => snapshot([node('n1', 'Save'), node('n2', 'Cancel')]),
    ...extra,
  };
}

describe('defineEngine', () => {
  it('computes the capability set from declared members: perform is the actions capability', () => {
    const handle = defineEngine(observingEngine({ actions: ['tap', 'fill'], perform: async () => undefined }));
    expect([...handle.capabilities].toSorted()).toEqual(['actions', 'observation']);
    expect(handle.actions).toEqual(['tap', 'fill']);
    expect(Object.isFrozen(handle.actions)).toBe(true);
    expect(isEngineHandle(handle)).toBe(true);
  });

  it('rejects perform, locate, and performAt without observe: their refs are observation refs', () => {
    const bare = { name: 'toy', version: '1', spiVersion: 1 as const };
    expect(() => defineEngine({ ...bare, actions: LOCATOR_ACTION_KINDS, perform: async () => undefined })).toThrow(/perform without observe/);
    expect(() => defineEngine({ ...bare, locate: async () => [] })).toThrow(/locate without observe/);
    expect(() => defineEngine({ ...bare, pointerActions: ['tap'], performAt: async () => undefined })).toThrow(/performAt without observe/);
  });

  it('requires the action list with perform, and perform with the action list', () => {
    expect(() => defineEngine(observingEngine({ perform: async () => undefined }))).toThrow(
      /perform without actions: list the action kinds/,
    );
    expect(() => defineEngine(observingEngine({ actions: ['tap'] }))).toThrow(/actions without perform/);
  });

  it('carries tapModifiers onto the handle only with perform, and only as a boolean', () => {
    const perform = async () => undefined;
    expect(defineEngine(observingEngine({ actions: ['tap'], perform, tapModifiers: true })).tapModifiers).toBe(true);
    expect(defineEngine(observingEngine({ actions: ['tap'], perform, tapModifiers: false })).tapModifiers).toBeUndefined();
    expect(() => defineEngine(observingEngine({ tapModifiers: true }))).toThrow(/tapModifiers without perform/);
    expect(() => defineEngine(observingEngine({ actions: ['tap'], perform, tapModifiers: 'yes' as never }))).toThrow(
      /tapModifiers must be a boolean/,
    );
  });

  it('closes the action list: known kinds, each once, at least one', () => {
    const withActions = (actions: unknown) =>
      defineEngine(observingEngine({ actions: actions as never, perform: async () => undefined }));
    expect(() => withActions(['tap', 'click'])).toThrow(/actions names unknown kind "click"; expected one of tap, doubleTap/);
    expect(() => withActions(['tap', 'tap'])).toThrow(/actions lists "tap" twice/);
    expect(() => withActions([])).toThrow(/actions must be a non-empty array/);
    expect(() => withActions('tap')).toThrow(/actions must be a non-empty array/);
    expect(() => withActions([1])).toThrow(/unknown kind 1/);
  });

  it('refuses an app declaration, which the target makes now, and closes the session manifest', () => {
    expect(() => defineEngine(observingEngine({ app: { url: 'https://example.test' } } as never))).toThrow(
      'engine "toy": app is gone from the engine: the app under test is declared on its target (targets: [{ engine, app: { url } }])',
    );
    expect(() =>
      defineEngine(observingEngine({ session: { navigate: async () => undefined } as never })),
    ).toThrow(/session has unknown key "navigate"; expected one of open, back, restart, reset/);
    expect(() =>
      defineEngine(observingEngine({ session: { open: 'https://example.test/' } as never })),
    ).toThrow(/session.open must be a function/);
    expect(() => defineEngine(observingEngine({ session: [] as never }))).toThrow(/session must be an object/);
  });

  it('computes the pointer capability from performAt, which needs its pointerActions list', () => {
    const performAt = async () => undefined;
    const handle = defineEngine(observingEngine({ performAt, pointerActions: ['tap', 'longPress'] }));
    expect([...handle.capabilities].toSorted()).toEqual(['observation', 'pointer']);
    expect(handle.pointerActions).toEqual(['tap', 'longPress']);
    expect(Object.isFrozen(handle.pointerActions)).toBe(true);
    expect(() => defineEngine(observingEngine({ performAt }))).toThrow(/performAt without pointerActions/);
    expect(() => defineEngine(observingEngine({ pointerActions: ['tap'] }))).toThrow(/pointerActions without performAt/);
    expect(() => defineEngine(observingEngine({ performAt, pointerActions: ['fill' as never] }))).toThrow(
      /pointerActions names unknown kind "fill"/,
    );
    expect(() => defineEngine(observingEngine({ performAt, pointerActions: [] }))).toThrow(/pointerActions must be a non-empty array/);
  });

  it('computes the keyboard capability from the keyboard hooks, which need observe and both type and press', () => {
    const keyboard = { type: async () => undefined, press: async () => undefined };
    const handle = defineEngine(observingEngine({ keyboard }));
    expect([...handle.capabilities].toSorted()).toEqual(['keyboard', 'observation']);
    expect(handle.keyboard?.dismiss).toBeUndefined();
    const bare = { name: 'toy', version: '1', spiVersion: 1 as const };
    expect(() => defineEngine({ ...bare, keyboard })).toThrow(/keyboard without observe/);
    expect(() => defineEngine(observingEngine({ keyboard: { type: keyboard.type } as never }))).toThrow(/keyboard\.press/);
    expect(() => defineEngine(observingEngine({ keyboard: { ...keyboard, hide: keyboard.press } as never }))).toThrow(
      /keyboard has unknown key "hide"/,
    );
  });

  it('keeps the secrets its options hold as handles, each name once', () => {
    const handle = defineEngine(observingEngine({ secrets: [secrets.get('key'), secrets.get('key'), secrets.get('other')] }));
    expect(handle.secrets?.map((secret) => secret.name)).toEqual(['key', 'other']);
    expect(Object.isFrozen(handle.secrets)).toBe(true);
    expect(() => defineEngine(observingEngine({ secrets: secrets.get('key') as never }))).toThrow(/secrets must be an array/);
    expect(() => defineEngine(observingEngine({ secrets: [{ name: 'key', purpose: 'generic-secret' }] as never }))).toThrow(
      /not a secrets\.get\(\) handle/,
    );
  });

  it('rejects unknown keys, pointing tools at the agent', () => {
    expect(() =>
      defineEngine({ ...observingEngine(), tools: [] } as unknown as Engine),
    ).toThrow(/tools belong on the agent/);
  });

  it('rejects unknown keys inside nested manifests: the grammar is closed', () => {
    expect(() =>
      defineEngine(observingEngine({ session: { tap: async () => undefined } as never })),
    ).toThrow(/session has unknown key "tap"/);
    expect(() =>
      defineEngine(observingEngine({ artifacts: { screenshot: async () => 'x', video: 1 } as never })),
    ).toThrow(/artifacts has unknown key "video"/);
    expect(() =>
      defineEngine(observingEngine({ artifacts: { screenshot: async () => 'x', startVideo: async () => undefined } })),
    ).toThrow(/artifacts.startVideo and stopVideo must be declared together/);
    expect(() =>
      defineEngine(observingEngine({ state: { capture: async () => ({}) } as never })),
    ).toThrow(/state.restore must be a function/);
  });

  it('binds validateApp', () => {
    let bound = false;
    const spec: Engine = observingEngine({
      validateApp(this: unknown) {
        bound = this === spec;
      },
    });
    defineEngine(spec).validateApp!({}, { targetName: 'toy' });
    expect(bound).toBe(true);
    expect(() => defineEngine(observingEngine({ validateApp: true } as never))).toThrow('validateApp must be a function');
  });

  it('copies a declared workers bound and rejects one that is not a positive integer', () => {
    expect(defineEngine(observingEngine({ workers: 2 })).workers).toBe(2);
    expect(defineEngine(observingEngine()).workers).toBeUndefined();
    for (const workers of [0, -1, 1.5, Number.NaN, '2' as never]) {
      expect(() => defineEngine(observingEngine({ workers }))).toThrow(/workers must be a positive safe integer/);
    }
  });

  it('requires a version: provenance and the trace cache key depend on it', () => {
    expect(() => defineEngine({ ...observingEngine(), version: '' })).toThrow(/version/);
    expect(() =>
      defineEngine({ name: 'toy', spiVersion: 1 } as unknown as Engine),
    ).toThrow(/version must be a non-empty string/);
  });

  it('rejects unsupported spiVersion values', () => {
    expect(() => defineEngine({ ...observingEngine(), spiVersion: 2 as never })).toThrow(
      /spiVersion 2/,
    );
  });

  it('binds finish like every other lifecycle hook', async () => {
    let boundToSpec = false;
    const spec: Engine = observingEngine({
      async finish(this: unknown) {
        boundToSpec = this === spec;
      },
    });
    const handle = defineEngine(spec);
    await handle.finish?.({ runId: 'run', targetName: 'toy', env: {}, signal: new AbortController().signal, timeoutMs: 1000, log: () => {} });
    expect(boundToSpec).toBe(true);
  });

  it('binds prepare like every other lifecycle hook', async () => {
    let boundToSpec = false;
    const spec: Engine = observingEngine({
      async prepare(this: unknown) {
        boundToSpec = this === spec;
      },
    });
    const handle = defineEngine(spec);
    await handle.prepare?.({
      runId: 'run',
      targetName: 'toy',
      projectRoot: '/project',
      app: {},
      slots: 1,
      env: {},
      signal: new AbortController().signal,
      log: () => {},
    });
    expect(boundToSpec).toBe(true);
  });

  it('accepts a class instance: prototype methods are found and bound to the body', async () => {
    let boundToSession = false;
    const session = {
      async open(this: unknown) {
        boundToSession = this === session;
      },
    };
    class Toy implements Engine {
      readonly name = 'class-toy';
      readonly version = '2.0.0';
      readonly spiVersion = 1 as const;
      /** Own state: a class body may carry fields a literal may not. */
      observed = 0;
      readonly actions = ['tap'] as const;
      readonly session = session;
      async observe(): Promise<EngineSnapshot> {
        this.observed += 1;
        return snapshot([]);
      }
      async perform(): Promise<void> {
        this.observed += 10;
      }
    }
    const toy = new Toy();
    const handle = defineEngine(toy);
    expect([...handle.capabilities].toSorted()).toEqual(['actions', 'observation']);
    await handle.observe!(OP);
    await handle.perform!({ id: 'n1', revision: 'b1' }, { kind: 'tap' }, OP);
    await handle.session!.open!('https://example.test/', OP);
    expect(toy.observed).toBe(11);
    expect(boundToSession).toBe(true);
  });
});

describe('parseKey', () => {
  it('rejects non-printable single code points: control, format, surrogate, separators', () => {
    for (const key of ['\n', '\u0000', '\u200b', '\ud800', '\u2028', '\u007f', 'Shift+\t']) {
      expect(parseKey(key)).toBeUndefined();
    }
    expect(parseKey('\u00e9')).toEqual({ modifiers: [], key: { kind: 'char', char: '\u00e9' } });
  });
  it('parses named keys, single characters, and modifier chords', () => {
    expect(parseKey('Enter')).toEqual({ modifiers: [], key: { kind: 'named', name: 'Enter' } });
    expect(parseKey('a')).toEqual({ modifiers: [], key: { kind: 'char', char: 'a' } });
    expect(parseKey('$')).toEqual({ modifiers: [], key: { kind: 'char', char: '$' } });
    expect(parseKey('Control+a')).toEqual({ modifiers: ['Control'], key: { kind: 'char', char: 'a' } });
    expect(parseKey('Shift+Tab')).toEqual({ modifiers: ['Shift'], key: { kind: 'named', name: 'Tab' } });
    expect(parseKey('ControlOrMeta+Shift+ArrowLeft')).toEqual({
      modifiers: ['ControlOrMeta', 'Shift'],
      key: { kind: 'named', name: 'ArrowLeft' },
    });
  });

  it('treats a trailing + as the plus character', () => {
    expect(parseKey('+')).toEqual({ modifiers: [], key: { kind: 'char', char: '+' } });
    expect(parseKey('Shift++')).toEqual({ modifiers: ['Shift'], key: { kind: 'char', char: '+' } });
  });

  it('rejects unknown names, misspelt or repeated modifiers, bare modifiers, and several characters', () => {
    for (const key of ['', 'Ctrl+a', 'Enter+Shift', 'Shift', 'Shift+Shift+a', 'ab', 'enter', 'Shift+', 'Control+Shift']) {
      expect(parseKey(key), key).toBeUndefined();
    }
  });
});

describe('createEngineSession', () => {
  it('mints revisions and stamps them onto every ref', async () => {
    const session = createEngineSession({
      engine: defineEngine(observingEngine()),
      targetName: 'toy-target',
    });
    const first = await session.observe(OP);
    const second = await session.observe(OP);
    expect(first.revision).not.toBe(second.revision);
    assert(second.kind === 'semantic');
    expect(second.tree.children?.[0]?.ref.revision).toBe(second.revision);
    expect(second.redaction).toEqual({ secureNodeCount: 0, maskedRegionCount: 0 });
  });

  it('routes every node action through perform and fails loud on undeclared members', async () => {
    const calls: string[] = [];
    const session = createEngineSession({
      engine: defineEngine(
        observingEngine({
          actions: LOCATOR_ACTION_KINDS,
          perform: async (ref, action) => void calls.push(`${action.kind}:${ref.id}`),
        }),
      ),
      targetName: 'toy-target',
    });
    await session.perform({ id: 'n1', revision: 'b1' }, { kind: 'tap' }, OP);
    await session.perform({ id: 'n1', revision: 'b1' }, { kind: 'press', key: 'Enter' }, OP);
    expect(calls).toEqual(['tap:n1', 'press:n1']);
    expect(session.actions).toEqual(new Set(LOCATOR_ACTION_KINDS));
    await expect(session.locate({ kind: 'query' } as never, OP)).rejects.toThrow(/locators/);
    await expect(session.artifacts.screenshot(undefined, OP)).rejects.toThrow(/screenshots/);
    await expect(session.app.open('https://example.test/', OP)).rejects.toThrow(/navigation/);
  });

  it('refuses an undeclared action kind before it reaches the engine', async () => {
    const calls: string[] = [];
    const session = createEngineSession({
      engine: defineEngine(
        observingEngine({
          actions: ['tap'],
          perform: async (ref, action) => void calls.push(`${action.kind}:${ref.id}`),
        }),
      ),
      targetName: 'toy-target',
    });
    expect(session.actions).toEqual(new Set(['tap']));
    await expect(session.perform({ id: 'n1', revision: 'b1' }, { kind: 'check' }, OP)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: expect.stringMatching(/no engine capability for the "check" action: engine toy does not implement it/),
    });
    await expect(session.swipe('down', undefined, OP)).rejects.toThrow(/no engine capability for swipe gestures/);
    expect(calls).toEqual([]);
  });

  it('routes a point action through performAt only for a declared pointer kind', async () => {
    const performed: string[] = [];
    const session = createEngineSession({
      engine: defineEngine(
        observingEngine({
          performAt: async (point, action) => void performed.push(`${action.kind}@${point.x},${point.y}`),
          pointerActions: ['tap', 'longPress'],
        }),
      ),
      targetName: 'toy-target',
    });
    await session.performAt({ x: 3, y: 4 }, { kind: 'tap' }, OP);
    await session.performAt({ x: 5, y: 6 }, { kind: 'longPress', durationMs: 800 }, OP);
    await expect(session.performAt({ x: 1, y: 1 }, { kind: 'secondaryTap' }, OP)).rejects.toThrow(
      /the "secondaryTap" action at a point/,
    );
    expect(performed).toEqual(['tap@3,4', 'longPress@5,6']);
    const none = createEngineSession({ engine: defineEngine(observingEngine()), targetName: 'toy-target' });
    await expect(none.performAt({ x: 1, y: 1 }, { kind: 'tap' }, OP)).rejects.toThrow(/point/);
  });

  it('swipes the viewport as perform(root, swipe), observing first when nothing named the root yet', async () => {
    const performed: { id: string; revision: string; kind: string; direction?: string; momentum?: string }[] = [];
    let observes = 0;
    const session = createEngineSession({
      engine: defineEngine(
        observingEngine({
          observe: async () => {
            observes += 1;
            return { root: { ref: { id: 'screen', revision: '' }, role: 'root', children: [node('n1', 'Save')] }, viewport: { width: 10, height: 10 } };
          },
          actions: ['swipe'],
          perform: async (ref, action) =>
            void performed.push({ id: ref.id, revision: ref.revision, kind: action.kind, ...(action.kind === 'swipe' ? { direction: action.direction, ...(action.momentum === undefined ? {} : { momentum: action.momentum }) } : {}) }),
        }),
      ),
      targetName: 'toy-target',
    });
    await session.swipe('down', undefined, OP);
    expect(observes).toBe(1);
    expect(performed).toEqual([{ id: 'screen', revision: 'b1', kind: 'swipe', direction: 'down' }]);
    // A later observation names the root again; the swipe reuses it without observing.
    await session.observe(OP);
    await session.swipe('left', 'fast', OP);
    expect(observes).toBe(2);
    expect(performed[1]).toEqual({ id: 'screen', revision: 'b2', kind: 'swipe', direction: 'left', momentum: 'fast' });
  });

  it('carries the engine location and viewport onto the observation', async () => {
    const session = createEngineSession({
      engine: defineEngine(observingEngine({ observe: async () => snapshot([], { location: 'app://device/Home' }) })),
      targetName: 'toy-target',
    });
    const observation = await session.observe(OP);
    expect(observation.location).toBe('app://device/Home');
    expect(observation.viewport).toEqual({ width: 1280, height: 720 });
  });

  it('derives the grammar verbs from the declared action kinds and hooks', () => {
    const verbs = (extra: Partial<Engine>) =>
      [...createEngineSession({ engine: defineEngine(observingEngine(extra)), targetName: 't' }).verbs].toSorted();
    const perform = async () => undefined;
    expect(verbs({})).toEqual([]);
    expect(verbs({ actions: LOCATOR_ACTION_KINDS, perform })).toEqual([
      'check',
      'doubleTap',
      'drag',
      'hover',
      'longPress',
      'press',
      'scroll',
      'scrollTo',
      'scrollUntil',
      'secondaryTap',
      'select',
      'tap',
      'type',
      'typeSecret',
      'upload',
    ]);
    expect(verbs({ actions: ['tap'], perform })).toEqual(['tap']);
    expect(verbs({ actions: ['doubleTap', 'longPress', 'secondaryTap'], perform })).toEqual(['doubleTap', 'longPress', 'secondaryTap']);
    expect(verbs({ actions: ['fill'], perform })).toEqual(['type', 'typeSecret']);
    expect(verbs({ actions: ['press'], perform })).toEqual(['press']);
    expect(verbs({ actions: ['selectOption'], perform })).toEqual(['select']);
    expect(verbs({ actions: ['swipe'], perform })).toEqual(['scroll', 'scrollUntil']);
    expect(verbs({ actions: ['hover', 'dragTo', 'scrollIntoView', 'setInputFiles'], perform })).toEqual(['drag', 'hover', 'scrollTo', 'upload']);
    // `check` sets a state, so it needs both directions; `clear` and `focus` unlock nothing for the agent.
    expect(verbs({ actions: ['check', 'uncheck'], perform })).toEqual(['check']);
    expect(verbs({ actions: ['check', 'clear', 'focus'], perform })).toEqual([]);
    // The point verbs need their own pointer kind; other pointer kinds alone offer nothing.
    expect(verbs({ performAt: async () => undefined, pointerActions: ['tap', 'hover'] })).toEqual(['hoverAt', 'tapAt']);
    expect(verbs({ performAt: async () => undefined, pointerActions: ['hover'] })).toEqual(['hoverAt']);
    expect(verbs({ performAt: async () => undefined, pointerActions: ['longPress', 'swipeTo'] })).toEqual([]);
    const keyboard = { type: async () => undefined, press: async () => undefined };
    expect(verbs({ keyboard })).toEqual(['pressKey', 'typeText']);
    expect(verbs({ keyboard: { ...keyboard, dismiss: async () => undefined } })).toEqual(['dismissKeyboard', 'pressKey', 'typeText']);
    expect(verbs({ session: { open: async () => undefined } })).toEqual(['navigate']);
    expect(verbs({ session: { back: async () => undefined, restart: async () => undefined } })).toEqual(['back']);
    expect(verbs({ session: { restart: async () => undefined } })).toEqual([]);
  });

  it('rejects a superseded located ref but lets observation refs through to the engine', async () => {
    const performed: string[] = [];
    const session = createEngineSession({
      engine: defineEngine(
        observingEngine({
          locate: async () => [node('n1', 'Save')],
          actions: ['tap'],
          perform: async (ref) => void performed.push(ref.revision),
        }),
      ),
      targetName: 'toy-target',
    });
    const [first] = await session.locate({ kind: 'selector', selector: 'x' }, OP);
    await session.locate({ kind: 'selector', selector: 'x' }, OP);
    await expect(session.perform(first!, { kind: 'tap' }, OP)).rejects.toMatchObject({ code: 'NODE_STALE' });
    // The same id from an observation is the engine's to check, not the adapter's.
    const observed = await session.observe(OP);
    await session.perform({ id: 'n1', revision: observed.revision }, { kind: 'tap' }, OP);
    expect(performed).toEqual([observed.revision]);
  });

  it('ends the attempt exactly once, handing endAttempt the cleanup budget', async () => {
    const contexts: EngineCleanupContext[] = [];
    const session = createEngineSession({
      engine: defineEngine(
        observingEngine({
          endAttempt: async (context) => void contexts.push(context),
        }),
      ),
      targetName: 'toy-target',
    });
    await session.close({ ...OP, timeoutMs: 7_000 });
    await session.close({ ...OP, timeoutMs: 7_000 });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toEqual({ signal: OP.signal, timeoutMs: 7_000 });
  });

  it('reports missing observation as an unsupported capability', async () => {
    const session = createEngineSession({
      engine: undefined,
      targetName: 'bare',
    });
    await expect(session.observe(OP)).rejects.toThrow(/no engine capability for observation/);
    expect(session.verbs.size).toBe(0);
  });
});

describe('createEngineSession pixels-only observation', () => {
  it('requires explicit fallback permission and discards stale semantic content', async () => {
    let raw: EngineSnapshot = {
      root: { ref: { id: 'root', revision: '' } },
      viewport: { width: 2, height: 2 },
      treeUnavailable: true,
      pixels: { data: new Uint8Array(8), mediaType: 'image/png', width: 2, height: 2, scale: 1 },
    };
    const received: unknown[] = [];
    const session = createEngineSession({
      engine: defineEngine(observingEngine({ observe: async (_operation, options) => { received.push(options); return raw; } })),
      targetName: 'toy',
    });
    await expect(session.observe(OP)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    const captured = await session.observe(OP, { pixelFallback: true });
    expect(received.at(-1)).toEqual({ pixelFallback: true });
    expect(captured.kind).toBe('pixels');
    expect(captured).not.toHaveProperty('tree');
    expect(captured.root.revision).toBe(captured.revision);
    raw = { ...raw, root: { ...raw.root, children: [node('stale', 'Old control')] } };
    await expect(session.observe(OP, { pixelFallback: true })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    raw = { root: raw.root, viewport: raw.viewport, treeUnavailable: true };
    await expect(session.observe(OP, { pixelFallback: true })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });

  it('accepts a snapshot with no nodes and pixels: a vision-only body is observable', async () => {
    const pixels = { data: new Uint8Array(8), mediaType: 'image/png' as const, width: 4, height: 2, scale: 1 };
    const session = createEngineSession({
      engine: defineEngine({
        name: 'vision',
        version: '1.0.0',
        spiVersion: 1,
        observe: async () => snapshot([], { pixels, maskedRegionCount: 0 }),
      }),
      targetName: 'desktop',
    });
    const observation = await session.observe(OP, { pixels: true });
    assert(observation.kind === 'semantic');
    expect(observation.tree.role).toBe('root');
    expect(observation.tree.children ?? []).toHaveLength(0);
    expect(observation.pixels).toBe(pixels);
    expect(observation.redaction).toEqual({ secureNodeCount: 0, maskedRegionCount: 0 });
  });
});

describe('engine targets in config', () => {
  const ROOT = '/tmp/e2e-engine-config';

  it('rejects an empty platform declaration', () => {
    expect(() => defineEngine({ name: 'x', version: '1', spiVersion: 1, platform: ' ' })).toThrow(
      'platform must be a non-empty string when declared',
    );
  });

  it('resolves an engine target on any platform without an app url', () => {
    const engine = defineEngine(observingEngine());
    const config = resolveConfig(
      { targets: [{ name: 'ios-simulator', platform: 'ios', engine }] },
      { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv },
    );
    const target = config.targets[0];
    expect(target?.engine?.name).toBe('toy');
    expect(target?.platform).toBe('ios');
    expect(target?.app).toMatchObject({ base: undefined, site: undefined, identity: undefined });
  });

  it('rejects a non-handle engine value', () => {
    expect(() =>
      resolveConfig(
        { targets: [{ name: 'ios', platform: 'ios', engine: { name: 'raw' } as never }] },
        { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv },
      ),
    ).toThrow(/defineEngine/);
  });

  it('accepts a trace and a video mode on a target without an engine; the runner grades them later', () => {
    const config = resolveConfig(
      { targets: [{ name: 'ios', platform: 'ios', trace: 'off', video: 'on' }] },
      { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv },
    );
    expect(config.targets[0]!.trace).toEqual({ mode: 'off', source: 'target' });
    expect(config.targets[0]!.video).toEqual({ mode: 'on', source: 'target' });
  });

  it('accepts agent options alongside an executor', () => {
    const executor = { name: 'custom-brain', runStep: async () => ({ status: 'passed' as const, summary: 'ok' }) };
    const config = resolveConfig(
      {
        targets: [{ name: 'ios', platform: 'ios' }],
        agents: { default: { executor, maxModelCalls: 40, context: 'device hints' } },
      },
      { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv },
    );
    expect(config.agent.executor?.name).toBe('custom-brain');
    expect(config.agent.maxModelCalls).toBe(40);
    expect(config.agent.context).toBe('device hints');
  });
});
