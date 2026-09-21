---
'e2e': minor
---

`locator.pressSequentially(text, { delay?, timeout? })` types into exactly one editable node as keystrokes, so an autocomplete, a search-as-you-type box, or a masked input wired to key events reacts the way it does for a user. `fill` sets the value and fires no key events, which leaves those apps cold. The harness composes it from the engine's `focus` action and `keyboard` capability, so no engine changes; a target lacking either fails with `UNSUPPORTED_CAPABILITY` before any node resolves. `delay` sends one character per keyboard call that many milliseconds apart. A `Secret` is a type error and `INVALID_ARGUMENT` at runtime: secrets go through `fill`.
