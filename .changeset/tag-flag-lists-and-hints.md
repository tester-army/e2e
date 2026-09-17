---
'e2e': patch
---

`--tag` takes a comma-separated list as well as repeats, like `--target` and `--agent`: `--tag smoke,billing`. An empty value is a usage error (exit 2) rather than a run with the filter dropped. When the filter leaves nothing to run, `NO_TESTS` reads correctly under `--tag-mode all` ("do not carry all of the tags") and marks each tag no test declares, naming the nearest declared tag: `smok (did you mean smoke?)`.
