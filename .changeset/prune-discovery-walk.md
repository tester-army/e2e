---
'e2e': patch
---

Test discovery enters only the directories a `tests` glob can still match a file beneath. `tests/**/*.e2e.ts` lists the project root, reads `tests/` and its subdirectories, and nothing else, where every run and `e2e list` used to read every directory but `node_modules` (`apps/`, `build/`, `coverage/`, and the rest) and filter afterwards. A dot directory is entered only when a glob segment written with a leading dot matches it. Matching and the walk share one matcher, which carries each glob's state down the tree instead of matching every directory from the root. Symlinks are not followed, which was already so and is now documented.
