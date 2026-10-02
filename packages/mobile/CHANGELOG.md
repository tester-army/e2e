# @e2e-dev/mobile

## 0.9.1

### Patch Changes

- [#763](https://github.com/tester-army/e2e/pull/763) [`b573756`](https://github.com/tester-army/e2e/commit/b573756818d7d04088142d29e0e730cfbaf21b45) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Installing `e2e` pulls in 29 packages instead of 117 and takes about 31MB instead of 36MB. `e2e mcp` now runs on the split MCP SDK (`@modelcontextprotocol/server` 2.2.0) in place of `@modelcontextprotocol/sdk`, which brought in express, hono, and the rest of an HTTP server stack that stdio never used. The server keeps the same protocol version, so existing clients connect as before. Packages are built and published without sourcemaps, which pointed at a `src/` that was never shipped. Stack traces show `dist/` positions.

## 0.9.0

### Minor Changes

- [#731](https://github.com/tester-army/e2e/pull/731) [`88cef2c`](https://github.com/tester-army/e2e/commit/88cef2c26d0b095ce490e9f86c09221ce28d8fa9) Thanks [@szdziedzic](https://github.com/szdziedzic)! - A `DeviceProvider`'s `acquire` request carries `projectRoot`, the directory the config's relative paths resolve against, so a provider reads project files there instead of `process.cwd()`.

- [#740](https://github.com/tester-army/e2e/pull/740) [`bb904d4`](https://github.com/tester-army/e2e/commit/bb904d40d39d170a4ab38c4616552226bf77017f) Thanks [@NathanWalker](https://github.com/NathanWalker)! - `device.fold(pose)` puts a foldable iOS simulator (iPhone Duo) in a hinge pose: `'closed'` lights the outer display, `'half-open'` (a 130° book) and `'open'` the inner one. It runs agent-device's `fold` command, which sends the simulator's hinge event and reads the angle back from CoreDevice before it resolves, so the next observation reads the app on the other display. Like `setOrientation`, it counts as an action for the `transition` budget. A device without a hinge is `UNSUPPORTED_CAPABILITY`, and Android is refused before any device command. The pose type is exported as `FoldPose`.

## 0.8.1

### Patch Changes

- [#706](https://github.com/tester-army/e2e/pull/706) [`1a80c23`](https://github.com/tester-army/e2e/commit/1a80c23d8789382847aa78fb5325ecc1281c3b6a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - npm package pages: `e2e` ships the repository README, and every package has keywords people search for.

## 0.8.0

### Minor Changes

- [#671](https://github.com/tester-army/e2e/pull/671) [`86fb6ea`](https://github.com/tester-army/e2e/commit/86fb6eae1f557d99451d54dbf598ed7d4a6aeead) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A `DeviceProvider`'s `acquire` request carries `agentDeviceVersion`, the agent-device version the engine's client speaks, so a provider for a service that starts the daemon can start the same version. `@e2e-dev/eas` sends it to EAS Simulators, which otherwise runs the latest agent-device.

- [#698](https://github.com/tester-army/e2e/pull/698) [`4d488f8`](https://github.com/tester-army/e2e/commit/4d488f828695998275590e5da9aa5be77b8cf726) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Breaking: `mobile()` only drives the device. The app it launches is the target's: `mobile({ app })` becomes `targets: [{ engine: mobile({ platform }), app: { bundleId } }]`, and `appPath`, `launchArguments`, `permissions`, `identity`, and `environment` move under the target's `app` too; every old option is an unknown key, `INVALID_CONFIG`. A device target needs `app.bundleId` or `app.appPath`, so `app.open()`, `app.restart()`, and `app.clearState()` are always there. `app.url` on a device target is refused as not supported yet, with a note on reaching this machine from an iOS simulator or an Android emulator. A device target is a `native-app` target, so a test can require one with `requires: ['native-app']`.

- [#671](https://github.com/tester-army/e2e/pull/671) [`86fb6ea`](https://github.com/tester-army/e2e/commit/86fb6eae1f557d99451d54dbf598ed7d4a6aeead) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `mobile({ videoTouches: false })` records video without agent-device's touch indicator. Drawing the indicator runs when a recording stops, and on a hosted daemon such as EAS Simulators' it took minutes and failed, so every attempt that recorded video timed out stopping it; without it the stop takes about two seconds.

- [#704](https://github.com/tester-army/e2e/pull/704) [`3dc4ec9`](https://github.com/tester-army/e2e/commit/3dc4ec96146357ab164b1bcf7add275002d805ef) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `describe`, `beforeEach`, `afterEach`, `beforeAll`, and `afterAll` are top-level exports of `e2e`, the same functions as `test.describe` and the `test.*` hooks: `import { describe, beforeEach, test } from 'e2e'`. `@e2e-dev/web` and `@e2e-dev/mobile` export `describe` and all four hooks beside `test`, typed with their `browser` or `device` fixture, so a test file registers from one import. `test.describe` and the `test.*` hooks stay, and are how a `test.extend()` chain registers hooks that see its fixtures.

### Patch Changes

- [#703](https://github.com/tester-army/e2e/pull/703) [`b5a0952`](https://github.com/tester-army/e2e/commit/b5a0952564d0f863834b92867c82705ef4353cfb) Thanks [@okwasniewski](https://github.com/okwasniewski)! - agent-device 0.21.18: `device.setClipboard` writes the iOS simulator clipboard under Xcode 27, where it did nothing before, a live daemon is probed again before being replaced as unreachable, and Android retries once after a device-offline refusal. The docs no longer mark `getByPlaceholder` and `toBeFocused` as Android only; both have worked on iOS since agent-device 0.21.16.

- [#670](https://github.com/tester-army/e2e/pull/670) [`0073644`](https://github.com/tester-army/e2e/commit/0073644863ef95fa264ee5e0d1ca63d3c86d5da9) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An unknown permission name, a permissions value that is not a plain object, or a state other than `grant`, `deny`, or `reset`, fails before any device command: `app: { permissions: { camerra: 'grant' } }` on a mobile target is `INVALID_CONFIG` naming `camera`, and the same map in `device.openApp(app, { permissions })` is `INVALID_ARGUMENT`. Before, the typo reached agent-device on the first launch. `rejectUnknownKeys` in `e2e/engine` takes an optional `code`, `'INVALID_ARGUMENT'` for an object a test passes.

- [#671](https://github.com/tester-army/e2e/pull/671) [`86fb6ea`](https://github.com/tester-army/e2e/commit/86fb6eae1f557d99451d54dbf598ed7d4a6aeead) Thanks [@okwasniewski](https://github.com/okwasniewski)! - On a simulator or emulator, an attempt that records video no longer fails to start when no app is open in the session: after a test's `closeApp()`, or before a fixture installs the build. The engine records the whole device screen (agent-device's `device` scope) instead of the app session, which refused to start without an open app. A recording that started without a session ends the session agent-device made for it when it stops, and the engine now treats that as a closed session, as after `closeApp()`. A physical iOS device still needs an open app to record.

- [#670](https://github.com/tester-army/e2e/pull/670) [`0073644`](https://github.com/tester-army/e2e/commit/0073644863ef95fa264ee5e0d1ca63d3c86d5da9) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Unknown keys are rejected below the top level of the config too, naming the nearest known key when one is a plausible typo and the known keys otherwise. `app: { url, comand }` on a target is `INVALID_CONFIG` (the run used to go on and fail with `APP_UNREACHABLE`), and so are an unknown `web()` or `mobile()` option, an unknown key inside `connect` or `basicAuth`, and an unknown key in `app.command` (`command: { executable, arg }` dropped the arguments). An unknown test or `describe` option (`{ timout }`) is `COLLECTION_ERROR`, and an unknown query option (`getByRole('link', { nam })`) is `INVALID_LOCATOR` listing the keys the query takes. `e2e/engine` exports `rejectUnknownKeys(label, value, keys)`, the same check for an engine's own options.

## 0.8.0-canary-20260929180659

### Minor Changes

- [#610](https://github.com/tester-army/e2e/pull/610) [`aadcb5d`](https://github.com/tester-army/e2e/commit/aadcb5dddb79217608a88c75af6cc4e5a582c592) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A device provider can record the attempts it serves: `DeviceProvider.record(lease, context)` starts the service's own recording of the leased device, and its file or link becomes the attempt's video in place of agent-device's recording. The worker now knows the lease id its slot rides, so `record` gets the lease as it traveled. A provider that cannot record leaves `record` out.

### Patch Changes

- [#627](https://github.com/tester-army/e2e/pull/627) [`425fd67`](https://github.com/tester-army/e2e/commit/425fd6765738da199a8dfbafa2d072294dd81822) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The iOS automation runner starts in `prepare`, through agent-device's `prepare ios-runner`, before the warm-up open. A cold runner used to start inside the first test's `app.open()` (or the warm-up open), under agent-device's 90 s `open` envelope; on a loaded CI Mac it outlasted that, and a timed-out `open` resets the daemon, which ended the other workers' sessions with it (`Daemon request timed out`, then `2 devices match this request equally`, `Invalid daemon response`). A build the suite installs itself now gets the runner start too.

- [#646](https://github.com/tester-army/e2e/pull/646) [`d228e22`](https://github.com/tester-army/e2e/commit/d228e22ea309107cd42283bcfcb5f614ca3ea8c6) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The README and the `mobileTools` docs show the pack in an agents entry's `tools` (`agents: { default: { model, tools: mobileTools(iphone, pixel) } }`), the shape `e2e` takes now that `createAgent()` is gone.
- Updated dependencies [[`d228e22`](https://github.com/tester-army/e2e/commit/d228e22ea309107cd42283bcfcb5f614ca3ea8c6), [`d7a218a`](https://github.com/tester-army/e2e/commit/d7a218af0788a5957c789203b811a690d0e9ccb3), [`d7a218a`](https://github.com/tester-army/e2e/commit/d7a218af0788a5957c789203b811a690d0e9ccb3), [`12fe125`](https://github.com/tester-army/e2e/commit/12fe12550d37cfefe36b65a30d53ae4eb024d641), [`8a65a90`](https://github.com/tester-army/e2e/commit/8a65a9093d75a9e819bfc610cd7ebaf8055497a6), [`0cb74d6`](https://github.com/tester-army/e2e/commit/0cb74d6d916e62c38aeb05ce97658d3c67468843), [`425fd67`](https://github.com/tester-army/e2e/commit/425fd6765738da199a8dfbafa2d072294dd81822), [`ec1ea1e`](https://github.com/tester-army/e2e/commit/ec1ea1e4c3142661897e0c23654e0aba2c43dbaa), [`04a1261`](https://github.com/tester-army/e2e/commit/04a126191eb9fefc730b93cd249f7c152e0166d1), [`968b055`](https://github.com/tester-army/e2e/commit/968b05545db8c961bf864bcb2aa3fdfd59c626f8), [`97a7e7f`](https://github.com/tester-army/e2e/commit/97a7e7f12129b029d53f28458c2a7ea72c083ea4), [`d7a218a`](https://github.com/tester-army/e2e/commit/d7a218af0788a5957c789203b811a690d0e9ccb3), [`d7a218a`](https://github.com/tester-army/e2e/commit/d7a218af0788a5957c789203b811a690d0e9ccb3), [`d7a218a`](https://github.com/tester-army/e2e/commit/d7a218af0788a5957c789203b811a690d0e9ccb3), [`636acd9`](https://github.com/tester-army/e2e/commit/636acd901f03dbff9e657dcce10d98634f88a1ab), [`a411ac6`](https://github.com/tester-army/e2e/commit/a411ac65245fd3602acc731a051e9726f75756aa), [`d7a218a`](https://github.com/tester-army/e2e/commit/d7a218af0788a5957c789203b811a690d0e9ccb3), [`aadcb5d`](https://github.com/tester-army/e2e/commit/aadcb5dddb79217608a88c75af6cc4e5a582c592), [`85a3afd`](https://github.com/tester-army/e2e/commit/85a3afd7c41b6b28af84bd3182671fabaeec871e), [`ba0d280`](https://github.com/tester-army/e2e/commit/ba0d2804194d8985beb0760ab1fa1e9e945b6aaa)]:
  - e2e@0.15.0-canary-20260929180659

## 0.8.0-canary-20260928184528

### Minor Changes

- [#602](https://github.com/tester-army/e2e/pull/602) [`67c29fc`](https://github.com/tester-army/e2e/commit/67c29fc6b207822c9525360e6bf9c3130411a947) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The engines and the reporter publish under the `@e2e-dev` scope: `@e2edev/web` is `@e2e-dev/web`, `@e2edev/mobile` is `@e2e-dev/mobile`, and `@e2edev/github` is `@e2e-dev/github`. The `@e2edev` packages get no new releases. To move, swap the dependencies (`npm uninstall @e2edev/web && npm install --save-dev @e2e-dev/web`) and rewrite the imports: `from '@e2edev/web'` becomes `from '@e2e-dev/web'`, and the same for `@e2edev/mobile`, `@e2edev/mobile/tools`, and `@e2edev/github`. `e2e init` installs and imports the new names.

### Patch Changes

- [#593](https://github.com/tester-army/e2e/pull/593) [`11dfdfa`](https://github.com/tester-army/e2e/commit/11dfdfaf4c343bb847a4f306fe29088f9398e29a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - agent-device 0.21.16: `device.enrollBiometrics` and `device.setBiometrics` drive a simulator's Face ID and Touch ID. 0.21.15 refused both as unsupported on the iOS 26 runtime.

- [#538](https://github.com/tester-army/e2e/pull/538) [`dceae62`](https://github.com/tester-army/e2e/commit/dceae627300c2746b0a902cb90df75a0e1bb45a9) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An engine error no longer ends in agent-device's generic CLI advice (`Hint: Check command arguments and run --help for usage examples.`); a hint that names a recovery path (press return, tap the app's own Done control) still comes through.

- [#539](https://github.com/tester-army/e2e/pull/539) [`5460fb0`](https://github.com/tester-army/e2e/commit/5460fb0ee110bca42fa27231e80f10886483dbcf) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The engine no longer installs `appPath` on its own: the suite says where, with `device.installApp()`, which without a path installs the engine's build, once per device in a fixture or a test, and pins what it installed when no `app` is; a device provider still installs on the device it leases. `device.setPermission` brings the pinned app to the foreground when the session is on no app, and again once when agent-device refuses for that reason, instead of failing the test that reset a permission before its `app.open()`. `device.setLocation` on Android switches location services on before the fix: `clearLocation` had switched them off, and the emulator keeps that, so the next run's fix was one the app could not read. A `longPress` with no `duration`, the agent's `long_press` included, holds for one second: agent-device's default hold is shorter than a React Native `Pressable`'s `delayLongPress`, so the agent's long press registered as a tap and never advanced a scenario that waits for one.

- [#595](https://github.com/tester-army/e2e/pull/595) [`adce759`](https://github.com/tester-army/e2e/commit/adce75964e3a30f47aa814876eb2f73008bbb6db) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A worker that replaces one retired after a failing test no longer takes the warm-up's word that its session is on the app. The retired worker closed that session, so the next `device.setPermission` skipped its open and went out on a session bound to no device: with an iOS simulator and an Android emulator booted on one host, agent-device answered `AMBIGUOUS_MATCH`. `init` now keeps the warm-up's app only while agent-device still lists the session, and otherwise the first permission change opens the app again.

- [#571](https://github.com/tester-army/e2e/pull/571) [`93b45b7`](https://github.com/tester-army/e2e/commit/93b45b79c77ae78a9069e6442df51413771fc3bd) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A URL or text pattern that is neither a string nor a `RegExp` is `INVALID_ARGUMENT`. Before, a Playwright-style predicate read as a regexp with no source, which matches everything: `expect(web).toHaveURL(url => ...)` passed on any page, `web.waitForURL(fn)` resolved at once, `web.waitForResponse(fn)` returned the first response of any kind, `web.route(fn, handler)` intercepted every request, the document included, and `expect(value).toMatch(fn)` passed on any string. A text matcher or query given one, such as `toHaveTitle(fn)` or `getByText(fn)`, threw a raw `TypeError`. `toTextPattern` and `urlMatches` in `e2e/engine` throw the same error, so an engine that uses them refuses such a pattern too. A `RegExp` from another realm is still a `RegExp`.
- Updated dependencies [[`89e2a19`](https://github.com/tester-army/e2e/commit/89e2a19a3932adf0bdbb3c2b2b8df7527f3a3750), [`f9f49f4`](https://github.com/tester-army/e2e/commit/f9f49f41ef521fd712db340ab291afa58e259ec6), [`676a015`](https://github.com/tester-army/e2e/commit/676a0153d88c9fb20d74e06c847e9303e18c4b59), [`8ff15d7`](https://github.com/tester-army/e2e/commit/8ff15d7cb2541490d29d0bb2dc64c2e9bcd1f126), [`786f65d`](https://github.com/tester-army/e2e/commit/786f65d8e4ede28c833717374cea6a23cd1b7164), [`c089fa6`](https://github.com/tester-army/e2e/commit/c089fa6cc21a3de7b925123b3e9fd8cf4165e29a), [`61603e6`](https://github.com/tester-army/e2e/commit/61603e6c2c103013eee2fe98c72066d59ac9363b), [`90356f1`](https://github.com/tester-army/e2e/commit/90356f17fcf515a0f05e4745235f645243acb51d), [`301e71d`](https://github.com/tester-army/e2e/commit/301e71d09be40c9f26c3bc4853d8f70d19b24d66), [`ac3eb57`](https://github.com/tester-army/e2e/commit/ac3eb57477137c5106d84d997745558f86be22ca), [`67c29fc`](https://github.com/tester-army/e2e/commit/67c29fc6b207822c9525360e6bf9c3130411a947), [`c1e9029`](https://github.com/tester-army/e2e/commit/c1e9029fed3ff5d58b147877228132e6a016ae86), [`dceae62`](https://github.com/tester-army/e2e/commit/dceae627300c2746b0a902cb90df75a0e1bb45a9), [`cf59269`](https://github.com/tester-army/e2e/commit/cf592694fea667dc25faaa514f3d65c7e13f63df), [`3e1a568`](https://github.com/tester-army/e2e/commit/3e1a5685b7336915da67ff4ef4cdfdf580f5e2d5), [`75e4145`](https://github.com/tester-army/e2e/commit/75e414536da73a23f37e213aab0a0880cd5869df), [`cb84c13`](https://github.com/tester-army/e2e/commit/cb84c13d8664c9637c19b9b9491cd727a0dfbb80), [`21b43b6`](https://github.com/tester-army/e2e/commit/21b43b6eb819b87d3c31fb5cdea36d10eac575ee), [`299c546`](https://github.com/tester-army/e2e/commit/299c546468a7e4cacc4084cfe0892c161530e333), [`2e96878`](https://github.com/tester-army/e2e/commit/2e968783bf6283d9fd507f06af1b559b323699db), [`a399bac`](https://github.com/tester-army/e2e/commit/a399bac83b927f8c5a58f4906bc25f1b992754ad), [`d0359eb`](https://github.com/tester-army/e2e/commit/d0359ebeef65835771667379c4fa51171fe670bb), [`d6947bc`](https://github.com/tester-army/e2e/commit/d6947bc66dca1d1d51dff20a67198f7929e1dfb5), [`11a286d`](https://github.com/tester-army/e2e/commit/11a286d54fc58ce1fc19d3317aa41122b271a1fd), [`bad98ea`](https://github.com/tester-army/e2e/commit/bad98ea2ebd4ab30fb7408b9b40467ea6a18caa9), [`93b45b7`](https://github.com/tester-army/e2e/commit/93b45b79c77ae78a9069e6442df51413771fc3bd), [`d87465b`](https://github.com/tester-army/e2e/commit/d87465b77fe1e04e981e9bddeaddd732c33c9861), [`eaac502`](https://github.com/tester-army/e2e/commit/eaac50292d4f71a0ca267263568be7152170c596), [`cef69d2`](https://github.com/tester-army/e2e/commit/cef69d26095a045d2282c9d43ad1f115e48b11dd)]:
  - e2e@0.15.0-canary-20260928184528

## 0.8.0-canary-20260925150007

### Minor Changes

- [#526](https://github.com/tester-army/e2e/pull/526) [`ea23075`](https://github.com/tester-army/e2e/commit/ea2307576a6ed4f0e8488d1f7b1540cafbcb311a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `launchArguments` and `permissions` on the engine ride every fresh launch of the pinned app (`app.open()`, `app.restart()`, `app.clearState()`): the arguments reach the app process on iOS and `am start` on Android, and each permission is granted, denied, or reset before the app starts, since a change terminates a running app; `app.clearState()` puts them back after it reset them with the data. `device.openApp(app, { launchArguments, permissions })` does the same for one launch of any app. `device.clearKeychain()` resets the iOS simulator's keychain, which `app.clearState()` leaves alone; Android is `UNSUPPORTED_CAPABILITY`.

### Patch Changes

- [#534](https://github.com/tester-army/e2e/pull/534) [`e19c4e0`](https://github.com/tester-army/e2e/commit/e19c4e0f9c438183e0d9db45721056e5718b5832) Thanks [@okwasniewski](https://github.com/okwasniewski)! - agent-device 0.21.15, and the engine reads what its snapshots now carry. An Android node is named by the content description its app set and keeps its text as `text`, so `getByLabel`, `toHaveAccessibleName`, and `getByRole('textbox', { name })` find a labeled text view or a filled field by its label on Android as on iOS, where before the label never reached the tree. A view React Native marks as a header is a `heading`, and the role description React Native writes for `tab`, `tablist`, and `radiogroup` gives the node that role. A switch, checkbox, or radio button carries the `checked` state the device reports, so `toBeChecked`, `check()`, and `uncheck()` work on Android instead of refusing. A field's hint is its `placeholder` attribute, showing or not, so `getByPlaceholder`, `getAttribute('placeholder')`, and `toHaveAttribute` answer on Android. From agent-device itself: an Android `app.open` returns once the launched app is readable, and a fill's verification samples until a deadline instead of three fixed points, which ends the `Android fill verification failed` seen only on a slow CI emulator.

- [#530](https://github.com/tester-army/e2e/pull/530) [`adbc4fb`](https://github.com/tester-army/e2e/commit/adbc4fbadfb306f9bbe3f2eda459cc0a781b81d6) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `device.dismissKeyboard()` works on an iPhone. agent-device presses the keyboard's own dismiss key and refuses when there is none, so the engine now does what a user does and what Maestro's `hideKeyboard` does: a short drag at the centre of the screen, horizontal first and vertical second, each followed by a fresh look at whether the keyboard is still up, with the simulator's "Speed up your typing" tip dismissed through its Continue button first. A keyboard that outlives both drags still fails with `UNSUPPORTED_CAPABILITY`, naming the app's own Done control and Enter as the alternatives.

- [#511](https://github.com/tester-army/e2e/pull/511) [`228a9d6`](https://github.com/tester-army/e2e/commit/228a9d6e7459bfdfca5965a7c4349d625911872d) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Android's status bar and navigation bar stay out of the tree. agent-device reports them as windows of `com.android.systemui` beside the app's, and their clock, signal, and battery read differently from one run to the next, so a step recorded with "T-Mobile, three bars" among its end anchors handed every replay off to the model once the emulator read "signal full". The notification shade, quick settings, and system dialogs stay: they cover the screen rather than hug an edge. So does a heads-up notification or another compact systemui popup: a bar spans the screen edge to edge, a popup sits inset from the sides.
- Updated dependencies [[`43d76ce`](https://github.com/tester-army/e2e/commit/43d76ce760b4d62148d4e129c77cbedd8a6aec7c), [`d6a1a30`](https://github.com/tester-army/e2e/commit/d6a1a30519951a3e588d7fe6d73d4ff0ef433b89), [`c1547c9`](https://github.com/tester-army/e2e/commit/c1547c9deb9619b6f90e4a98712ea080551e61cc), [`ec503c2`](https://github.com/tester-army/e2e/commit/ec503c2ea3e031c457509b93195f608cb8fd0a73), [`38e152a`](https://github.com/tester-army/e2e/commit/38e152a4aab06b4a1ce2ef46967b8f1931b3e35a)]:
  - e2e@0.15.0-canary-20260925150007

## 0.8.0-canary-20260924194828

### Minor Changes

- [#499](https://github.com/tester-army/e2e/pull/499) [`920ac4e`](https://github.com/tester-army/e2e/commit/920ac4ebf03f10ff2848b0f6fb20914c640bad02) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An attempt no longer relaunches the pinned app. The worker brings it up once in `prepare`, and a test launches it fresh with `app.open()` when it wants to, so a test starts where the previous one left the app, as a Maestro flow does. Suites that relied on the fresh app every attempt add `await app.open()` as their first line.

### Patch Changes

- [#499](https://github.com/tester-army/e2e/pull/499) [`920ac4e`](https://github.com/tester-army/e2e/commit/920ac4ebf03f10ff2848b0f6fb20914c640bad02) Thanks [@okwasniewski](https://github.com/okwasniewski)! - agent-device 0.21.13. Of its fixes since 0.21.6, the ones a suite meets: the iOS AX bridge derives `selected` from the traits word and hittability from geometry, a Simulator open waits out a slow app discovery before observing the launch, an observation never launches a session app that is not running, read-only commands are resent across the runner's busy window, and a reachable daemon newer than the client is not replaced.

- [#427](https://github.com/tester-army/e2e/pull/427) [`1c80ba6`](https://github.com/tester-army/e2e/commit/1c80ba640815bb036a82bd5f1f773fd1992532b3) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An Android password field is a secure `textbox`. UIAutomator marks a password `EditText` with the `password` attribute rather than a class of its own, and the engine read only the class, so the field projected as a plain textbox: `type_secret` and `fill(secret)` with a credential's password were refused on every Android sign-in form (`field purpose none is incompatible with secret purpose password`), the typed value reached model input, and screenshots left the field unmasked. The node now carries `secure` and `inputPurpose: 'password'`, drops its value, and is painted over in screenshots like an iOS `SecureTextField`. A node the platform reports as editable is a `textbox` whatever its class, so a custom input view takes typed text and secrets too.

- [#499](https://github.com/tester-army/e2e/pull/499) [`920ac4e`](https://github.com/tester-army/e2e/commit/920ac4ebf03f10ff2848b0f6fb20914c640bad02) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An iOS text field that shows its placeholder reads as empty. XCTest reports the placeholder as the value of an empty field, so `toHaveValue('')` after `clear()` observed the hint text on a host without the simulator's accessibility bridge; the node's hint flag now empties the value.

- [#499](https://github.com/tester-army/e2e/pull/499) [`920ac4e`](https://github.com/tester-army/e2e/commit/920ac4ebf03f10ff2848b0f6fb20914c640bad02) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An Android `AbsListView`, the class React Native gives a `FlatList` and any view with `accessibilityRole="list"`, is a `list`, as `RecyclerView` already was; it answered no role before.

- [#426](https://github.com/tester-army/e2e/pull/426) [`03535d4`](https://github.com/tester-army/e2e/commit/03535d4c1f60add5a310914188a5b145af9b7825) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `device.openApp` and the agent's `open_app` tool take an app, never a link. agent-device opens any `scheme:rest` string as a URL, so `open_app({ app: 'file:///...' })` from the model, or `device.openApp('data:...')` from a test, reached the device as a navigation no rule had checked. A `file:`, `data:`, or `javascript:` link is now `POLICY_DENIED` before the device sees it, as it is for `openLink`; any other link is `INVALID_ARGUMENT` pointing at `device.openLink`. A bundle id, package, or display name is unchanged, and the `device.openApp` step label drops a link's query the way `openLink` does. The engine's `app` option, which `prepare` opens on every device before any attempt runs, refuses a link the same way at config time (`INVALID_CONFIG`), and a `DeviceProvider` lease whose `installedApp` is a link fails the lease.

- [#491](https://github.com/tester-army/e2e/pull/491) [`1de46ce`](https://github.com/tester-army/e2e/commit/1de46ce08c4943c17e4fdd16b0b18ee7a420307a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - React Native controls on iOS read as what they are. A view with `accessibilityRole="checkbox"` or `"radio"` has no UIKit trait, so React Native spells the role and state into its accessibility value (`checkbox, unchecked`, `radio button, checked`) and XCTest reports an `Other`; the node now takes the spelled role, `checked` and `expanded` from the state words, and reports only what follows them as its value, so `getByRole('checkbox')`, `check()`, `uncheck()`, and `toBeChecked` work on a React Native checkbox or radio. `getByLabel` answers with the innermost match, as `getByText` does: iOS reports a React Native `TextInput` as a labelled host view around the labelled field, which made every label query on a field `LOCATOR_AMBIGUOUS`. An iOS field whose text is also its label keeps its value, so `toHaveValue` reads a filled unlabeled field; only Android's echo of a text view's label as its value is dropped. `doubleTap()` sends two presses (284 to 285 ms apart on iOS, the cadence of agent-device's XCTest tap; a detector with a window of 300 ms or less can read them as two single taps) instead of agent-device's double-tap gesture, which reaches a React Native `Pressable` as one press. `device.closeApp()` terminates the app before ending the session, so the next `openApp` launches it fresh instead of resuming it mid-flow, and `device.foregroundApp()` after it is `APP_NOT_OPEN` rather than `ENGINE_FAILURE`. `device.back()`, `home()`, `alert()`, `dismissKeyboard()`, and `setOrientation()` count as actions for the `transition` budget, as a tap does, so a control that arrives with the screen they reveal is given time to land before the next tap; a tap right after `device.back()` landed a row away on a list that was still sliding in. A booted Android emulator the pool discovered is selected by its adb serial (`emulator-5554`), which agent-device took for a device name and refused to boot; a configured `device` that reads as an emulator serial goes by serial too.

- [#443](https://github.com/tester-army/e2e/pull/443) [`8bfe1d8`](https://github.com/tester-army/e2e/commit/8bfe1d84f4c25d1fa28072e1a94c512a232d78b4) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A timeout agent-device itself reports (a simulator boot, the runner connecting, an app launch) keeps its message and hint under `ENGINE_FAILURE`. It was re-coded `OPERATION_TIMEOUT` on the word "timed out" alone, and the runner reports that code as a bare `operation timed out`, so the device, the app, and the hint never reached the report.
  
  A busy or wedged iOS automation runner is named as such. agent-device's `RUNNER_BUSY` (still draining a capture that overran its watchdog), `RUNNER_WEDGED`, and `MAIN_THREAD_TIMEOUT`, and a snapshot the runner acquired but could not present ("requires a valid viewport"), read as `APP_UNREACHABLE: agent.act failed: snapshot failed: The iOS runner is still finishing ...` with the app blamed. The message now says the app is fine, names the session and device, and gives the recovery: wait for the runner to drain, and if the next run meets it again, `npx agent-device daemon stop` and reboot the simulator. A runner that is busy or wedged when `prepare` warms the device ends the run there instead of being logged as "not warmed up" and failing the first observation, and the sessions warm-up opened are closed when the run ends, so the next run does not resume them by name with that runner state. A snapshot the runner could not present is taken once more before it fails the step, like a sparse one.

- [#499](https://github.com/tester-army/e2e/pull/499) [`920ac4e`](https://github.com/tester-army/e2e/commit/920ac4ebf03f10ff2848b0f6fb20914c640bad02) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A test's action on a control that arrived with the last action is aimed where the control landed. The engine waited out the `transition` budget and then acted on the ref it had resolved mid-transition; Android reports a sliding window's frames in flight, so a tap on a modal's button went below the screen and the modal swallowed it. After the wait the control is found again in a fresh snapshot.

- [#441](https://github.com/tester-army/e2e/pull/441) [`b8e5aa1`](https://github.com/tester-army/e2e/commit/b8e5aa1de1abdadf06c0e10913c586d8b09745ce) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An observation whose tree agent-device cut, or that is still sparse after the engine's retries, carries `truncated: true`: the agent is told the listing is incomplete (nodes past the cut are on screen but not listed) and a cut screen is never reported to it as unchanged. A hosted device whose lease the engine rejects (no daemon or client configuration, a reserved client key) is still handed to the provider's `release` at the end of the run; before, the run failed and the device stayed allocated. A screen scroll from the agent settles like a tap or fill; its travel stays agent-device's default.

- [#432](https://github.com/tester-army/e2e/pull/432) [`9614834`](https://github.com/tester-army/e2e/commit/9614834797dfac35ed89515bfa7b9cba82d5686a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The peer range on `e2e` is `>=0.15.0 <1` again instead of the exact version of one runner build, so updating `e2e` alone no longer leaves an unmet peer that npm refuses with ERESOLVE, and a runner release no longer republishes the engines and the reporter.
- Updated dependencies [[`7d93c08`](https://github.com/tester-army/e2e/commit/7d93c085eb7d7c56c4007b870ff7f8b5c644d3d2), [`ed151e0`](https://github.com/tester-army/e2e/commit/ed151e042080371ab47dbbec49aa296011b34370), [`cc691d4`](https://github.com/tester-army/e2e/commit/cc691d472151d423637b3d22d477347644303068), [`66fb1e3`](https://github.com/tester-army/e2e/commit/66fb1e3d369cc5789fc768e4258f63e0b7120e2f), [`2ee94cc`](https://github.com/tester-army/e2e/commit/2ee94cc379779d62ab8e1b64a61852d25929bc93), [`3c52f93`](https://github.com/tester-army/e2e/commit/3c52f93272832892d6b36456df89d638b0bca084), [`8802b0f`](https://github.com/tester-army/e2e/commit/8802b0f0dc85fdd0bcdccc5b4ba6b351000d1769), [`edbb84f`](https://github.com/tester-army/e2e/commit/edbb84f6a1fcc57f6f8f5e7f88155691a96df369), [`ee4929d`](https://github.com/tester-army/e2e/commit/ee4929ddb6aa4de9004efd2e9107157103fd3c2f), [`91cacc9`](https://github.com/tester-army/e2e/commit/91cacc9e9ab6413308e3926885ec452d2e1a8371), [`4314f5f`](https://github.com/tester-army/e2e/commit/4314f5f8869b7d7369f1878b9ff23fd07790eb35), [`1de46ce`](https://github.com/tester-army/e2e/commit/1de46ce08c4943c17e4fdd16b0b18ee7a420307a), [`7ef3553`](https://github.com/tester-army/e2e/commit/7ef3553b67c90d18cafe63e9a496a16344603608), [`881afee`](https://github.com/tester-army/e2e/commit/881afee5c4973988b4811680b642e6ab6b1ec7bb), [`7aa0ffe`](https://github.com/tester-army/e2e/commit/7aa0ffe0b2425a5721bf5cf7a07335b03bd3c5b6), [`943de73`](https://github.com/tester-army/e2e/commit/943de73404259517ea8bdc7c36e6c830cb969142), [`920ac4e`](https://github.com/tester-army/e2e/commit/920ac4ebf03f10ff2848b0f6fb20914c640bad02), [`e95135d`](https://github.com/tester-army/e2e/commit/e95135d5124c5008c79bc25b9f3cff8b89688d06), [`18cb9fc`](https://github.com/tester-army/e2e/commit/18cb9fcc3de47c4b49004f834a8d71fcc1f42f11), [`7753859`](https://github.com/tester-army/e2e/commit/77538594af6df0ca03aadd58b25cd090645f2a92), [`cdc4109`](https://github.com/tester-army/e2e/commit/cdc41098c7d3f5ba92705a87f758e470e859a559), [`e2b5570`](https://github.com/tester-army/e2e/commit/e2b557074ff4f18aa437fae351ac0ced6f02f53a), [`0dcf6a4`](https://github.com/tester-army/e2e/commit/0dcf6a492722b2e275c2f6b943ba728e5abd8dac), [`c975fb2`](https://github.com/tester-army/e2e/commit/c975fb26cc92bae4f42e4f26bc7f92d8a2df562e), [`1cb0c73`](https://github.com/tester-army/e2e/commit/1cb0c73c9ff846b5fef115a6bd3b805c0a540410), [`fa41517`](https://github.com/tester-army/e2e/commit/fa415178000d435fb97b6f07b9e1f0feb7743019), [`9c847ba`](https://github.com/tester-army/e2e/commit/9c847ba3e6f69ddbf84d39add17b7d993aadeb59), [`3bbcc96`](https://github.com/tester-army/e2e/commit/3bbcc968dddd1499db30b9a99ab949920cf98f74), [`6efc77d`](https://github.com/tester-army/e2e/commit/6efc77da5e4ca69468b5ce1b4eb6ac625d5c7c63), [`920ac4e`](https://github.com/tester-army/e2e/commit/920ac4ebf03f10ff2848b0f6fb20914c640bad02), [`a0df697`](https://github.com/tester-army/e2e/commit/a0df69790679e02d7011dbaa3932028bac90b226), [`a9f8256`](https://github.com/tester-army/e2e/commit/a9f8256b800160eb88e6bb6efb69f767f9e2b000), [`cc23e51`](https://github.com/tester-army/e2e/commit/cc23e5142ec02dbecfbf555aa0d76e16c430c49a), [`5aaac75`](https://github.com/tester-army/e2e/commit/5aaac751f64141eb9fc80114ba945703ebc8709c), [`778fccc`](https://github.com/tester-army/e2e/commit/778fcccdfee595505b7905488aab9e3ff7067470), [`4305718`](https://github.com/tester-army/e2e/commit/4305718f1b43d362349698aaa28bac47d3e41271), [`33044a7`](https://github.com/tester-army/e2e/commit/33044a70e785ab94c77f01fff525648891a3e8b9)]:
  - e2e@0.15.0-canary-20260924194828

## 0.8.0-canary-20260922161512

### Patch Changes

- Updated dependencies [[`707c894`](https://github.com/tester-army/e2e/commit/707c8942fd13a9f67d0212c340c662ad152971d0), [`b71ecc0`](https://github.com/tester-army/e2e/commit/b71ecc0f09bd49801c2f4ff27a8822de846e7c3e)]:
  - e2e@0.15.0-canary-20260922161512

## 0.8.0-canary-20260922135036

### Minor Changes

- [#416](https://github.com/tester-army/e2e/pull/416) [`41f3b32`](https://github.com/tester-army/e2e/commit/41f3b3211bcd08d6d76370c2e57c8a4af8b936fa) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A `DeviceLease` can carry `client`: agent-device client configuration the worker's client is created with, next to the `daemon` address, which becomes optional. A daemon that runs agent-device's own device-cloud runtimes resolves a hosted device from the lease scope on each command (`tenant`, `runId`, `leaseId`, `leaseBackend`, `leaseProvider`), and a `stateDir` reaches a daemon the provider started, so such a provider returns what `leases.allocate` gave it and no longer needs a daemon address or a proxy that stamps the scope onto requests. `session`, `daemonBaseUrl`, `daemonAuthToken`, and `daemonTransport` stay with the engine and `daemon`; a lease setting them, or one carrying anything JSON cannot round-trip, is refused. `DeviceClientConfig` and `DeviceConnection` are exported; the mobile guide shows a provider on a device cloud.

- [#385](https://github.com/tester-army/e2e/pull/385) [`d7d2799`](https://github.com/tester-army/e2e/commit/d7d27993a6fd8653f6c21524c4e81a286c5e07a3) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `device.openLink(url, { app? })` opens a deep link (`myapp://orders/42`) or a web link on the device, into the pinned app by default, for magic-link sign-in and deep-link routes; the session observes that app afterwards. iOS launches the app for a web link and then opens the URL, Android starts the link on the package. Without an app, Android lets the OS route the link and the session follows the package that took it; iOS needs one (`INVALID_ARGUMENT`), since an open bound to no app leaves nothing to observe. `file:`, `data:`, and `javascript:` links are `POLICY_DENIED`, as on the web. The step is recorded as `device.openLink` with the link cut before its query, so a magic-link token never enters the report.

### Patch Changes

- [#383](https://github.com/tester-army/e2e/pull/383) [`856e088`](https://github.com/tester-army/e2e/commit/856e08863442191381ef51fc251981cec01c2844) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `Role` grows by the composite widgets and structure ported Playwright tests name: `tablist`, `tabpanel`, `menu`, `menubar`, `menuitemcheckbox`, `menuitemradio`, `progressbar`, `spinbutton`, `meter`, `toolbar`, `tooltip`, `group`, `separator`, `radiogroup`, `grid`, `gridcell`, `rowgroup`, `rowheader`, `tree`, `treeitem`, `article`, `figure`, and `form`. The list stays closed. `getByRole('img')` is accepted as an alias of `image` and builds the `image` query, so engines, the trace cache, and reports never see `img`.
  
  The web engine reads `role="img"` back as `image`, and its reader derives the new roles from HTML semantics (`<progress>`, `<meter>`, `<hr>`, `<fieldset>`, `<details>`, `<input type="number">`, `<thead>`/`<tbody>`, `<th scope="row">`, `<figure>`, `<article>`, a named `<form>` or `<section>`, `<header>`/`<footer>`/`<aside>` landmarks) instead of dropping them, and names a fieldset, figure, or table by its legend, figcaption, or caption.
  
  The mobile engine maps a tab bar, a segmented control, and a `TabLayout` to `tablist`, their items to `tab` (on iOS, the buttons inside a tab bar or segmented control), a progress indicator or `ProgressBar` to `progressbar` (an activity indicator stays `status`), a stepper or `NumberPicker` to `spinbutton`, and `Toolbar`, `Menu`, `MenuItem`, and `RadioGroup` to their roles on both platforms.
- Updated dependencies [[`eb739e9`](https://github.com/tester-army/e2e/commit/eb739e930d533db36206d622c960d18a1ba965e7), [`4c93414`](https://github.com/tester-army/e2e/commit/4c934142bc4ef4002811eff2be20d463343dd381), [`a577da3`](https://github.com/tester-army/e2e/commit/a577da3199c42402dfb9a04cd8452c5d89ab40dc), [`a583a88`](https://github.com/tester-army/e2e/commit/a583a88254cd80450f986174b022cf961442e7f0), [`0f864ad`](https://github.com/tester-army/e2e/commit/0f864ad3f3e7f5242ed957941e58e55e1a818aee), [`2b9361f`](https://github.com/tester-army/e2e/commit/2b9361ffea8e39d2c32a5b1e2a6a98c2da759380), [`2e4d40e`](https://github.com/tester-army/e2e/commit/2e4d40eb0754f2558e5e89fe80b4b4933183d023), [`0e525a0`](https://github.com/tester-army/e2e/commit/0e525a09dd2b8287280b1ede81a06d32dcb7f1d3), [`f01c01f`](https://github.com/tester-army/e2e/commit/f01c01fbe3a73f2e9380a7db2e62718517ab2e6b), [`d043035`](https://github.com/tester-army/e2e/commit/d04303523652b264b02af82d200f7cc726c044b3), [`dcfe53a`](https://github.com/tester-army/e2e/commit/dcfe53a4b0e4c70b5f9a01f980c6dffea021f8c9), [`ae930bb`](https://github.com/tester-army/e2e/commit/ae930bbf9a6d3793ad9f96e0efb2e8c36cb7665a), [`856e088`](https://github.com/tester-army/e2e/commit/856e08863442191381ef51fc251981cec01c2844)]:
  - e2e@0.15.0-canary-20260922135036

## 0.8.0-canary-20260921180210

### Minor Changes

- [#365](https://github.com/tester-army/e2e/pull/365) [`f7f86d9`](https://github.com/tester-army/e2e/commit/f7f86d91e87b317dea9ae076f143e20f6ba8ed98) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `mobile({ device })` accepts a `DeviceProvider`: an object that leases one hosted device per worker slot when the run starts and releases every lease when it ends. The engine drives each lease through the agent-device daemon the lease names (`daemon.baseUrl`, `daemon.authToken`) instead of the local one, selects `device` inside it when given, and skips its own `appPath` install when the lease reports `installedApp`. Slots lease in parallel; a slot that fails releases the others and ends the run before any test. No vendor ships in the package; the mobile guide shows an example provider against a generic session API. `DeviceProvider`, `DeviceRequest`, `DeviceLease`, and `DeviceReleaseContext` are exported.

- [#380](https://github.com/tester-army/e2e/pull/380) [`54c0dba`](https://github.com/tester-army/e2e/commit/54c0dba62fc47403564ece41ce503bb9b9ce9a08) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The engine declares the `swipeTo` pointer action and performs it as a coordinate swipe from the point to `target`, so `screen.swipe({ from, to })` works on a device. A directional swipe at a bare point is still `UNSUPPORTED_CAPABILITY`; `screen.swipe({ direction })` scrolls the screen root as before.

- [#392](https://github.com/tester-army/e2e/pull/392) [`f5e96d0`](https://github.com/tester-army/e2e/commit/f5e96d0cbea6bc26da1084ea3bbc49b7a7a16dd8) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The engine packages are named after what they drive, not what they are built on. `@e2edev/playwright` is now `@e2edev/web` with a `web()` factory, and `@e2edev/agent-device` is now `@e2edev/mobile` with a `mobile()` factory; the engine names in reports and telemetry follow (`web`, `mobile`). Option types rename with them (`WebOptions`, `WebConnectOptions`, `WebBasicAuth`, `MobileOptions`, `MobilePlatform`), the agent tool pack is `mobileTools` from `@e2edev/mobile/tools`, and the `device` fixture keeps its name. `PlaywrightLiveSurface` keeps its name because it hands out Playwright objects. `e2e init` writes the new packages. Replace the dependency and the import in an existing project; the old packages are deprecated on npm and receive no further releases.

### Patch Changes

- [#378](https://github.com/tester-army/e2e/pull/378) [`a124837`](https://github.com/tester-army/e2e/commit/a124837191be58a65dea105146f63295ec896445) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An agent-device failure keeps its hint in the engine error message. `dismissKeyboard` on an iPhone keyboard is refused upstream because the keyboard shows no dismiss key and agent-device taps nothing outside it; the model used to see only the refusal and retried it, and now reads the recovery path (the app's own Done control, or pressing return) in the same message.
- Updated dependencies [[`54c0dba`](https://github.com/tester-army/e2e/commit/54c0dba62fc47403564ece41ce503bb9b9ce9a08), [`f7f86d9`](https://github.com/tester-army/e2e/commit/f7f86d91e87b317dea9ae076f143e20f6ba8ed98), [`2e18196`](https://github.com/tester-army/e2e/commit/2e18196b79ac724c2a274a27562ea06d7a316d02), [`9f2b73f`](https://github.com/tester-army/e2e/commit/9f2b73f9293d4cdee449bb04e4f8272477d22402), [`f5e96d0`](https://github.com/tester-army/e2e/commit/f5e96d0cbea6bc26da1084ea3bbc49b7a7a16dd8)]:
  - e2e@0.15.0-canary-20260921180210

## 0.8.0-canary-20260921154506

### Minor Changes

- [#349](https://github.com/tester-army/e2e/pull/349) [`3e0285c`](https://github.com/tester-army/e2e/commit/3e0285c5e566abaa129ee167014f96c2a766d930) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Breaking: `agentDeviceTools()` no longer offers `type_text`. The agent's own `type` verb reaches the focused field without a target since the engine declared the `keyboard` capability, and a typed value goes through the grammar there, so the trace cache records and replays it; the project tool bypassed the grammar and ended every replay at a gap. A prompt that named `type_text` should say `type` instead. `alert` says to prefer a listed button, whose tap replays.

### Patch Changes

- [#373](https://github.com/tester-army/e2e/pull/373) [`ca5e619`](https://github.com/tester-army/e2e/commit/ca5e6196b620165dcabc383c1aaf35c44cf22690) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Relicense from MIT to Apache-2.0. The package ships the license text and a `NOTICE` file.
- Updated dependencies [[`45c08b1`](https://github.com/tester-army/e2e/commit/45c08b123e52369257433da2e133a84f2d6bdfa7), [`ca5e619`](https://github.com/tester-army/e2e/commit/ca5e6196b620165dcabc383c1aaf35c44cf22690), [`d438348`](https://github.com/tester-army/e2e/commit/d438348fda96a512cc03b51c41f1140353030003), [`b9abd60`](https://github.com/tester-army/e2e/commit/b9abd60c435935fc96816249f48315885d8ac85f), [`c1d23b2`](https://github.com/tester-army/e2e/commit/c1d23b230b8c8502f551e869710ed26f606a7469), [`ea27708`](https://github.com/tester-army/e2e/commit/ea2770804fe55857d105224355eef7b45453d665), [`195bd0d`](https://github.com/tester-army/e2e/commit/195bd0d14cc3f32440bfa140ed468dfa705d851d), [`da6b939`](https://github.com/tester-army/e2e/commit/da6b939e4c306b5dba64088599961a666f680c9a), [`fb6e336`](https://github.com/tester-army/e2e/commit/fb6e3363275991bf2baa3698f03a69574d93cb83), [`f09b69e`](https://github.com/tester-army/e2e/commit/f09b69e90a8f76172ba5e5e006e7ec10dd99c172), [`f3d61e8`](https://github.com/tester-army/e2e/commit/f3d61e8ce7a8ab9a40090ecd72c9f43557a12492), [`d746ce4`](https://github.com/tester-army/e2e/commit/d746ce4b3f568c00ac736c116a561ef4e4dc67df), [`d7d843a`](https://github.com/tester-army/e2e/commit/d7d843af9d241246d225795b7d2439cb98a27a8a), [`bd2a9a6`](https://github.com/tester-army/e2e/commit/bd2a9a6db7c23193be6a914f961c3fb178074d59), [`fb6e336`](https://github.com/tester-army/e2e/commit/fb6e3363275991bf2baa3698f03a69574d93cb83), [`e9c2914`](https://github.com/tester-army/e2e/commit/e9c2914c6d8f8d664d820b13a1fa454e9247e94b), [`91dcd30`](https://github.com/tester-army/e2e/commit/91dcd30b535331d89d197f6c5f3e8ae984e92960), [`ddf9747`](https://github.com/tester-army/e2e/commit/ddf97479d734b294f826b01b206e3b49cb7822bf), [`9fbba0b`](https://github.com/tester-army/e2e/commit/9fbba0b34c4f6a387d62914d35fc756b84ba7f8e)]:
  - e2e@0.15.0-canary-20260921154506

## 0.8.0-canary-20260917213813

### Patch Changes

- [#339](https://github.com/tester-army/e2e/pull/339) [`29cab4c`](https://github.com/tester-army/e2e/commit/29cab4c88b230d792ea47a0199d5589e8ef7fa00) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Pins `agent-device` to 0.21.6 (from 0.21.1). The Simulator accessibility bridge now reports `enabled` from the NotEnabled trait, so `toBeDisabled` passes on iOS Simulator again; scroll and record recovery fixes from 0.21.2 through 0.21.6 come along.
- Updated dependencies [[`ba8d9ba`](https://github.com/tester-army/e2e/commit/ba8d9ba81de2879cbf216afaba0a0fe2a638cf11), [`15081f3`](https://github.com/tester-army/e2e/commit/15081f306837ebe1040fbcb2e63bd2efe283faaa), [`b558e78`](https://github.com/tester-army/e2e/commit/b558e78ba3b21cb86b20cc26bdd18aea08aa8a17), [`d3afa6b`](https://github.com/tester-army/e2e/commit/d3afa6bacb9a407d0bd85c9f8abb2135b1d8a2ac), [`ed3999e`](https://github.com/tester-army/e2e/commit/ed3999e8931693f02a1a6e1737315fcea60f341b), [`95b3d7f`](https://github.com/tester-army/e2e/commit/95b3d7f41946bdf35d5865d9619e92f16e625866), [`99f9ea8`](https://github.com/tester-army/e2e/commit/99f9ea81cf3d40d4eb7966b9a98cdea9c2df1745)]:
  - e2e@0.15.0-canary-20260917213813

## 0.8.0-canary-20260917081546

### Minor Changes

- [#314](https://github.com/tester-army/e2e/pull/314) [`0b513d9`](https://github.com/tester-army/e2e/commit/0b513d989e7086bd3998fd0d105dbea0fdd5d004) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Declares the `keyboard` capability: `keyboard.type` types into the focused field through the device's text input, `keyboard.press` sends Enter, Space, or a character to it, and `keyboard.dismiss` hides the soft keyboard. Replacing the focused field's value without a node is refused; fill a listed field by id to replace it.

- [#324](https://github.com/tester-army/e2e/pull/324) [`7fcb925`](https://github.com/tester-army/e2e/commit/7fcb925d76f41f1a8558abaa57a60de4ff365868) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Declares `tap`, `doubleTap`, and `longPress` as pointer actions at a bare screen point (`performAt` with `pointerActions`), replacing `tapAt`. A role query with `pressed` or `level` matches nothing on a device tree that reports neither, rather than everything.

### Patch Changes

- [#317](https://github.com/tester-army/e2e/pull/317) [`2e593df`](https://github.com/tester-army/e2e/commit/2e593dfb46dc71bc1785cb0ce80c35e34c0f1a90) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Recover semantic-capture timeouts with fresh, independently masked screenshots.
  The engine contract distinguishes unavailable semantics from a valid empty
  tree. Judgments obey their vision options, and every capture respects secret
  taint. The runner retires stale references and disables trace reuse for
  affected steps. Playwright supports
  the fallback; device captures still fail closed when accessibility data
  cannot establish screenshot masks.
  
  Playwright bounds the complete semantic capture and reserves node IDs before
  the reader starts. An abandoned capture cannot reuse IDs or publish late
  references. Pixel-only evidence resets the agent's semantic screen comparison
  and stops cache probes without discarding the recovered screenshot.
  
  Reports accept judgment steps that fail before a model call without inventing
  an observation revision or verdict explanation.

- [#306](https://github.com/tester-army/e2e/pull/306) [`17283c8`](https://github.com/tester-army/e2e/commit/17283c86dabad63631064d817196ae728c3a6136) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Built against the engine contract that adds `EngineSnapshot.truncated`. The
  device engine reads the whole accessibility tree it is handed, so its
  snapshots never set the flag.
- Updated dependencies [[`0a4b7f4`](https://github.com/tester-army/e2e/commit/0a4b7f4fe9f3b316907ce896d21153a918f853e8), [`0b513d9`](https://github.com/tester-army/e2e/commit/0b513d989e7086bd3998fd0d105dbea0fdd5d004), [`1c9cc16`](https://github.com/tester-army/e2e/commit/1c9cc16697cb82c0a6db924f6c0f389886b2a468), [`9c835ba`](https://github.com/tester-army/e2e/commit/9c835ba64e866a8e87c1bcddc04376939edca74c), [`7fcb925`](https://github.com/tester-army/e2e/commit/7fcb925d76f41f1a8558abaa57a60de4ff365868), [`9249de2`](https://github.com/tester-army/e2e/commit/9249de20eea96fccc5b24e3747f36708eaf8edb8), [`2e593df`](https://github.com/tester-army/e2e/commit/2e593dfb46dc71bc1785cb0ce80c35e34c0f1a90), [`3524a59`](https://github.com/tester-army/e2e/commit/3524a59290da01a1adf28d83272eb5ecf0219c40), [`6016083`](https://github.com/tester-army/e2e/commit/60160830154972d31e81b10ddc90f6c63776a470), [`4c76360`](https://github.com/tester-army/e2e/commit/4c76360cb65b20c5193240b0e5a0489bd7e0c558), [`17283c8`](https://github.com/tester-army/e2e/commit/17283c86dabad63631064d817196ae728c3a6136), [`d3afa6b`](https://github.com/tester-army/e2e/commit/d3afa6bacb9a407d0bd85c9f8abb2135b1d8a2ac)]:
  - e2e@0.15.0-canary-20260917081546

## 0.8.0-canary-20260914134810

### Patch Changes

- Updated dependencies [[`5908a10`](https://github.com/tester-army/e2e/commit/5908a107f97d6f3845ed75c5676cc514b6f03dcd)]:
  - e2e@0.15.0-canary-20260914134810

## 0.8.0-canary-20260914095510

### Minor Changes

- [#298](https://github.com/tester-army/e2e/pull/298) [`ec3b6a1`](https://github.com/tester-army/e2e/commit/ec3b6a145a9e1a58bc70227ba4e868d7c9e3c3e5) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `agent-device` is a dependency of this package again, pinned to the exact version the engine was built and tested against (`0.21.1`); the `0.21.x` peer requirement from 0.7.0 is gone, and the pin moves with each engine release. A project that added `agent-device` to satisfy the peer can drop it. A project that also drives devices through the agent-device CLI keeps its own copy; keep its version in step with the pin, so one agent-device runs, not two.

### Patch Changes

- [#297](https://github.com/tester-army/e2e/pull/297) [`6fbf3c7`](https://github.com/tester-army/e2e/commit/6fbf3c77606bfada21327e21d8279370040cfdd0) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `@e2edev/mobile/tools` no longer imports `ai` at run time. `ai` is an optional peer dependency, and the tool pack loads with the project's config, so a project without `ai` failed at config load with `ERR_MODULE_NOT_FOUND` instead of getting as far as its own steps. The tools are typed the same way; nothing changes for a project that has `ai`.
- Updated dependencies [[`f2f2e6f`](https://github.com/tester-army/e2e/commit/f2f2e6fb1024ffb4cd481f7ea571c2d29be6d6d8), [`ec3b6a1`](https://github.com/tester-army/e2e/commit/ec3b6a145a9e1a58bc70227ba4e868d7c9e3c3e5)]:
  - e2e@0.15.0-canary-20260914095510

## 0.8.0-canary-20260914081513

### Minor Changes

- [#291](https://github.com/tester-army/e2e/pull/291) [`abf1958`](https://github.com/tester-army/e2e/commit/abf19588677070fb86234f735614c40b7677e755) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Breaking: follows the reshaped engine contract. Observations carry one `root` node (role `screen`, id `root`) over the device's windows and a `location` of the form `<app> / <screen title>` instead of an `app://` URL. Nodes carry `testId` from the accessibility identifier or resource id; the harness's `testIdAttribute` is gone. The engine declares the action kinds a device honors, so the agent is no longer offered `select` on a device. `press` accepts `Enter`, `Space`, and single characters; anything else fails with `UNSUPPORTED_CAPABILITY`. A discovered device pool reaches the workers through the `prepare` result's `env` instead of a write to the run's environment.

- [#294](https://github.com/tester-army/e2e/pull/294) [`c2c5df7`](https://github.com/tester-army/e2e/commit/c2c5df7df94b25a8284b69dd6bc00a459b770a59) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The runner is published as `e2e`. `@e2edev/e2e` is retired and deprecated on npm; every import, config, and peer range now names `e2e` (`e2e`, `e2e/agent`, `e2e/engine`). The engines and the GitHub reporter declare their peer dependency on `e2e`, so a project on `@e2edev/e2e` must switch the runner to `e2e` when it takes these versions. The CLI keeps its `e2e` bin name.

### Patch Changes

- [#290](https://github.com/tester-army/e2e/pull/290) [`799b29f`](https://github.com/tester-army/e2e/commit/799b29fbfa0444589b66bc0e59ab0b83ededf50c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Origin allowlists are gone, everywhere. `web({ allowedOrigins })` gated typed navigation only; a click, a redirect, or a popup reached any origin regardless, so the list guarded nothing and had to be spelled out for every subdomain a sign-in flow touched. `allowedOrigins` on a credential or a secret gated where a password could be typed; a secret is only ever typed into a field the step was handed, a password only into a password field, so that gate guarded against a model mistake at the cost of configuring every flow that leaves the app's domain, a third-party sign-in included. `app.open()`, the agent's `navigate`, and `web.goto` open any http(s) URL, `file:`, `data:`, and `javascript:` stay `POLICY_DENIED`, and a secret fills wherever the test or the step directs it. `credentials` entries are `{ username, password }`; `secrets` entries are a string or a provider, the `{ value }` object form is gone. `type_secret` now works on a device target too. What still keys on the site of `url` (its registrable domain) is invisible to config: the browser engine's `headers` reach the site and no other host, and child frames off the site stay out of observations. `basicAuth` answers a challenge from any origin, as Playwright's own `httpCredentials` does. Engine contract: `EngineAppInfo.allowedOrigins` became `site?: string`, `EngineAppDeclaration` lost `allowedOrigins`, and `sameSite`/`siteOf` are exported from `e2e/engine`. `web({ allowedOrigins })` fails at config load. If a threat model ever calls for an allowlist again, it comes back as an opt-in.
- Updated dependencies [[`abf1958`](https://github.com/tester-army/e2e/commit/abf19588677070fb86234f735614c40b7677e755), [`aa3b05b`](https://github.com/tester-army/e2e/commit/aa3b05bbbdd4534ef111e51b950002513998076f), [`e301105`](https://github.com/tester-army/e2e/commit/e3011054080237f6141419f738a680574308765b), [`d486e40`](https://github.com/tester-army/e2e/commit/d486e40e73bfe23ac70a99f7938f05db0ba4e30c), [`799b29f`](https://github.com/tester-army/e2e/commit/799b29fbfa0444589b66bc0e59ab0b83ededf50c), [`c2c5df7`](https://github.com/tester-army/e2e/commit/c2c5df7df94b25a8284b69dd6bc00a459b770a59)]:
  - e2e@0.15.0-canary-20260914081513

## 0.7.0

### Minor Changes

- [#278](https://github.com/tester-army/e2e/pull/278) [`7a45609`](https://github.com/tester-army/e2e/commit/7a456094a8d8ebb930c073f2cfe5ffa83315bd77) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Breaking: `agent-device` is no longer installed by this package. It is a peer dependency, `0.21.x`, replacing the pinned `agent-device` dependency the engine carried. Add it to your project:
  
  ```bash
  npm install --save-dev agent-device
  ```
  
  A project that already drives devices with the agent-device CLI keeps its version and one copy in `node_modules`; before, the engine pulled in a second copy pinned to another revision. agent-device is 0.x and its minors break, so the range pins the minor the engine was built and tested against, and each agent-device minor moves it with an engine release. A version outside the range may be rejected by the package manager as an unmet peer (npm's `ERESOLVE`). Projects scaffolded with `e2e init` need no change: init now adds `agent-device` alongside the engine.

- [#283](https://github.com/tester-army/e2e/pull/283) [`4480e8b`](https://github.com/tester-army/e2e/commit/4480e8b0e589ef06c116c59eddbef82e1bb65dfb) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Deterministic steps no longer settle. A test's tap, fill, check, or back acts at once and leaves verification to `expect`; only agent actions keep the `settle` window. The one wait that remains is the new `transition` budget (default 500 ms): a control that appeared or moved with the previous action is given that long, counted from the action, to finish arriving, because accessibility frames report a control's final position from the first frame of a transition and a tap at a point it has not reached lands on whatever is behind it. Controls that were already in place are acted on immediately. react-native-pager-view's 11-test suite: 190 s with a 500 ms settle on every action, 142 s with 150 ms, about 125 s with this, all 11 passing.

- [#281](https://github.com/tester-army/e2e/pull/281) [`8ad60e4`](https://github.com/tester-army/e2e/commit/8ad60e4aeb13a28355b69f72c23b5066aa1591d2) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Actions settle faster. After a tap, fill, or back, the engine waits for the UI to hold still before the next observation; that quiet window was agent-device's 500 ms default, which put a fixed second on every tap (1.6 s per tap measured, 2 s on an alert, up to 5 s on a screen push). The window is now 150 ms by default, enough to catch a running animation since every frame changes the tree, and the new `settle` option sets it per engine or disables the wait with `false`. A 13-test React Native suite went from 29 s to 17 s on the two tests measured, with every step still passing.

## 0.6.0

### Minor Changes

- [#258](https://github.com/tester-army/e2e/pull/258) [`c553b61`](https://github.com/tester-army/e2e/commit/c553b614def4da798be5bfa3f7f04591dc253b69) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The engine declares `tapAt`: a settled press at one screen point in logical
  pixels with no element behind it, which the agent's `tap_at` uses when the
  point the model named in the screenshot lands on nothing the tree lists. The
  pack's own `screenshot` tool is gone: the agent's grammar now offers
  `screenshot` and `tap_at` on every engine while no secret has been filled, and
  a project tool under a grammar name is rejected, so `mobileTools()` no
  longer returns one.

## 0.5.2

### Patch Changes

- [#257](https://github.com/tester-army/e2e/pull/257) [`6526dc6`](https://github.com/tester-army/e2e/commit/6526dc6daa0d3c646c650800560447674af93ae0) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Runtime dependencies move to their current releases: `zod` 4.6.1 in both
  packages, `@clack/prompts` 1.8.0 in `@e2edev/e2e`, and `agent-device` 0.21.0
  in `@e2edev/mobile`. No behavior changes on our side.

## 0.5.1

### Patch Changes

- [#245](https://github.com/tester-army/e2e/pull/245) [`38d4424`](https://github.com/tester-army/e2e/commit/38d4424eb1fd2e16ab5fd2fb1fc6b64862ced3a7) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Engine contract: `artifacts.stopTrace` may return every trace segment instead of one path. The device engine declares no trace; republished for the widened contract.

## 0.5.0

### Minor Changes

- [#241](https://github.com/tester-army/e2e/pull/241) [`5ccfa46`](https://github.com/tester-army/e2e/commit/5ccfa46308bcd0160f01227da91dfc1e5f1be0b7) Thanks [@okwasniewski](https://github.com/okwasniewski)! - With no `device`, the pool is every booted device of the platform: `prepare` lists the inventory, boots as many as the run has slots, reports the count as the target's worker cap, and hands the devices to the workers through the run environment. Four booted simulators run a target's files four at a time with no config, instead of failing with "Multiple booted iOS simulators have the app installed". A `device` entry that is a simulator UDID is selected as `udid`, as the docs always said.

## 0.4.0

### Minor Changes

- [#233](https://github.com/tester-army/e2e/pull/233) [`a659f5f`](https://github.com/tester-army/e2e/commit/a659f5f5fcfc0fa97b5b460fa595d8bbf558cd0a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Video recording. With `artifacts: ['video']` or `--video`, the engine records the device screen through agent-device's recorder into `video/video.mp4` under the attempt's artifact directory, taps shown.

- [#232](https://github.com/tester-army/e2e/pull/232) [`25e1897`](https://github.com/tester-army/e2e/commit/25e1897fbbae245814b6622faf04fb29e8d59f9d) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `device` accepts a list. The engine declares one worker per device (one for a single or unnamed device), so a `workers` above the pool size no longer over-subscribes it; worker slot `n` drives the `n`th entry. Every session name now carries the worker slot, `<session>-<n>` (`e2e-<target>-<n>` by default), for a single device too: a run that named its session `qa` now drives `qa-0`. Devices boot in `prepare`, one slot after another and outside `launchTimeout`, each opening the pinned `app` once so its automation runner is up before the first attempt. An empty pool is a configuration error.

- [#226](https://github.com/tester-army/e2e/pull/226) [`adbc92c`](https://github.com/tester-army/e2e/commit/adbc92c928c6d1d28e65773ccbe58876f4de14a4) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Both engines declare their platform on the handle: `web` for playwright, the
  `platform` option for agent-device. A target that names them no longer has to
  repeat it. Both engines now require `@e2edev/e2e` 0.8 or newer (peer range
  `>=0.8.0 <1`): an older runner rejects `platform` as an unknown engine key,
  and could still send `states.hidden` in a role query, which these engines no
  longer read.

### Patch Changes

- [#232](https://github.com/tester-army/e2e/pull/232) [`25e1897`](https://github.com/tester-army/e2e/commit/25e1897fbbae245814b6622faf04fb29e8d59f9d) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Requires `@e2edev/e2e` 0.8.0 or newer, the release that hands `init` its worker slot and `prepare` its slot count; an older core would fail every device pool at init.

- [#218](https://github.com/tester-army/e2e/pull/218) [`2e50798`](https://github.com/tester-army/e2e/commit/2e50798b3cbd4b813274a53889458eced830747d) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Every optional `mobile()` option (`app`, `appPath`, `device`, `identity`,
  `environment`, `session`, `snapshot`) also accepts `undefined`, so a config
  passes `device: process.env.E2E_DEVICE` straight through instead of spreading
  it in conditionally. The runtime already treated a missing and an `undefined`
  value alike; only the types rejected the latter under
  `exactOptionalPropertyTypes`.

- [#227](https://github.com/tester-army/e2e/pull/227) [`7143477`](https://github.com/tester-army/e2e/commit/7143477435bf5bb59bba778932cc7ad0002ce494) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `getByText` on a device target now resolves to the innermost matching node, as in a browser. iOS reports a React Native `Text` as a host view plus a `StaticText` child with the same label, and container views inherit their children's labels, so every text query on such screens failed with `LOCATOR_AMBIGUOUS`. Ancestors whose match is echoed by a matching descendant are dropped; unrelated duplicates still fail.

- [#225](https://github.com/tester-army/e2e/pull/225) [`47be7f8`](https://github.com/tester-army/e2e/commit/47be7f867da427cfa05f999c9af32ed5fd6eb6ba) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `SelectOption` on the engine contract gains a `{ value }` variant. Playwright
  selects by the option's `value` attribute; the device engine's `selectOption`
  stays `UNSUPPORTED_CAPABILITY` for every variant.

- [#223](https://github.com/tester-army/e2e/pull/223) [`68620ef`](https://github.com/tester-army/e2e/commit/68620ef7459739f89f7846decd54af1c8e5105e9) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Role queries no longer read a `hidden` state from the query: the engine
  contract dropped it. Playwright's role locator keeps its default of matching
  only nodes exposed to assistive technology; the device engine skips hidden
  nodes in role queries as it did by default.

## 0.3.2

### Patch Changes

- [#206](https://github.com/tester-army/e2e/pull/206) [`ffb3403`](https://github.com/tester-army/e2e/commit/ffb34039c319434823f586a7582cdb037220da4f) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Remove temporary raw screenshots after device capture finishes, including
  captures that outlive a timeout or cancellation. Each capture owns a separate
  temporary directory, and the next attempt waits for its cleanup.

- [#194](https://github.com/tester-army/e2e/pull/194) [`d9ecd33`](https://github.com/tester-army/e2e/commit/d9ecd338d8f7c34f79395c874c2f975fe55094eb) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Both engines now require `@e2edev/e2e` 0.5.0 or newer. They import
  `@e2edev/e2e/engine`, which 0.5.0 introduced (0.4.x shipped `/backend`), so
  the old `>=0.4.0` range allowed an install whose every import failed.

## 0.3.1

### Patch Changes

- [#161](https://github.com/tester-army/e2e/pull/161) [`41612dc`](https://github.com/tester-army/e2e/commit/41612dcf44e6e395d578a23c09cf1dd451231095) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Package and CLI descriptions no longer call e2e a "standard".

- [#168](https://github.com/tester-army/e2e/pull/168) [`1ef5b00`](https://github.com/tester-army/e2e/commit/1ef5b003b62a588f554ad567f9d1f4540ffd8b35) Thanks [@devin-ai-integration](https://github.com/apps/devin-ai-integration)! - READMEs and CLI help use the scoped package names (`@e2edev/e2e`,
  `@e2edev/web`, `@e2edev/mobile`) on every install line, point at
  the Fern docs instead of e2e.dev, and describe e2e as an open framework for
  agentic end-to-end testing.

## 0.3.0

### Minor Changes

- [#154](https://github.com/tester-army/e2e/pull/154) [`1d352b3`](https://github.com/tester-army/e2e/commit/1d352b3ee98a02d239c95e4055b4bb5219d7edfc) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The app under test is declared by the engine that drives it, not by the
  config. The top-level `app` key (`url`, `command`, `readyUrl`, `services`,
  `allowedOrigins`, `environment`, `identity`) is gone, and so is the runner's
  `APP_URL` fallback: the browser engine takes the same fields as options,
  `web({ url, command, services, ... })`, and the device engine derives
  the identity from the app it pins (`mobile({ platform, app })`, or an
  explicit `identity`). Two web targets on one app each name it; services and
  commands declared identically by several targets start once.

  For engine authors, the `app` manifest of `defineEngine` carries the
  declaration (`EngineAppDeclaration`) beside its hooks, and the runner
  resolves it per target: navigation policy, cache and session identity, the
  report's target record (`baseOrigin` is now absent for a surface without a
  URL), and the app process all read from there. A device target can finally
  declare a stable identity without inventing a URL. `@e2edev/e2e/engine` also
  exports `obj`, the one-call replacement for the conditional-spread
  idiom when a declaration is built from optional inputs.

  Migrate by moving the `app` block into the engine factory:

  ```ts
  // before
  app: { url: 'http://localhost:3000' },
  targets: [{ name: 'web', platform: 'web', engine: web() }],
  // after
  targets: [{ name: 'web', platform: 'web', engine: web({ url: 'http://localhost:3000' }) }],
  ```

- [#154](https://github.com/tester-army/e2e/pull/154) [`1d352b3`](https://github.com/tester-army/e2e/commit/1d352b3ee98a02d239c95e4055b4bb5219d7edfc) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Rename the "backend" concept to "engine" everywhere. The authoring import is now `@e2edev/e2e/engine` (`defineEngine`, `EngineHandle`, `EngineError`, `EngineFixtureContext`, ...), a target names its engine as `engine: web()` in `e2e.config.ts`, the error code `BACKEND_FAILURE` is now `ENGINE_FAILURE`, and the `backend` provenance field in the report and session schemas is now `engine`. `@e2edev/e2e/backend`, `defineBackend`, `backend:` and `BACKEND_FAILURE` are gone; update the import path, the config key, and any code matching on the error code or reading provenance.

### Patch Changes

- [#149](https://github.com/tester-army/e2e/pull/149) [`f810e23`](https://github.com/tester-army/e2e/commit/f810e2324b02b189cbbb6242a55da5d587285932) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Every `screen` query accepts `visible: true`, which drops nodes the platform reports as hidden before the exactly-one rule runs: `getByText('No memories yet', { visible: true })` resolves the copy a person sees even while a framework keeps a `display:none` twin in the document after a reload. Omitted or `false` keeps every match, so existing `LOCATOR_AMBIGUOUS` failures still fire. The predicate is the node's own `hidden` state, the one `toBeVisible()` reads, and it composes with scopes, `filter`, `first`, `last`, and `nth`. `getByTestId` gains the same optional `{ visible }` argument.

  The engine contract's `SemanticQuery` carries the flag as `visible`; the Playwright and agent-device engines evaluate it from the hidden state they already report, and the harness holds a top-level query to the same predicate as a backstop.

## 0.2.1

### Patch Changes

- [#128](https://github.com/tester-army/e2e/pull/128) [`3c24e17`](https://github.com/tester-army/e2e/commit/3c24e1714bf1862f1e2d48c10e2c649c7ce433a0) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Replace the handwritten PNG codec with pngjs while preserving opaque rectangle masking. Use the library for screenshot test fixtures and reject malformed images.

- [#132](https://github.com/tester-army/e2e/pull/132) [`bc87f15`](https://github.com/tester-army/e2e/commit/bc87f15b3b62258f8e9c059873e1f89a67ba27de) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Keep secret redaction and pixel taint with the live session across serial members. Route device model screenshots through guarded observations and reserve project-tool action budgets before dispatch, serializing mutations with grammar actions.

  Add explicit fixture operation declarations, preserve legacy factories, mark contributed assertions as verification steps, and isolate asynchronous step attribution. Share cancellation helpers; deprecate optional tool annotations whose replay and secret semantics are not implemented.

  Preserve fixture object identity and mutable state when recording declared operations, and retain artifacts and viewport metadata attached before a legacy synchronous failure.

  Bound device located references and reuse snapshot location metadata. Both reference backends require e2e >=0.4.0 for the new fixture and lifecycle helpers.

## 0.2.0

### Minor Changes

- [#117](https://github.com/tester-army/e2e/pull/117) [`44ce280`](https://github.com/tester-army/e2e/commit/44ce280e92772b452b6a958bf1a606b43e7cdba3) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Install builds on the device. The `appPath` backend option installs an iOS
  `.app` bundle or Android `.apk` once per worker, after boot and before the
  first attempt; without `app`, the installed bundle id or package becomes the
  app opened fresh per attempt, so `mobile({ platform: 'ios', appPath:
'./build/MyApp.app' })` is a complete target. The `device` fixture gains
  `installApp(appPath, { app, reinstall })` for tests that exercise upgrade or
  fresh-install paths, recorded as a `device.installApp` step.

  `BackendInitInfo` carries `projectRoot`, the directory relative config paths
  resolve against, so a backend option naming a file resolves the same way in a
  child-process worker and an in-process run.

### Patch Changes

- [#119](https://github.com/tester-army/e2e/pull/119) [`00cfc52`](https://github.com/tester-army/e2e/commit/00cfc52bd5a9ab56f7fb2dad357ce325c9ce4817) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Hooks now run in the order the lifecycle spec defines. `beforeEach` runs outer
  scope to inner and `afterEach` inner to outer regardless of where in the file
  each scope's hooks were declared; before, a file-level hook declared below a
  `test.describe` ran after (or, for `afterEach`, before) the group's own hooks.
  A `describe`'s `afterAll` runs when its last test in the realm finishes rather
  than when the whole file ends, so one group's teardown no longer lands after a
  sibling group's tests. Sibling groups that share a title keep separate hooks.
  A failing `afterAll` discards the realm as the spec requires: later tests start
  fresh, and a serial group attempt ends with its remaining members skipped.

  Each `afterEach` hook gets its own `cleanupTimeout` budget with working
  fixtures: after a body timeout, teardown can still drive the app instead of
  failing with `operation cancelled`; a hook that overruns its budget fails, its
  fixture operations are cancelled, and the next hook still runs. The agent-device
  `device` fixture reads that signal per call, so it too keeps working in teardown.

  Suite-hook run errors carry a readable `scopeId` (`file` or the group title
  path); an `afterAll` failure at file scope no longer writes an empty
  `scopeId` the report schema rejects.

## 0.1.0

### Minor Changes

- [#102](https://github.com/tester-army/e2e/pull/102) [`e3300c4`](https://github.com/tester-army/e2e/commit/e3300c4b420ea7a5a7e3ee15480a1e38bd1a133b) Thanks [@okwasniewski](https://github.com/okwasniewski)! - New package: `@e2edev/mobile`, the mobile backend for `e2e`, built on
  [agent-device](https://github.com/callstack/agent-device). It implements the
  public `@e2edev/e2e/backend` contract for iOS simulators and Android emulators the
  same way `@e2edev/web` does for browsers, and core learns nothing new.

  - `mobile({ platform, app?, device?, session?, snapshot? })` returns a
    `defineBackend` handle with observation (the accessibility tree projected
    onto the role vocabulary, with a viewport and optional pixels), actions
    (tap, double tap, long press, fill, clear, check, Enter, single-character
    keys, node swipe, drag), location (every `screen` query plus agent-device
    selectors through `screen.locator`), a viewport swipe, `app.back`, and
    `app.restart`/`app.clearState` when `app` is pinned. Screenshots land under
    the attempt artifact directory.
  - Trace cache support: the backend reports a location as
    `app://device/<app>/<screen title>`, so `agent.act` steps record a start and
    end anchor and replay zero-turn on the next run like a web step does.
    Screenshots and observation pixels have every secure field painted over;
    an image that cannot be redacted is withheld. With `app` pinned, the app
    is opened fresh per attempt and a flow needs no agent-side tool at all.
  - The contributed `device` fixture: network, airplane mode, permissions,
    location, appearance, orientation, biometrics, open/close app, foreground
    app, home, back, alerts, keyboard, clipboard. Import `test` from the
    package to have it typed.
  - `@e2edev/mobile/tools` exports `mobileTools(...backends)`: an
    `open_app`, `swipe`, `type_text`, `alert`, and `screenshot` pack for
    `createAgent`, scoped to the platforms of the backends passed and
    dispatching to the one whose attempt is running, so one pack serves an iOS
    and an Android target in the same config.

- [#114](https://github.com/tester-army/e2e/pull/114) [`e19b826`](https://github.com/tester-army/e2e/commit/e19b826a7f2a944122099851803f6961f107cf86) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Publish under the `@e2edev` npm scope as restricted (private) packages: the core package `e2e` is now `@e2edev/e2e`, beside `@e2edev/web` and `@e2edev/mobile`. Entry points move with the name (`@e2edev/e2e/agent`, `@e2edev/e2e/backend`, `@e2edev/e2e/run`); the `e2e` CLI binary keeps its name. Provenance is off while the packages are private, since npm only attests public packages.
