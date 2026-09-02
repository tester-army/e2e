/**
 * Minimal declaration of the `@e2edev/playwright` factory, so the canonical
 * examples can name the web backend the way a project does. The package's
 * full surface (the `web` fixture, `expect(web)`, the typed `test`) is not
 * part of the SDK contract; only the factory shape a target consumes is.
 */

import type { BackendHandle } from 'e2e';

export interface PlaywrightOptions {
  browser?: 'chromium' | 'firefox' | 'webkit';
  viewport?: { width: number; height: number };
}

/** The browser backend: a `defineBackend` handle a web target passes as `backend`. */
export function playwright(options?: PlaywrightOptions): BackendHandle;
