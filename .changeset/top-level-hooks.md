---
'e2e': minor
'@e2e-dev/web': minor
'@e2e-dev/mobile': minor
---

`describe`, `beforeEach`, `afterEach`, `beforeAll`, and `afterAll` are top-level exports of `e2e`, the same functions as `test.describe` and the `test.*` hooks: `import { describe, beforeEach, test } from 'e2e'`. `@e2e-dev/web` and `@e2e-dev/mobile` export `describe` and all four hooks beside `test`, typed with their `browser` or `device` fixture, so a test file registers from one import. `test.describe` and the `test.*` hooks stay, and are how a `test.extend()` chain registers hooks that see its fixtures.
