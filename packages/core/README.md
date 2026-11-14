# e2e-core

The engine contract, locators, agent, and replay cache that the
[e2e](https://github.com/e2e-inc/e2e) test runner is built on. `e2e` depends
on it at its own version, and the engines (`@e2e-dev/web`,
`@e2e-dev/mobile`) peer on it.

Engine authors import the contract from `e2e-core/engine`; `e2e/engine`
re-exports it unchanged. See
[Writing an engine](https://e2e.com/docs/writing-an-engine).

Everything under `e2e-core/lib/*` is internal to `e2e` and may change in any
release.
