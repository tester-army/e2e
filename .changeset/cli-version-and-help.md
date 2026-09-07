---
'@e2edev/e2e': minor
---

The CLI has `--version` and a help worth reading. `e2e --version` (or `-v`)
prints the installed version and exits 0. `e2e --help` opens with the version
and tagline, lists the commands with examples, and points at the docs;
`e2e run --help` groups the flags into Selection, Execution, and Output, then
lists examples and the exit codes. `e2e help <command>` is the same as
`e2e <command> --help`. Titles and flags are colored on a terminal and plain
when piped or under `NO_COLOR`. A usage error now ends with
`(add --help for usage)`.
