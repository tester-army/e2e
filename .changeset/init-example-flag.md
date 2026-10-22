---
"e2e": patch
---

`e2e init --example <name>` starts a new project from one of the repository's example apps (`with-vite`, `with-next`, `with-astro`, `with-expo`, `with-swiftui`, `with-compose`, `with-kotlin-multiplatform`, `with-flutter`, `with-maui`). It downloads the example from the GitHub tag of the running CLI into an empty directory, points its `e2e` and engine ranges at this release, and then runs the usual skill, MCP, and install steps in the example's e2e project.
