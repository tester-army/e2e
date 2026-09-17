---
'e2e': patch
---

The list-valued selection flags share one parser. `--tag`, `--target`, and `--agent` each take a comma-separated list or repeats, each name once, and an empty value (`--tag ''`, or `--tag "$TAGS"` with the variable unset) is a usage error, exit 2. Before, `--tag smoke,billing` looked for one tag literally named that, `--tag ''` failed later as `NO_TESTS` over an empty tag name, and an empty `--target` or `--agent` silently selected every target or the default agents; `--target` now accumulates on repeat as `--agent` did. When a tag filter leaves nothing to run, `NO_TESTS` blames the filter only for the tests it filtered (a test a positional or `.only` left out is counted as such), reads correctly under `--tag-mode all` ("do not carry all of the tags"), and marks each tag no test declares with the nearest declared one: `smok (did you mean smoke?)`. A tag name containing a comma cannot be selected this way; tag validation rejects one at registration.
