/**
 * Minimal declaration of the `@e2edev/playwright` factory, so the canonical
 * examples can name the web engine the way a project does. The package's
 * full surface (the `web` fixture, `expect(web)`, the typed `test`) is not
 * part of the SDK contract; only the factory shape a target consumes is.
 */

import type { EngineAppDeclaration, EngineHandle } from '@e2edev/e2e';

/**
 * The browser engine's options: the app it drives (`url`, `command`,
 * `readyUrl`, `allowedOrigins`, `environment`, `identity` - the engine
 * contract's app declaration) plus the browser itself.
 */
export interface PlaywrightOptions extends EngineAppDeclaration {
  browser?: 'chromium' | 'firefox' | 'webkit';
  viewport?: { width: number; height: number };
}

/** The browser engine: a `defineEngine` handle a web target passes as `engine`. */
export function playwright(options?: PlaywrightOptions): EngineHandle;
