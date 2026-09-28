---
'e2e': patch
---

Tests and config can import a workspace package that exports its TypeScript source, the monorepo internal-package pattern, when that package declares no `"type": "module"`. The file loaded as CommonJS, which the TypeScript loader does not transform, and failed as `Cannot find module` on a path that exists; TypeScript outside `node_modules` now loads as ESM whatever specifier reached it. For TypeScript inside an installed package, which keeps its declared format, the error now says the file exists and why it failed.
