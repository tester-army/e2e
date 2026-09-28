---
"e2e": patch
---

The markdown run page (the `@e2e-dev/github` comment, the job summary, `summary.md`) reads top down. Each failure's title has the line to look at right under it, with the target when several ran; a failed step that is not the agent's is one code span, the call it was; each kind of evidence links to the run's artifacts on its own, and the file paths inside the upload are gone from the comment (the download has one directory per test, named after it); `summary.md` keeps the paths, since a reader with the checkout can open them. Attempts that failed alike in a row fold into one clause: `at step 8, then at step 20 (3 times)`. A run that selected one of several configured targets (`--target android`) names it only in the footer; a test row under a file row no longer repeats the target the file row names.
