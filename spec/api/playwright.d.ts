/**
 * Minimal declaration of the `@e2edev/playwright` factory, so the canonical
 * examples can name the web backend the way a project does. The package's
 * full surface (the `web` fixture, `expect(web)`, the typed `test`) is not
 * part of the SDK contract; only the factory shape a target consumes is.
 */

import type { BackendAppDeclaration, BackendHandle } from '@e2edev/e2e';

/**
 * The browser backend's options: the app it drives (`url`, `command`,
 * `readyUrl`, `allowedOrigins`, `environment`, `identity` - the backend
 * contract's app declaration) plus the browser itself.
 */
export interface PlaywrightOptions extends BackendAppDeclaration {
  browser?: 'chromium' | 'firefox' | 'webkit';
  viewport?: { width: number; height: number };
}

/** The browser backend: a `defineBackend` handle a web target passes as `backend`. */
export function playwright(options?: PlaywrightOptions): BackendHandle;
