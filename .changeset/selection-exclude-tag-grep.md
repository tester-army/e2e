---
'e2e': minor
---

`e2e run` and `e2e list` take three more selection flags. `--exclude-tag <tags>` leaves out every test carrying one of the tags, whatever `--tag` or a positional selected. `--grep <pattern>` keeps only the tests whose title matches a regular expression, and `--grep-invert <pattern>` leaves out the ones that match; the text matched is the describe titles and the test title joined by one space, a bare pattern or `/pattern/flags`, repeated for alternatives. `RunOptions` and `ListOptions` carry them as `excludeTags`, `grep`, and `grepInvert`. When the filters leave nothing to run, `NO_TESTS` counts the tests each one removed and names the tags and patterns.
