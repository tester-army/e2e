/**
 * The tmux backend for e2e (RFC0002): a terminal body built with the public
 * `defineBackend`, validated by the same rules and graded by the same
 * capabilities as any other backend. Core imports nothing from here; this
 * package imports the contract from `@e2edev/e2e/backend` and contributes the
 * `terminal` fixture the way the browser backend contributes `web`.
 */

import { createRequire } from 'node:module';
import { defineBackend, type BackendHandle } from '@e2edev/e2e/backend';
import { TmuxSurface, type TmuxOptions } from './surface.ts';
import { createTerminalFixture } from './terminal.ts';

const surfaces = new WeakMap<BackendHandle, TmuxSurface>();

/** Assembles the manifest for one surface. Exported for tests that script the tmux runner. */
export function buildBackend(surface: TmuxSurface): BackendHandle {
  const handle = defineBackend({
    name: 'tmux',
    version: ownVersion(),
    spiVersion: 1,
    prepare: (info) => surface.prepare(info),
    init: (info) => surface.init(info),
    startAttempt: (context) => surface.startAttempt(context),
    endAttempt: (context) => surface.endAttempt(context),
    dispose: (context) => surface.dispose(context),
    observe: (operation) => surface.observe(operation),
    locate: (expression, operation) => surface.locate(expression, operation),
    perform: (ref, action, operation) => surface.perform(ref, action, operation),
    swipe: (direction, momentum, operation) => surface.swipe(direction, momentum, operation),
    app: {
      restart: (operation) => surface.restart(operation),
    },
    url: (operation) => surface.url(operation),
    fixtures: {
      terminal: (context) => createTerminalFixture(surface, context),
    },
  });
  surfaces.set(handle, surface);
  return handle;
}

/** Creates one tmux backend: one session per worker, one window running `command` per attempt. */
export function tmux(options: TmuxOptions): BackendHandle {
  return buildBackend(new TmuxSurface(options));
}

/** The surface behind a handle this package created; undefined for any other backend. */
export function surfaceOf(backend: BackendHandle): TmuxSurface | undefined {
  return surfaces.get(backend);
}

/** This package's published version, read through require resolution. */
function ownVersion(): string {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
