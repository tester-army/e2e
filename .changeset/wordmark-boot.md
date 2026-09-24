---
'e2e': patch
---

`e2e init` opens with the e2e wordmark, the site's lettering drawn in block characters, built from falling orange pieces: the pieces stack on a floor row, the full row flashes and clears, the word drops into place, pulses twice, and settles into the terminal's foreground. `e2e --help` prints the wordmark at rest above the help. Both show on a terminal at least 55 columns wide and never in piped output; with `--yes`, in CI, and on a dumb terminal the wordmark prints without motion. Ctrl-C during the drop restores the cursor and exits 130.
