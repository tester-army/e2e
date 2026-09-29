---
'e2e': minor
---

`e2e mcp` holds several sessions at once, up to `--max-sessions` (default 4), so parallel agents such as a coding agent's subagents each drive their own browser or device. A call names its session by id and may leave it out only while one is open; with several open it fails with `SESSION_REQUIRED`. Each session loads the config afresh down to the files it imports by path, so a config that spreads a base config still gets its own engine per session, sessions on the same app command share one process that stops when the last of them closes, and sessions open at once share one config (`CONFIG_IN_USE` otherwise). A session holds its slot, its engine, and its app processes until its attempt has closed.

The skill has a new `bug-bash` topic: parallel `e2e explore` charters, merging their findings, and proving each with a repro test that fails for the reason reported.
