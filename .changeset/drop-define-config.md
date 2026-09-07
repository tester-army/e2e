---
"@e2edev/e2e": minor
---

`defineConfig` is gone. An `e2e.config.ts` default-exports the object literal
and ends it with `satisfies E2EConfig`, which gives the same completion and
unknown-key checks without a runtime import from `@e2edev/e2e`.

```ts
// before
import { defineConfig } from '@e2edev/e2e';
export default defineConfig({ targets: [...] });

// after
import type { E2EConfig } from '@e2edev/e2e';
export default { targets: [...] } satisfies E2EConfig;
```
