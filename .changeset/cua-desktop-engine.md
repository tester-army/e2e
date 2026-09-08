---
"@e2edev/cua": minor
---

Add `@e2edev/cua`, the desktop engine: `cua({ app })` launches a macOS, Windows,
or Linux app fresh per attempt through Cua Driver's in-process runtime,
observes its window as a semantic node tree (roles, names, values, states,
bounds) with optional redacted pixels, and performs the full locator action set
by element token. Contributes the `desktop` fixture (`locator`, `menu`,
`hotkey`, `window`).
