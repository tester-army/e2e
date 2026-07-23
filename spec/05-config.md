# 05 — Configuration

Config lives in `e2e.config.ts` at the project root. It is optional: with no
config file, `npx e2e run` uses defaults and `APP_URL` from env.

```ts
import { defineConfig } from 'e2e';

export default defineConfig({
  app: {
    url: process.env.APP_URL,
  },
  browser: 'chromium',
  retries: 1,
  artifacts: ['trace', 'screenshot'],
});
```

## Full shape

```ts
type E2EConfig = {
  /** App under test. */
  app?: {
    /** Base URL. app.open('/') resolves against it. */
    url?: string;
    /** Command to boot the app locally before tests (dev-server style). */
    command?: string;
    /** Wait for this URL to respond before starting. Defaults to app.url. */
    readyUrl?: string;
  };

  /**
   * Cross-platform targets (see 08-platforms.md). Default: one implicit
   * web target using app.url. Each test runs once per matching target.
   */
  targets?: Target[];

  /** Browser engine for the implicit web target. Default: 'chromium'. */
  browser?: 'chromium' | 'firefox' | 'webkit';

  /** Test file glob(s). Default: 'tests/**/*.e2e.ts'. */
  tests?: string | string[];

  /** Per-test timeout ms. Default: 120_000. */
  timeout?: number;

  /** Retries per test. Default: 0 locally, 1 in CI. */
  retries?: number;

  /** Parallel workers. Default: CPU-based locally, 1 in CI. */
  workers?: number;

  /** What to save on failure. Default: ['trace', 'screenshot']. */
  artifacts?: Array<'trace' | 'screenshot' | 'video'>;

  /** Cross-platform query layer (see 08-platforms.md). */
  screen?: {
    /** Web attribute for getByTestId. Default: 'data-testid'. */
    testIdAttribute?: string;
  };

  /** Agent behavior. */
  agent?: {
    /** Model provider/id, e.g. 'anthropic/claude-…'. Default: bundled recommendation. */
    model?: string;
    /** Global cap on steps per agent.act(). Default: 25. */
    maxSteps?: number;
    /** Record/replay successful action paths as guidance (see 10-determinism.md). Default: true. */
    cache?: boolean;
    /** Ambient context for every agent invocation (see 10-determinism.md). */
    context?: string;
  };

  /** Named credentials (see 04-resources.md). */
  credentials?: Record<string, {
    username: string;
    password: string; // reference env: process.env.ADMIN_PASSWORD!
  }>;

  /**
   * Resource backends, per extension (post-v0; e.g. email: 'local' |
   * 'managed'). Reserved — v0's only resource (credentials) resolves via
   * env/config.
   */
  resources?: Record<string, string>;
};
```

Reserved for the cloud roadmap (see roadmap/cloud.md), not in v0:
`runner`, `project`, `token`, and the `e2e.cloud.config.ts` overlay.

## Environment variables

| Var | Meaning |
|---|---|
| `APP_URL` | default `app.url` |
| `E2E_USER_<NAME>_USERNAME` / `_PASSWORD` | credential resolution |
| `CI` | flips CI defaults (retries, workers, reporters) |

## Defaults philosophy

Every field optional. A user with `APP_URL` set and tests in `tests/` needs
zero config. Config exists for the second day, not the first.
