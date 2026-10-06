# @e2e-dev/eas

## 0.3.0

### Minor Changes

- [#790](https://github.com/tester-army/e2e/pull/790) [`0d1ed15`](https://github.com/tester-army/e2e/commit/0d1ed15871674aafd0ee3eff92c17eb39f6012bd) Thanks [@okwasniewski](https://github.com/okwasniewski)! - **Breaking: e2e and every `@e2e-dev` package now need Node.js 22.22.3 or newer on Node.js 22, or 24.8.0 or newer** (`engines.node` is `^22.22.3 || >=24.8.0`). Node.js 22.12 through 22.22.2, 23, and 24.0 through 24.7 are no longer supported, and the CLI refuses to start on them, naming the versions to upgrade to. Those releases fail when a CommonJS file a test imports requires TypeScript through the new loader's `module.registerHooks` (nodejs/node#59679 fixed it in 22.22.3 and 24.8.0).
  
  e2e now loads TypeScript with its own loader, built on oxc, instead of tsx. tsx brought in esbuild, whose postinstall script made every `pnpm install` on pnpm 11 and later fail with `ERR_PNPM_IGNORED_BUILDS` until the project approved the build; nothing e2e installs runs an install script now. Config and tests load as before: ESM whatever `package.json` says, `./x.js` and `./x` resolve to `x.ts` and `./x.jsx` to `x.tsx`, directory index imports, tsconfig `paths` and `baseUrl`, workspace packages exporting `.ts` source, JSX in `.tsx` and `.jsx`, enums, namespaces, `experimentalDecorators`, and source-mapped stack traces. JSON imported without `with { type: 'json' }` still loads. A test file whose name holds `%`, `#`, or a space now collects with its source location instead of failing with "URI malformed" or losing the location. Each file reads its nearest `tsconfig.json` rather than the one in the working directory. What changes: `import` statements in a `.cts` file are no longer compiled into `require` calls (write `import x = require()`); standard decorators without `experimentalDecorators`, auto-accessors, and ES module `import` and value `export` declarations in `.cts` are refused with their line (`import type`, `export type`, `import x = require()`, and `export =` work); the CLI refuses the Bun (`bun --bun`) and Deno runtimes (install with any package manager, run on Node.js); a type imported without `import type` that stays in the output (a decorated member's type under `emitDecoratorMetadata`) fails to load, with an error naming the import; a `.ts` file a CommonJS file requires runs as an ES module like every other `.ts`, so one written with `module.exports` needs the `.cts` extension; and an import written in a JavaScript file resolves as Node.js resolves it, without TypeScript's extension rules or tsconfig `paths`. TypeScript inside an installed package compiles without the project's `tsconfig.json`.

## 0.2.1

### Patch Changes

- [#763](https://github.com/tester-army/e2e/pull/763) [`b573756`](https://github.com/tester-army/e2e/commit/b573756818d7d04088142d29e0e730cfbaf21b45) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Installing `e2e` pulls in 29 packages instead of 117 and takes about 31MB instead of 36MB. `e2e mcp` now runs on the split MCP SDK (`@modelcontextprotocol/server` 2.2.0) in place of `@modelcontextprotocol/sdk`, which brought in express, hono, and the rest of an HTTP server stack that stdio never used. The server keeps the same protocol version, so existing clients connect as before. Packages are built and published without sourcemaps, which pointed at a `src/` that was never shipped. Stack traces show `dist/` positions.

## 0.2.0

### Minor Changes

- [#730](https://github.com/tester-army/e2e/pull/730) [`1554360`](https://github.com/tester-army/e2e/commit/1554360ba2b3d3aff5efeff443b16d8985a169ca) Thanks [@szdziedzic](https://github.com/szdziedzic)! - `easSimulators()` authenticates with the eas-cli login when `EXPO_TOKEN` is not set: it reads the session `eas login` keeps in `~/.expo/state.json` (under `USERPROFILE` on Windows) and sends it in the `expo-session` header, as eas-cli does, so a machine signed in to eas-cli needs no token. `EXPO_TOKEN` still wins when both are there. A session is stopped as the account that started it, even if the login changes during the run. Only the production login is read, since the sessions API is `api.expo.dev`. With neither a token nor a login, the lease fails with `EXPO_TOKEN is not set and eas-cli is not logged in`.

- [#731](https://github.com/tester-army/e2e/pull/731) [`88cef2c`](https://github.com/tester-army/e2e/commit/88cef2c26d0b095ce490e9f86c09221ce28d8fa9) Thanks [@szdziedzic](https://github.com/szdziedzic)! - `easSimulators()` takes `projectId` from the app config when the option is absent: `extra.eas.projectId`, the id `eas init` writes, read from `app.config.json` or `app.json` beside `e2e.config.ts`, or from a dynamic `app.config.ts` (or `.js`, `.mjs`, `.cjs`, `.mts`, `.cts`) as the project's own `expo config --type public` evaluates it in the run's environment, without `.env` files, as eas-cli runs it. It reads the config once per run, before the first session starts; a config that links no project fails the lease naming the file. `projectId` is optional now and still wins when it is passed. Reading it needs the `@e2e-dev/mobile` that passes `projectRoot` to device providers.

## 0.1.1

### Patch Changes

- [#706](https://github.com/tester-army/e2e/pull/706) [`1a80c23`](https://github.com/tester-army/e2e/commit/1a80c23d8789382847aa78fb5325ecc1281c3b6a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - npm package pages: `e2e` ships the repository README, and every package has keywords people search for.

## 0.1.0

### Minor Changes

- [#671](https://github.com/tester-army/e2e/pull/671) [`86fb6ea`](https://github.com/tester-army/e2e/commit/86fb6eae1f557d99451d54dbf598ed7d4a6aeead) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `@e2e-dev/eas`: `mobile({ device: easSimulators({ projectId }) })` runs a mobile target on EAS Simulators, one hosted iOS simulator or Android emulator per worker slot, driven through the agent-device daemon EAS runs beside it. `buildId` or `applicationArchiveUrl` has EAS install the app, or `device.installApp()` uploads the target's `app.appPath` through the daemon. It reads `EXPO_TOKEN` from the run's environment, names each session after its target and slot and tags it `e2e`, `e2e-run:<run id>`, and `e2e-target:<target>`, defaults `maxIdleTimeMinutes` to 10 so EAS stops a session a dead run never released, logs each session's expo.dev page, starts each daemon at the agent-device version `@e2e-dev/mobile` pins, stops a session that fails, is cancelled, stays queued while another session of the run idles to the limit, or boots for 15 minutes, and cancels the queued job of a session it stops. It calls Expo's API with `fetch`; `@e2e-dev/mobile` is its peer.

### Patch Changes

- [#670](https://github.com/tester-army/e2e/pull/670) [`0073644`](https://github.com/tester-army/e2e/commit/0073644863ef95fa264ee5e0d1ca63d3c86d5da9) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `easSimulators()` rejects an option it does not take with `INVALID_CONFIG`, naming the nearest known option when it is a likely typo (`buildID` for `buildId`) and every option otherwise; before, a misspelled option was dropped and EAS started a session without it. Its refusals of `buildId` and `applicationArchiveUrl` passed together, and of a `maxIdleTimeMinutes` not below a `maxDurationMinutes` passed with it, are `INVALID_CONFIG` too instead of `CONFIG_LOAD_FAILED`. `e2e` is now a peer.
