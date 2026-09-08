/**
 * The Cua Driver engine for e2e: a desktop body built with the public
 * `defineEngine`, validated by the same rules and graded by the same
 * capabilities as any other engine. Core imports nothing from here; this
 * package imports the contract from `@e2edev/e2e/engine` and contributes the
 * `desktop` fixture the way the browser engine contributes `web`.
 */

import { createRequire } from 'node:module';
import { defineEngine, obj, type EngineAppDeclaration, type EngineHandle } from '@e2edev/e2e/engine';
import { createDriverClient, type ClientFactory } from './client.ts';
import { createDesktopFixture } from './desktop.ts';
import { CuaSurface, type CuaOptions } from './surface.ts';

/** Assembles the manifest for one surface. Exported for tests that script the client. */
export function buildEngine(surface: CuaSurface): EngineHandle {
  return defineEngine({
    name: 'cua',
    version: ownVersion(),
    spiVersion: 1,
    init: (info) => surface.init(info),
    startAttempt: (context) => surface.startAttempt(context),
    endAttempt: (context) => surface.endAttempt(context),
    dispose: (context) => surface.dispose(context),
    observe: (operation, options) => surface.observe(operation, options),
    locate: (expression, operation) => surface.locate(expression, operation),
    perform: (ref, action, operation) => surface.perform(ref, action, operation),
    swipe: (direction, momentum, operation) => surface.swipe(direction, momentum, operation),
    app: {
      ...declaredApp(surface.options),
      restart: (operation) => surface.restart(operation),
    },
    artifacts: {
      screenshot: (label, operation) => surface.screenshot(label, operation),
    },
    url: (operation) => surface.url(operation),
    fixtures: {
      desktop: (context) => createDesktopFixture(surface, context),
    },
  });
}

/** Creates one Cua Driver engine: one in-process driver per worker, one fresh app launch per attempt. */
export function cua(options: CuaOptions): EngineHandle {
  const factory: ClientFactory = () => createDriverClient();
  return buildEngine(new CuaSurface(options, factory));
}

/** What the desktop engine declares about its app: the launched app is the identity cache and session entries key on. */
function declaredApp(options: CuaOptions): Pick<EngineAppDeclaration, 'identity' | 'environment'> {
  return obj({
    identity: options.identity ?? options.app,
    environment: options.environment,
  });
}

/** This package's published version, read through require resolution. */
function ownVersion(): string {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
