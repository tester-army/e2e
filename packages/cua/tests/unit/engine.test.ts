/**
 * The cua engine through the public contract, with a scripted driver client:
 * lifecycle order, the tool each contract member calls, id staleness, the
 * path anchor, artifacts, and the contributed fixture. No desktop: what is
 * asserted is the call stream, which is the whole of what this engine owes
 * Cua Driver.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineFixtureContext, EngineHandle, LocatorExpression, OperationContext, SemanticNode } from '@e2edev/e2e/engine';
import { buildEngine } from '../../src/engine.ts';
import type { Desktop } from '../../src/desktop.ts';
import { CuaSurface, type CuaOptions } from '../../src/surface.ts';
import { acted, createFakeClient, failure, ok, PID, WINDOW, WINDOW_ID, WINDOW_STATE, type FakeClient } from '../helpers/fake-client.ts';
import { decodePng, encodePng } from '../helpers/png.ts';

function operation(signal = new AbortController().signal): OperationContext {
  return { signal, timeoutMs: 30_000, runId: 'run-1', attemptId: 'a1' };
}

function cleanup() {
  return { signal: new AbortController().signal, timeoutMs: 5_000 };
}

async function boot(engine: EngineHandle): Promise<void> {
  await engine.init!({
    runId: 'run-1',
    targetName: 'mac',
    projectRoot: '/project',
    app: { allowedOrigins: [] },
    testIdAttribute: 'data-testid',
    headed: false,
    signal: new AbortController().signal,
  });
}

interface Harness {
  readonly engine: EngineHandle;
  readonly fake: FakeClient;
  readonly surface: CuaSurface;
  clients: number;
}

function harness(options: Partial<CuaOptions> = {}): Harness {
  const fake = createFakeClient();
  const h: Harness = { engine: undefined as unknown as EngineHandle, fake, surface: undefined as unknown as CuaSurface, clients: 0 };
  const surface = new CuaSurface({ app: 'com.apple.TextEdit', ...options }, () => {
    h.clients += 1;
    return fake.client;
  });
  return Object.assign(h, { engine: buildEngine(surface), surface });
}

let artifactsDir: string;

beforeEach(() => {
  artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-cua-'));
});

afterEach(() => {
  rmSync(artifactsDir, { recursive: true, force: true });
});

async function openAttempt(h: Harness, attemptId = 'a1'): Promise<void> {
  await boot(h.engine);
  await h.engine.startAttempt!({ attemptId, artifactsDir, signal: new AbortController().signal });
}

function* walk(nodes: readonly SemanticNode[]): Generator<SemanticNode> {
  for (const node of nodes) {
    yield node;
    yield* walk(node.children ?? []);
  }
}

function named(nodes: readonly SemanticNode[], name: string): SemanticNode {
  const found = [...walk(nodes)].find((node) => node.name === name);
  if (found === undefined) throw new Error(`no node named ${name}`);
  return found;
}

async function observed(h: Harness, name: string): Promise<SemanticNode> {
  const snapshot = await h.engine.observe!(operation());
  return named(snapshot.nodes, name);
}

/** A solid grey 1200x800 PNG, the window screenshot at 2x. */
function screenshotPng(): string {
  const pixels = new Uint8Array(1200 * 800 * 4).fill(128);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  return Buffer.from(encodePng({ width: 1200, height: 800, channels: 4, pixels })).toString('base64');
}

const roleQuery = (role: string, name?: string): LocatorExpression => ({
  kind: 'query',
  query: { kind: 'role', value: { kind: 'string', value: role, exact: false }, ...(name === undefined ? {} : { name: { kind: 'string', value: name, exact: false } }) },
});

describe('manifest', () => {
  it('declares observation, actions, location, artifacts, the desktop fixture, restart, and the anchor', () => {
    const { engine } = harness();
    expect([...engine.capabilities].toSorted()).toEqual(['actions', 'artifacts', 'desktop', 'location', 'observation']);
    expect(engine.name).toBe('cua');
    expect(engine.version).not.toBe('unknown');
    expect(Object.keys(engine.app!).toSorted()).toEqual(['identity', 'restart']);
    expect(engine.app!.identity).toBe('com.apple.TextEdit');
    expect(engine.url).toBeDefined();
    expect(engine.state).toBeUndefined();
    expect(harness({ identity: 'textedit', environment: 'staging' }).engine.app).toMatchObject({ identity: 'textedit', environment: 'staging' });
  });
});

describe('lifecycle', () => {
  it('checks permissions once at init, launches the app fresh per attempt, kills it after, and shuts the driver down on dispose', async () => {
    const h = harness();
    await openAttempt(h);
    expect(h.clients).toBe(1);
    expect(h.fake.names()).toEqual(['check_permissions', 'launch_app']);
    expect(h.fake.lastArgs('check_permissions')).toEqual({ prompt: false });
    expect(h.fake.lastArgs('launch_app')).toEqual({ bundle_id: 'com.apple.TextEdit' });

    await h.engine.endAttempt!(cleanup());
    expect(h.fake.lastArgs('kill_app')).toEqual({ pid: PID });
    await h.engine.endAttempt!(cleanup());
    expect(h.fake.names().filter((name) => name === 'kill_app')).toHaveLength(1);

    await h.engine.startAttempt!({ attemptId: 'a2', artifactsDir, signal: new AbortController().signal });
    expect(h.fake.names().filter((name) => name === 'launch_app')).toHaveLength(2);

    await h.engine.dispose!(cleanup());
    expect(h.fake.names().at(-1)).toBe('kill_app');
    expect(h.fake.shutdowns).toBe(1);
    await h.engine.dispose!(cleanup());
    expect(h.fake.shutdowns).toBe(1);
  });

  it('launches by display name with arguments and urls, and waits for a window to appear', async () => {
    const h = harness({ app: 'TextEdit', args: ['--safe'], urls: ['/tmp/notes.txt'], window: /Untitled/ });
    let listings = 0;
    h.fake.respond('launch_app', () => ok({ pid: PID, bundle_id: 'com.apple.TextEdit', name: 'TextEdit', windows: [], launch_state: 'process_running' }));
    h.fake.respond('list_windows', () => {
      listings += 1;
      return ok({ windows: listings < 3 ? [] : [{ ...WINDOW, title: 'Other' }, WINDOW] });
    });
    await openAttempt(h);
    expect(h.fake.lastArgs('launch_app')).toEqual({ name: 'TextEdit', additional_arguments: ['--safe'], urls: ['/tmp/notes.txt'] });
    expect(h.fake.names().filter((name) => name === 'list_windows')).toHaveLength(3);
    expect(await h.engine.url!(operation())).toBe('app://desktop/com.apple.textedit/Untitled');
  });

  it('fails init in words that name the fix when Accessibility is not granted', async () => {
    const h = harness();
    h.fake.respond('check_permissions', () => ok({ accessibility: false, screen_recording: false }));
    await expect(boot(h.engine)).rejects.toMatchObject({ code: 'DESKTOP_PERMISSION_REQUIRED', message: expect.stringMatching(/System Settings/) });
  });

  it('takes a driver without a permission report at its word', async () => {
    const h = harness();
    h.fake.respond('check_permissions', () => failure('unknown_tool', 'unknown tool check_permissions'));
    await openAttempt(h);
    expect(h.fake.names()).toEqual(['check_permissions', 'launch_app']);
  });

  it('refuses a second attempt while one is running', async () => {
    const h = harness();
    await openAttempt(h);
    await expect(h.engine.startAttempt!({ attemptId: 'a2', artifactsDir, signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });
});

describe('observe', () => {
  it('asks for the window state without pixels and projects it with the anchor and viewport', async () => {
    const h = harness({ maxElements: 500, maxDepth: 12 });
    await openAttempt(h);
    const snapshot = await h.engine.observe!(operation());
    expect(h.fake.lastArgs('get_window_state')).toEqual({ pid: PID, window_id: WINDOW_ID, include_screenshot: false, max_elements: 500, max_depth: 12 });
    expect(snapshot.url).toBe('app://desktop/com.apple.textedit/Untitled');
    expect(snapshot.viewport).toEqual({ width: 600, height: 400, scale: 1 });
    expect(snapshot.pixels).toBeUndefined();
    expect(named(snapshot.nodes, 'Bold')).toMatchObject({ role: 'button', rect: { x: 10, y: 5, width: 30, height: 20 }, attributes: { 'data-testid': 'bold' } });
    expect(named(snapshot.nodes, 'Password')).toMatchObject({ states: { secure: true }, inputPurpose: 'password' });
    expect(named(snapshot.nodes, 'Password').value).toBeUndefined();
  });

  it('returns masked pixels at the screenshot scale when asked and counts the masked regions', async () => {
    const h = harness();
    h.fake.respond('get_window_state', () => ok(WINDOW_STATE, { images: [{ mimeType: 'image/png', dataBase64: screenshotPng() }] }));
    await openAttempt(h);
    const snapshot = await h.engine.observe!(operation(), { pixels: true });
    expect(h.fake.lastArgs('get_window_state')).toMatchObject({ include_screenshot: true });
    expect(snapshot.pixels).toMatchObject({ mediaType: 'image/png', width: 1200, height: 800, scale: 2 });
    expect(snapshot.maskedRegionCount).toBe(1);
    const image = decodePng(snapshot.pixels!.data);
    // The secure field spans x 20..320, y 720..760 in pixels: black inside, grey outside.
    const at = (x: number, y: number) => image.pixels[(y * image.width + x) * 4];
    expect(at(100, 740)).toBe(0);
    expect(at(100, 700)).toBe(128);
  });

  it('never asks for pixels when the host lacks Screen Recording', async () => {
    const h = harness();
    h.fake.respond('check_permissions', () => ok({ accessibility: true, screen_recording: false }));
    await openAttempt(h);
    const snapshot = await h.engine.observe!(operation(), { pixels: true });
    expect(h.fake.lastArgs('get_window_state')).toMatchObject({ include_screenshot: false });
    expect(snapshot.pixels).toBeUndefined();
    await expect(h.engine.artifacts!.screenshot('x', operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringMatching(/Screen Recording/) });
  });

  it('re-resolves the window once when the adopted window is gone', async () => {
    const h = harness();
    let calls = 0;
    h.fake.respond('get_window_state', (args) => {
      calls += 1;
      if (calls === 1) return failure('window_id_not_found', 'window 7 not found');
      return args['window_id'] === 9 ? ok(WINDOW_STATE) : failure('window_id_not_found');
    });
    h.fake.respond('list_windows', () => ok({ windows: [{ ...WINDOW, window_id: 9, title: 'Untitled 2' }] }));
    await openAttempt(h);
    const snapshot = await h.engine.observe!(operation());
    expect(snapshot.url).toBe('app://desktop/com.apple.textedit/Untitled%202');
    expect(h.fake.names().filter((name) => name === 'get_window_state')).toHaveLength(2);
    expect(h.fake.lastArgs('get_window_state')).toMatchObject({ window_id: 9 });
  });
});

describe('perform', () => {
  it('addresses every action by element token within the launched window', async () => {
    const h = harness();
    await openAttempt(h);
    const target = { pid: PID, window_id: WINDOW_ID };
    const bold = await observed(h, 'Bold');
    await h.engine.perform!(bold.ref, { kind: 'tap' }, operation());
    expect(h.fake.lastArgs('click')).toEqual({ ...target, element_token: 's1:2' });
    await h.engine.perform!(bold.ref, { kind: 'doubleTap' }, operation());
    expect(h.fake.lastArgs('double_click')).toEqual({ ...target, element_token: 's1:2' });

    const doc = await observed(h, 'Document');
    await h.engine.perform!(doc.ref, { kind: 'fill', value: 'Hi there', sensitive: false }, operation());
    expect(h.fake.lastArgs('set_value')).toEqual({ ...target, element_token: 's1:4', value: 'Hi there' });
    await h.engine.perform!(doc.ref, { kind: 'clear' }, operation());
    expect(h.fake.lastArgs('set_value')).toEqual({ ...target, element_token: 's1:4', value: '' });
    await h.engine.perform!(doc.ref, { kind: 'focus' }, operation());
    expect(h.fake.lastArgs('click')).toEqual({ ...target, element_token: 's1:4' });
    await h.engine.perform!(doc.ref, { kind: 'press', key: 'Enter' }, operation());
    expect(h.fake.lastArgs('press_key')).toEqual({ ...target, element_token: 's1:4', key: 'return' });
    await h.engine.perform!(doc.ref, { kind: 'press', key: 'Meta+a' }, operation());
    expect(h.fake.lastArgs('hotkey')).toEqual({ ...target, element_token: 's1:4', keys: ['cmd', 'a'] });
    await h.engine.perform!(doc.ref, { kind: 'swipe', direction: 'down', momentum: 'fast' }, operation());
    expect(h.fake.lastArgs('scroll')).toEqual({ ...target, element_token: 's1:4', direction: 'down', amount: 8 });

    const font = await observed(h, 'Font');
    await h.engine.perform!(font.ref, { kind: 'selectOption', value: { label: 'Menlo' } }, operation());
    expect(h.fake.lastArgs('set_value')).toEqual({ ...target, element_token: 's1:3', value: 'Menlo' });
    await h.engine.perform!(font.ref, { kind: 'selectOption', value: 'Courier' }, operation());
    expect(h.fake.lastArgs('set_value')).toMatchObject({ value: 'Courier' });
    await expect(h.engine.perform!(font.ref, { kind: 'selectOption', value: { index: 2 } }, operation())).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
  });

  it('sets toggles only when their state differs and refuses blind flips', async () => {
    const h = harness();
    await openAttempt(h);
    const wrap = await observed(h, 'Wrap');
    await h.engine.perform!(wrap.ref, { kind: 'check' }, operation());
    expect(h.fake.names().filter((name) => name === 'click')).toHaveLength(0);
    await h.engine.perform!(wrap.ref, { kind: 'uncheck' }, operation());
    expect(h.fake.lastArgs('click')).toMatchObject({ element_token: 's1:6' });
    const bold = await observed(h, 'Bold');
    await expect(h.engine.perform!(bold.ref, { kind: 'check' }, operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });

  it('uses pixel geometry for hover and drag, in the spaces the driver expects', async () => {
    const h = harness();
    await openAttempt(h);
    const bold = await observed(h, 'Bold');
    await h.engine.perform!(bold.ref, { kind: 'hover' }, operation());
    // Desktop pixels: window origin (100, 50) points at 2x, plus the button centre (50, 30) px.
    expect(h.fake.lastArgs('move_cursor')).toEqual({ scope: 'desktop', x: 250, y: 130 });
    const snapshot = await h.engine.observe!(operation());
    const from = named(snapshot.nodes, 'Bold');
    const to = named(snapshot.nodes, 'Font');
    await h.engine.perform!(from.ref, { kind: 'dragTo', target: to.ref }, operation());
    expect(h.fake.lastArgs('drag')).toEqual({ pid: PID, window_id: WINDOW_ID, from_x: 50, from_y: 30, to_x: 200, to_y: 30 });
  });

  it('refuses what a desktop window cannot do', async () => {
    const h = harness();
    await openAttempt(h);
    const bold = await observed(h, 'Bold');
    for (const kind of ['longPress', 'scrollIntoView'] as const) {
      await expect(h.engine.perform!(bold.ref, { kind }, operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    }
    await expect(h.engine.perform!(bold.ref, { kind: 'setInputFiles', paths: ['/tmp/a'] }, operation())).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
    await expect(h.engine.perform!(bold.ref, { kind: 'focus' }, operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });

  it('treats a ref from an older observation as stale, and the driver’s stale token likewise', async () => {
    const h = harness();
    await openAttempt(h);
    const bold = await observed(h, 'Bold');
    await h.engine.observe!(operation());
    await expect(h.engine.perform!(bold.ref, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    const fresh = await observed(h, 'Bold');
    h.fake.respond('click', () => failure('stale_element_token', 'token superseded by a newer snapshot'));
    await expect(h.engine.perform!(fresh.ref, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
  });

  it('reports partial delivery and refusals as the contract errors', async () => {
    const h = harness();
    await openAttempt(h);
    const doc = await observed(h, 'Document');
    h.fake.respond('set_value', () => acted('partial'));
    await expect(h.engine.perform!(doc.ref, { kind: 'fill', value: 'x', sensitive: false }, operation())).rejects.toMatchObject({
      code: 'ACTION_MAY_HAVE_COMMITTED',
    });
    h.fake.respond('click', () => acted('refused'));
    await expect(h.engine.perform!(doc.ref, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
  });

  it('scrolls the window at its centre for a viewport swipe', async () => {
    const h = harness();
    await openAttempt(h);
    await h.engine.observe!(operation());
    await h.engine.swipe!('down', undefined, operation());
    expect(h.fake.lastArgs('scroll')).toEqual({ pid: PID, window_id: WINDOW_ID, x: 600, y: 400, direction: 'down', amount: 3 });
  });
});

describe('locate', () => {
  it('resolves queries against a fresh snapshot and keeps located refs actionable across observations', async () => {
    const h = harness();
    await openAttempt(h);
    const [bold] = await h.engine.locate!(roleQuery('button', 'Bold'), operation());
    expect(bold?.name).toBe('Bold');
    expect(h.fake.lastArgs('get_window_state')).toMatchObject({ include_screenshot: false });
    await h.engine.observe!(operation());
    await h.engine.perform!(bold!.ref, { kind: 'tap' }, operation());
    expect(h.fake.lastArgs('click')).toMatchObject({ element_token: 's1:2' });
    expect(await h.engine.locate!({ kind: 'selector', selector: 'id=bold' }, operation())).toHaveLength(1);
    expect(await h.engine.locate!(roleQuery('link'), operation())).toEqual([]);
  });
});

describe('artifacts', () => {
  it('writes a masked screenshot under the attempt directory', async () => {
    const h = harness();
    h.fake.respond('get_window_state', () => ok(WINDOW_STATE, { images: [{ mimeType: 'image/png', dataBase64: screenshotPng() }] }));
    await openAttempt(h);
    const relative = await h.engine.artifacts!.screenshot('after save', operation());
    expect(relative).toBe(path.join('screenshots', '001-after_save.png'));
    const file = path.join(artifactsDir, relative);
    expect(existsSync(file)).toBe(true);
    const image = decodePng(new Uint8Array(readFileSync(file)));
    expect(image.pixels[(740 * image.width + 100) * 4]).toBe(0);
    expect(await h.engine.artifacts!.screenshot(undefined, operation())).toBe(path.join('screenshots', '002-screenshot.png'));
  });

  it('withholds a screenshot the driver did not return', async () => {
    const h = harness();
    await openAttempt(h);
    await expect(h.engine.artifacts!.screenshot('x', operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });
});

describe('app hooks', () => {
  it('restarts by killing and relaunching', async () => {
    const h = harness();
    await openAttempt(h);
    await h.engine.app!.restart!(operation());
    expect(h.fake.names().slice(-2)).toEqual(['kill_app', 'launch_app']);
  });
});

describe('desktop fixture', () => {
  function fixture(h: Harness): Desktop {
    const recorded: string[] = [];
    const context = {
      targetName: 'mac',
      fixture: <T extends object>(_name: string, surface: T, operations: object) => {
        recorded.push(...Object.keys(operations));
        return surface;
      },
      locator: (expression: LocatorExpression) => expression as never,
      signal: new AbortController().signal,
    } as unknown as EngineFixtureContext;
    const desktop = h.engine.fixtures!['desktop']!(context) as Desktop;
    expect(recorded.toSorted()).toEqual(['hotkey', 'menu', 'window']);
    return desktop;
  }

  it('invokes menus, sends chords, reads the window, and mints selector locators', async () => {
    const h = harness();
    await openAttempt(h);
    const desktop = fixture(h);
    await desktop.menu(['File', 'New']);
    expect(h.fake.lastArgs('invoke_menu')).toEqual({ pid: PID, window_id: WINDOW_ID, path: ['File', 'New'] });
    await desktop.hotkey('Meta+n');
    expect(h.fake.lastArgs('hotkey')).toEqual({ pid: PID, window_id: WINDOW_ID, keys: ['cmd', 'n'] });
    await desktop.hotkey('Escape');
    expect(h.fake.lastArgs('press_key')).toEqual({ pid: PID, window_id: WINDOW_ID, key: 'escape' });
    expect(await desktop.window()).toEqual({ title: 'Untitled', bounds: { x: 100, y: 50, width: 600, height: 400 } });
    expect(desktop.locator('id=bold')).toEqual({ kind: 'selector', selector: 'id=bold' });
  });
});
