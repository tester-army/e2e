---
'e2e': patch
---

`e2e init` opens with the e2e wordmark, the site's lettering drawn in block characters, written in letter by letter the way a pen writes it, with a dim edge of wet ink behind the pen, all in the terminal's own foreground. `e2e --help` prints the wordmark at rest above the help. Both show on a terminal at least 55 columns wide and never in piped output; with `--yes`, in CI, and on a dumb terminal the wordmark prints without motion. Ctrl-C while it is being written restores the cursor and exits 130.
