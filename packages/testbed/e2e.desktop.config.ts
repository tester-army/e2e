/**
 * Opt-in desktop suite on the `@e2edev/cua` engine: one honest macOS target,
 * TextEdit, launched fresh for every attempt and quit after it, so each test
 * starts on an empty untitled document. Deterministic only: `screen`,
 * `expect`, and the `desktop` fixture, no model. Run manually:
 *
 *   pnpm --filter @e2edev/testbed test:desktop
 *
 * Requires Accessibility (and Screen Recording for screenshots) granted to the
 * terminal or IDE the command runs from. Not part of CI: the hosted runner's
 * grants are pre-installed but unverified for this engine, and the suite
 * launches a real app on the desktop.
 */

import type { E2EConfig } from '@e2edev/e2e';
import { cua } from '@e2edev/cua';

export default {
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-desktop',
  tests: 'tests-desktop/**/*.e2e.ts',
  targets: [
    {
      name: 'textedit',
      platform: 'macos',
      engine: cua({ app: 'com.apple.TextEdit', window: /Untitled/ }),
    },
  ],
  timeout: 120_000,
  actionTimeout: 30_000,
  workers: 1,
  cache: 'off',
} satisfies E2EConfig;
