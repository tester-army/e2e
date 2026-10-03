---
'e2e': minor
'@e2e-dev/web': minor
'@e2e-dev/mobile': minor
'@e2e-dev/kernel': minor
'@e2e-dev/eas': minor
'@e2e-dev/github': minor
---

**Breaking: e2e and every `@e2e-dev` package now need Node.js 22.22.3 or newer on Node.js 22, or 24.8.0 or newer** (`engines.node` is `^22.22.3 || >=24.8.0`). Node.js 22.12 through 22.22.2, 23, and 24.0 through 24.7 are no longer supported, and the CLI refuses to start on them, naming the versions to upgrade to. Those releases fail when a CommonJS file a test imports requires TypeScript through the new loader's `module.registerHooks` (nodejs/node#59679 fixed it in 22.22.3 and 24.8.0).

e2e now loads TypeScript with its own loader, built on oxc, instead of tsx. tsx brought in esbuild, whose postinstall script made every `pnpm install` on pnpm 11 and later fail with `ERR_PNPM_IGNORED_BUILDS` until the project approved the build; nothing e2e installs runs an install script now. Config and tests load as before: ESM whatever `package.json` says, `./x.js` and `./x` resolve to `x.ts`, directory index imports, tsconfig `paths` and `baseUrl`, workspace packages exporting `.ts` source, JSX, enums, namespaces, `experimentalDecorators`, and source-mapped stack traces. JSON imported without `with { type: 'json' }` still loads. A test file whose name holds `%`, `#`, or a space now collects with its source location instead of failing with "URI malformed" or losing the location. Each file reads its nearest `tsconfig.json` rather than the one in the working directory. Two things tsx did that the new loader does not: compile `import` statements in a `.cts` file into `require` calls (write `import x = require()`), and compile standard decorators without `experimentalDecorators`.
