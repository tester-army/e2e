/** The standalone owner uses web's declared pinned dependency in the selected checkout. */
import { createRequire } from 'node:module';
import { join } from 'node:path';

export function loadMaskBrowserRuntime(root) {
  const require = createRequire(join(root, 'packages/web/package.json'));
  return {
    version: require('playwright-core/package.json').version,
    browsers: require('playwright-core'),
  };
}
