---
"e2e": patch
---

The bundled e2e skill's bug bash writes each repro test from the finding as `agent.act` steps and a closing `agent.assert`, so confirming a bug needs no locators. Each verifier runs its own repros into its own output directory, and the report runs them all once with `--tag bugbash`. A finding is confirmed when its repro fails on the reported defect, and the skill says how to read a failed `act`. Charters get about fifteen minutes each, a bash under a time limit keeps running new charters until near the end and reports each bug as its repro confirms it, and an account with a password under 6 characters is called out before the config fails.
