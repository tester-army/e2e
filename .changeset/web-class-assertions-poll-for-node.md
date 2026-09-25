---
'@e2edev/web': patch
---

`expect(web).toHaveClass` waits for its node. Loaded from a project's config file, the engine and the runner's core are two copies of `e2e`, and the `LOCATOR_NOT_FOUND` a not-yet-rendered target raised was a `TestError` from the other copy: `instanceof` missed it, the read error escaped the poll, and the assertion failed within milliseconds while `toHaveAttribute('class', ...)` on the same locator waited and passed. The engine now recognizes a runner error by its name and code, so the matcher keeps polling until the deadline. An ambiguous target still fails at once with `LOCATOR_AMBIGUOUS`, and every other runner error crosses the engine boundary untouched whichever copy raised it.
