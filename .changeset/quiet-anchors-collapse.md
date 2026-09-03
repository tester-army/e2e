---
'@e2edev/e2e': patch
'@e2edev/playwright': patch
---

Correctness and speed fixes across the runner's support layers:

- `agent.act` params and `web.evaluate` values that reach the same object by
  two paths are no longer rejected as cycles.
- A setup test filtered out by its own `platforms` list can no longer be
  promoted to run on a target it excluded; a consumer that needs it is a
  collection error, as for a missing capability.
- Trace start and end paths pass the secret redactor before they are written;
  a redacted path marks the trace non-replayable. The start-path precondition
  now compares by pathname like the end postcondition, so a differing query
  string no longer cold-misses the cache.
- Negated assertions with a budget shorter than the one-second grace window
  can pass again; `toHaveCount` polls within its assertion deadline.
- Replay relocation projects each observed node once per observation instead
  of once per recorded action per tier; wire regexps are compiled once; text
  sanitizing and UTF-8 truncation are single-pass; value matchers format
  failure messages only on failure; test discovery skips dot-directories.
- Dead code removed: the unused `internal/backend-text` module, the unused
  `selectorExpression`, and several exports that had no consumer.
