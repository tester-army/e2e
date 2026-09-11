---
'@e2edev/e2e': patch
---

`e2e init` looks for the monorepo workspace around the directory it scaffolds. Run at the workspace root, it notes that the suite usually lives in the app's package (`e2e init apps/<app>`). Run in a directory that no `packages` glob of the nearest `pnpm-workspace.yaml` or `package.json` `workspaces` covers, or that a `!` entry excludes, it warns that the install there will not share the workspace's lockfile, naming the root and its globs, and suggests adding an entry or running init inside the app's package. These messages are informational only; workspace detection does not write files, and the scaffold itself is unchanged.
