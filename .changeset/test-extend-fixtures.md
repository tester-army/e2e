---
"@e2edev/e2e": minor
---

`test.extend(fixtures)` defines your own fixtures with setup and teardown, in
Playwright's shape: everything before `await use(value)` runs before each
attempt's hooks and body, `value` is what the test receives, and everything
after runs once they are done, whether or not the body passed (a body that
timed out is abandoned first, as with `afterEach`). It returns a new `test`;
chains compose, and a definition in a chained `extend` reads the earlier ones. A
core name, a name an earlier `extend` defined, or a non-function is a
`COLLECTION_ERROR` at import; a name the target's engine contributes, a
definition that never calls `use()`, or one that calls it twice fails the
attempt with `TEST_SETUP_FAILED`. The zero-argument `test.extend<Extra>()`
keeps typing an engine's contributed fixtures without defining anything.
