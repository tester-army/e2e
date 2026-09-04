/**
 * The tmux backend through the public contract, with a scripted runner:
 * lifecycle order, the tmux command line each contract member issues, id
 * staleness, the path anchor, and the contributed fixture. No tmux server:
 * what is asserted is the command stream, which is the whole of what this
 * backend owes tmux.
 */

import { describe, expect, it } from 'vitest';
import {
  BackendError,
  type BackendFixtureContext,
  type BackendHandle,
  type OperationContext,
  type SemanticNode,
} from '@e2edev/e2e/backend';
import { buildBackend } from '../../src/backend.ts';
import { TmuxSurface, type TmuxOptions } from '../../src/surface.ts';
import { createTerminalFixture } from '../../src/terminal.ts';
import { createFakeTmux, type FakeTmux } from '../helpers/fake-tmux.ts';

const PROJECT_ROOT = '/project';

function operation(signal = new AbortController().signal): OperationContext {
  return { signal, timeoutMs: 30_000, runId: 'run-1', attemptId: 'a1' };
}

function cleanup() {
  return { signal: new AbortController().signal, timeoutMs: 5_000 };
}

interface Harness {
  readonly backend: BackendHandle;
  readonly fake: FakeTmux;
  readonly surface: TmuxSurface;
}

/** A backend over the scripted runner; `ready` false leaves the ready text out so the attempt settles instead. */
function harness(options: Partial<TmuxOptions> = {}, ready = true): Harness {
  const fake = createFakeTmux();
  const surface = new TmuxSurface(
    { command: 'opencode --pure', ...(ready ? { ready: 'Ask anything' } : {}), ...options },
    fake.factory,
  );
  return { backend: buildBackend(surface), fake, surface };
}

async function boot(h: Harness, targetName = 'opencode'): Promise<void> {
  await h.backend.init!({
    runId: 'run 1',
    targetName,
    projectRoot: PROJECT_ROOT,
    app: { allowedOrigins: [] },
    testIdAttribute: 'data-testid',
    headed: false,
    signal: new AbortController().signal,
  });
}

async function openAttempt(h: Harness): Promise<void> {
  await boot(h);
  await h.backend.startAttempt!({ attemptId: 'a1', artifactsDir: '/tmp/none', signal: new AbortController().signal });
}

async function observed(h: Harness, name: string | RegExp): Promise<SemanticNode> {
  const snapshot = await h.backend.observe!(operation());
  const found = [...walk(snapshot.nodes)].find((node) =>
    typeof name === 'string' ? node.name === name : node.name !== undefined && name.test(node.name),
  );
  if (found === undefined) throw new Error(`no node named ${String(name)}`);
  return found;
}

function* walk(nodes: readonly SemanticNode[]): Generator<SemanticNode> {
  for (const node of nodes) {
    yield node;
    yield* walk(node.children ?? []);
  }
}

async function failure(run: () => Promise<unknown>): Promise<BackendError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof BackendError) return error;
    throw error;
  }
  throw new Error('expected a BackendError');
}

describe('manifest', () => {
  it('declares observation, actions, location, the terminal fixture, restart, and a url', () => {
    const { backend } = harness();
    expect([...backend.capabilities].toSorted()).toEqual(['actions', 'location', 'observation', 'terminal']);
    expect(backend.name).toBe('tmux');
    expect(backend.version).not.toBe('unknown');
    expect(Object.keys(backend.app!)).toEqual(['restart']);
    expect(backend.url).toBeDefined();
    expect(backend.prepare).toBeDefined();
    expect(backend.artifacts).toBeUndefined();
    expect(backend.state).toBeUndefined();
  });

  it('refuses a backend without a command', () => {
    expect(() => new TmuxSurface({ command: ' ' })).toThrow(/command/);
  });
});

describe('lifecycle', () => {
  it('opens a private server per run, a session per worker, and a window per attempt', async () => {
    const h = harness({ cwd: 'workspace', env: { XDG_CONFIG_HOME: '/tmp/xdg' }, columns: 100, rows: 30 });
    await openAttempt(h);
    expect(h.fake.sockets).toEqual(['e2e-run-1']);
    expect(h.fake.commands().slice(0, 3)).toEqual(['kill-session', 'new-session', 'new-window']);

    const [session] = h.fake.of('new-session');
    expect(session).toEqual(expect.arrayContaining(['-s', 'e2e-opencode', '-x', '100', '-y', '30', '-c', '/project/workspace']));
    expect(session!.join(' ')).toContain('set-option -g -q remain-on-exit on');
    expect(session!.join(' ')).toContain('set-option -g -q status off');
    expect(session!.join(' ')).toContain('set-option -t e2e-opencode -q window-size manual');

    const [window] = h.fake.of('new-window');
    expect(window).toEqual([
      'new-window', '-P', '-F', '#{window_id}', '-t', 'e2e-opencode:', '-c', '/project/workspace',
      '-e', 'XDG_CONFIG_HOME=/tmp/xdg', '--', 'opencode --pure',
    ]);
    // The ready text is on the canned screen, so one capture is enough.
    expect(h.fake.of('display-message')).toHaveLength(1);
    expect(h.surface.attemptRunning).toBe(true);

    await h.backend.endAttempt!(cleanup());
    expect(h.fake.of('kill-window').at(-1)).toEqual(['kill-window', '-t', '@1']);
    expect(h.surface.attemptRunning).toBe(false);
    await h.backend.endAttempt!(cleanup());
    expect(h.fake.of('kill-window')).toHaveLength(1);

    await h.backend.dispose!(cleanup());
    expect(h.fake.of('kill-session').at(-1)).toEqual(['kill-session', '-t', '=e2e-opencode']);
    await h.backend.dispose!(cleanup());
  });

  it('names the session after the option and boots again after dispose', async () => {
    const h = harness({ session: 'demo' });
    await openAttempt(h);
    expect(h.fake.of('new-session')[0]).toEqual(expect.arrayContaining(['-s', 'demo']));
    await h.backend.endAttempt!(cleanup());
    await h.backend.dispose!(cleanup());
    await openAttempt(h);
    expect(h.fake.of('new-session')).toHaveLength(2);
  });

  it('fails the attempt launch when the program exits before its ready text', async () => {
    const h = harness();
    h.fake.screen.lines = ['opencode: command not found', '', '', '', '', ''];
    h.fake.screen.dead = true;
    h.fake.screen.exitStatus = 127;
    await boot(h);
    const error = await failure(() =>
      h.backend.startAttempt!({ attemptId: 'a1', artifactsDir: '/tmp/none', signal: new AbortController().signal }),
    );
    expect(error.code).toBe('INVALID_STATE');
    expect(error.message).toContain('status 127');
    expect(error.message).toContain('command not found');
  });

  it('gives up on the ready text when the launch signal aborts, quoting the screen', async () => {
    const h = harness();
    h.fake.screen.lines = ['loading...', '', '', '', '', ''];
    await boot(h);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const error = await failure(() => h.backend.startAttempt!({ attemptId: 'a1', artifactsDir: '/tmp/none', signal: controller.signal }));
    expect(error.code).toBe('CANCELLED');
    expect(error.message).toContain('loading...');
  });

  it('settles on a still screen when no ready text is configured', async () => {
    const h = harness({}, false);
    await openAttempt(h);
    expect(h.fake.of('display-message').length).toBeGreaterThanOrEqual(2);
  });

  it('restarts by replacing the window', async () => {
    const h = harness();
    await openAttempt(h);
    await h.backend.app!.restart!(operation());
    expect(h.fake.of('kill-window')).toEqual([['kill-window', '-t', '@1']]);
    expect(h.fake.of('new-window')).toHaveLength(2);
    await h.backend.perform!((await observed(h, /Ask anything/)).ref, { kind: 'press', key: 'Enter' }, operation());
    expect(h.fake.of('send-keys').at(-1)).toEqual(['send-keys', '-t', '@2', 'Enter']);
  });
});

describe('observe and locate', () => {
  it('captures the pane once per observation and mints fresh ids each time', async () => {
    const h = harness();
    await openAttempt(h);
    const first = await h.backend.observe!(operation());
    expect(first.viewport).toEqual({ width: 60, height: 6, scale: 1 });
    const root = first.nodes[0]!;
    expect(root.role).toBe('application');
    expect(root.name).toBe('OpenCode');
    const second = await h.backend.observe!(operation());
    expect(second.nodes[0]!.ref.id).not.toBe(root.ref.id);
    expect(h.fake.of('display-message')).toHaveLength(3);
  });

  it('locates rows by text and keeps located ids valid for actions', async () => {
    const h = harness();
    await openAttempt(h);
    const matches = await h.backend.locate!(
      { kind: 'query', query: { kind: 'text', value: { kind: 'string', value: 'ctrl+p', exact: false } } },
      operation(),
    );
    expect(matches).toHaveLength(1);
    await h.backend.perform!(matches[0]!.ref, { kind: 'press', key: 'Escape' }, operation());
    expect(h.fake.of('send-keys').at(-1)).toEqual(['send-keys', '-t', '@1', 'Escape']);
  });
});

describe('perform', () => {
  it('types literally, presses named keys and chords, and refuses what a terminal cannot do', async () => {
    const h = harness();
    await openAttempt(h);
    const prompt = await observed(h, /Ask anything/);
    expect(prompt.role).toBe('textbox');
    expect(prompt.states).toEqual({ focused: true });

    await h.backend.perform!(prompt.ref, { kind: 'fill', value: 'create hello.txt; then -x', sensitive: false }, operation());
    expect(h.fake.of('send-keys').at(-1)).toEqual(['send-keys', '-t', '@1', '-l', '--', 'create hello.txt; then -x']);
    await h.backend.perform!(prompt.ref, { kind: 'press', key: 'Enter' }, operation());
    expect(h.fake.of('send-keys').at(-1)).toEqual(['send-keys', '-t', '@1', 'Enter']);
    await h.backend.perform!(prompt.ref, { kind: 'press', key: 'Control+C' }, operation());
    expect(h.fake.of('send-keys').at(-1)).toEqual(['send-keys', '-t', '@1', 'C-c']);
    await h.backend.perform!(prompt.ref, { kind: 'press', key: 'x' }, operation());
    expect(h.fake.of('send-keys').at(-1)).toEqual(['send-keys', '-t', '@1', '-l', '--', 'x']);
    await h.backend.perform!(prompt.ref, { kind: 'focus' }, operation());

    for (const kind of ['clear', 'check', 'hover', 'scrollIntoView'] as const) {
      const error = await failure(() => h.backend.perform!(prompt.ref, { kind }, operation()));
      expect(error.code).toBe('UNSUPPORTED_CAPABILITY');
    }
  });

  it('taps by writing an SGR mouse click at the middle of the row when the program reads the mouse', async () => {
    const h = harness();
    await openAttempt(h);
    const status = await observed(h, 'ctrl+p commands');
    await h.backend.perform!(status.ref, { kind: 'tap' }, operation());
    const call = h.fake.of('send-keys').at(-1)!;
    expect(call.slice(0, 4)).toEqual(['send-keys', '-t', '@1', '-H']);
    const bytes = Buffer.from(call.slice(4).map((hex) => Number.parseInt(hex, 16)));
    // Row 4 and column 37 + 15 / 2 = 44, both one-based on the wire: the
    // click lands on this column, not on "tab agents" to its left.
    expect(bytes.toString('utf8')).toBe('\u001b[<0;45;5M\u001b[<0;45;5m');

    await h.backend.perform!(status.ref, { kind: 'doubleTap' }, operation());
    expect(h.fake.of('send-keys').at(-1)!.length).toBe(4 + bytes.length * 2);
  });

  it('refuses a tap when the program has not enabled mouse input', async () => {
    const h = harness();
    await openAttempt(h);
    const status = await observed(h, 'ctrl+p commands');
    h.fake.screen.mouse = false;
    const error = await failure(() => h.backend.perform!(status.ref, { kind: 'tap' }, operation()));
    expect(error.code).toBe('NOT_ACTIONABLE');
    expect(h.fake.of('send-keys')).toHaveLength(0);
  });

  it('scrolls with wheel reports in mouse mode and page keys otherwise', async () => {
    const h = harness();
    await openAttempt(h);
    await h.backend.swipe!('down', undefined, operation());
    const wheel = h.fake.of('send-keys').at(-1)!;
    expect(wheel[3]).toBe('-H');
    expect(Buffer.from(wheel.slice(4).map((hex) => Number.parseInt(hex, 16))).toString('utf8')).toBe(
      '\u001b[<65;31;4M'.repeat(3),
    );
    h.fake.screen.mouse = false;
    await h.backend.swipe!('up', 'fast', operation());
    expect(h.fake.of('send-keys').at(-1)).toEqual(['send-keys', '-t', '@1', 'PPage']);
    const error = await failure(() => h.backend.swipe!('left', undefined, operation()));
    expect(error.code).toBe('NOT_ACTIONABLE');
  });

  it('rejects a ref from an older observation as retryable NODE_STALE', async () => {
    const h = harness();
    await openAttempt(h);
    const prompt = await observed(h, /Ask anything/);
    await h.backend.observe!(operation());
    const error = await failure(() => h.backend.perform!(prompt.ref, { kind: 'press', key: 'Enter' }, operation()));
    expect(error.code).toBe('NODE_STALE');
    expect(error.retryable).toBe(true);
  });

  it('is INVALID_STATE outside an attempt', async () => {
    const h = harness();
    await boot(h);
    const error = await failure(() => h.backend.observe!(operation()));
    expect(error.code).toBe('INVALID_STATE');
  });
});

describe('url', () => {
  it('anchors on the program and the pane title', async () => {
    const h = harness({ command: '/opt/bin/opencode --pure' });
    await openAttempt(h);
    expect(await h.backend.url!(operation())).toBe('app://terminal/opencode/OpenCode');
    h.fake.screen.title = 'OpenCode - Help dialog';
    expect(await h.backend.url!(operation())).toBe('app://terminal/opencode/OpenCode%20-%20Help%20dialog');
    h.fake.screen.title = '';
    expect(await h.backend.url!(operation())).toBe('app://terminal/opencode/');
  });
});

describe('terminal fixture', () => {
  function fixtureContext(signal = new AbortController().signal): BackendFixtureContext {
    return {
      targetName: 'opencode',
      app: { allowedOrigins: [], resolveUrl: (url) => url },
      timeouts: { test: 60_000, action: 400, assertion: 5_000 },
      signal,
      operation: () => operation(signal),
      attachArtifact: () => undefined,
      attachViewport: () => undefined,
      locator: () => {
        throw new Error('unused');
      },
      screen: () => {
        throw new Error('unused');
      },
      expectable: (target) => target as never,
    };
  }

  it('reads the screen, types, presses, sends chords, and reports the cwd', async () => {
    const h = harness({ cwd: 'ws' });
    await openAttempt(h);
    const terminal = createTerminalFixture(h.surface, fixtureContext());
    expect(terminal.cwd).toBe('/project/ws');
    expect(await terminal.text()).toBe(
      [
        '',
        '   |  Ask anything... "Fix a TODO in the codebase"',
        '',
        '   |  Build - Claude Haiku 4.5 (latest) Anthropic',
        '                         tab agents  ctrl+p commands',
      ].join('\n'),
    );
    await terminal.type('/help');
    expect(h.fake.of('send-keys').at(-1)).toEqual(['send-keys', '-t', '@1', '-l', '--', '/help']);
    await terminal.press('ArrowDown');
    expect(h.fake.of('send-keys').at(-1)).toEqual(['send-keys', '-t', '@1', 'Down']);
    await terminal.send('C-x', 'C-c');
    expect(h.fake.of('send-keys').at(-1)).toEqual(['send-keys', '-t', '@1', 'C-x', 'C-c']);
    expect(await terminal.cursor()).toEqual({ x: 6, y: 1 });
    expect(await terminal.title()).toBe('OpenCode');
    expect(await terminal.exited()).toBe(false);
    await terminal.resize(80, 24);
    expect(h.fake.of('resize-window').at(-1)).toEqual(['resize-window', '-t', '@1', '-x', '80', '-y', '24']);
  });

  it('waits for text and for exit, and times out with OPERATION_TIMEOUT quoting the screen', async () => {
    const h = harness();
    await openAttempt(h);
    const terminal = createTerminalFixture(h.surface, fixtureContext());
    expect(await terminal.waitForText(/ctrl\+p/)).toBe('tab agents  ctrl+p commands');
    setTimeout(() => {
      h.fake.screen.lines[2] = '   Help                    esc/enter';
    }, 120);
    expect(await terminal.waitForText('Help')).toBe('Help                    esc/enter');

    const missing = await failure(() => terminal.waitForText('never printed', { timeout: 150 }));
    expect(missing.code).toBe('OPERATION_TIMEOUT');
    expect(missing.message).toContain('Ask anything');

    const running = await failure(() => terminal.waitForExit({ timeout: 150 }));
    expect(running.code).toBe('OPERATION_TIMEOUT');
    setTimeout(() => {
      h.fake.screen.dead = true;
      h.fake.screen.exitStatus = 0;
    }, 120);
    expect(await terminal.waitForExit()).toBe(0);
    expect(await terminal.exited()).toBe(true);
  });

  it('reads the scrollback through capture-pane with a history start', async () => {
    const h = harness();
    await openAttempt(h);
    const terminal = createTerminalFixture(h.surface, fixtureContext());
    const history = await terminal.scrollback(50);
    expect(h.fake.of('capture-pane').at(-1)).toEqual(['capture-pane', '-p', '-t', '@1', '-S', '-50']);
    expect(history.endsWith('tab agents  ctrl+p commands')).toBe(true);
  });
});
