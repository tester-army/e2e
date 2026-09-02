/**
 * The Playwright backend for e2e (RFC0002): a browser body built with the
 * public `defineBackend`, validated by the same rules and graded by the same
 * capabilities as any other backend. Core imports nothing from here; this
 * package imports the contract from `e2e/backend` and contributes the `web`
 * fixture the way a device backend contributes `device`.
 */

import { defineBackend, type BackendHandle } from 'e2e/backend';
import { packageVersion } from 'e2e/internal';
import { PlaywrightSurface, type PlaywrightOptions } from './surface.ts';
import { createWebFixture } from './web.ts';

/** Creates one Playwright backend: one browser per worker, one context per attempt. */
export function playwright(options: PlaywrightOptions = {}): BackendHandle {
  const surface = new PlaywrightSurface(options);
  return defineBackend({
    name: 'playwright',
    version: packageVersion(import.meta.url, '../package.json', 'unknown'),
    spiVersion: 1,
    init: (info) => surface.init(info),
    startAttempt: (context) => surface.startAttempt(context),
    endAttempt: () => surface.endAttempt(),
    dispose: () => surface.dispose(),
    observe: (operation, observeOptions) => surface.observe(operation, observeOptions),
    locate: (expression, operation) => surface.locate(expression, operation),
    perform: (ref, action, operation) => surface.perform(ref, action, operation),
    swipe: (direction, momentum, operation) => surface.swipe(direction, momentum, operation),
    actions: {
      tap: (target, operation) => surface.perform(target.ref, { kind: 'tap' }, operation),
      type: (target, value, operation) =>
        surface.perform(target.ref, { kind: 'fill', value, sensitive: false }, operation),
      press: (target, key, operation) => surface.perform(target.ref, { kind: 'press', key }, operation),
      select: (target, value, operation) =>
        surface.perform(target.ref, { kind: 'selectOption', value }, operation),
      scroll: (direction, target, operation) => surface.scroll(direction, target, operation),
      navigate: (url, operation) => surface.navigate(url, operation),
      back: (operation) => surface.back(operation),
    },
    app: {
      restart: (operation) => surface.restart(operation),
      clearState: (operation) => surface.clearState(operation),
    },
    artifacts: {
      screenshot: (label, operation) => surface.screenshot(label, operation),
      startTrace: (operation) => surface.startTrace(operation),
      stopTrace: (operation) => surface.stopTrace(operation),
    },
    state: {
      capture: (operation) => surface.captureState(operation),
      restore: (state, operation) => surface.restoreState(state, operation),
    },
    url: (operation) => surface.url(operation),
    fixtures: {
      web: (context) => createWebFixture(surface, context),
    },
  });
}
