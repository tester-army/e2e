/**
 * Registers e2e's TypeScript loader as a side effect, for `node --import`:
 * how a worker runs e2e from its TypeScript source in this repository
 * (`run/worker/handle.ts`). Node.js loads this module and `esm-hooks.ts`
 * with its own type stripping, before the loader exists, so they hold to
 * erasable TypeScript.
 */

import { registerLoader } from './esm-hooks.ts';

registerLoader();
