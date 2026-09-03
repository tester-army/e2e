---
'@e2edev/e2e': minor
---

The located agent verbs and the locator cache are removed. `agent.act` is the
one agent action API.

Breaking:

- `agent.tap`, `agent.click`, `agent.type`, `agent.scroll`, `agent.scrollTo`,
  `agent.longPress`, `agent.press`, `agent.select`, `agent.hover`,
  `agent.check`, `agent.uncheck`, `agent.dragTo`, `agent.upload`, and
  `agent.login` are gone, along with `InstantActionOptions`. Every located
  action is one `agent.act` instruction; sign-in is `agent.act` with `Secret`
  params, which the runner fills host-side so the plaintext never reaches the
  model.
- `agent.assert`, `agent.waitFor`, and `agent.extract` stay, as does the whole
  deterministic tier. `vision: 'fallback'` now behaves like `false` for these
  methods: a judgment always produces an answer from the tree, so there is no
  miss to escalate on.
- The locator cache (cache-1) is removed: the `agent.cache` config key, the
  `--no-agent-cache` CLI flag, `limits.maxCacheBytes`, the report's
  `step.cache` and `usage.maxCacheEntryBytes` fields, and the
  `CACHE_REPLAY_DIVERGED` error code no longer exist. v0 performs no caching.
- Conformance `suiteVersion` bumps to 0.3.0; the `cache-1` profile and the
  `agent-locate-1` schema are withdrawn.
