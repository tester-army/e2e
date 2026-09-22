# @e2edev/mobile

## 0.8.0

### Minor Changes

- [#365](https://github.com/tester-army/e2e/pull/365) [`f7f86d9`](https://github.com/tester-army/e2e/commit/f7f86d91e87b317dea9ae076f143e20f6ba8ed98) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `mobile({ device })` accepts a `DeviceProvider`: an object that leases one hosted device per worker slot when the run starts and releases every lease when it ends. The engine drives each lease through the agent-device daemon the lease names (`daemon.baseUrl`, `daemon.authToken`) instead of the local one, selects `device` inside it when given, and skips its own `appPath` install when the lease reports `installedApp`. Slots lease in parallel; a slot that fails releases the others and ends the run before any test. No vendor ships in the package; the mobile guide shows an example provider against a generic session API. `DeviceProvider`, `DeviceRequest`, `DeviceLease`, and `DeviceReleaseContext` are exported.

- [#380](https://github.com/tester-army/e2e/pull/380) [`54c0dba`](https://github.com/tester-army/e2e/commit/54c0dba62fc47403564ece41ce503bb9b9ce9a08) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The engine declares the `swipeTo` pointer action and performs it as a coordinate swipe from the point to `target`, so `screen.swipe({ from, to })` works on a device. A directional swipe at a bare point is still `UNSUPPORTED_CAPABILITY`; `screen.swipe({ direction })` scrolls the screen root as before.

- [#416](https://github.com/tester-army/e2e/pull/416) [`41f3b32`](https://github.com/tester-army/e2e/commit/41f3b3211bcd08d6d76370c2e57c8a4af8b936fa) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A `DeviceLease` can carry `client`: agent-device client configuration the worker's client is created with, next to the `daemon` address, which becomes optional. A daemon that runs agent-device's own device-cloud runtimes resolves a hosted device from the lease scope on each command (`tenant`, `runId`, `leaseId`, `leaseBackend`, `leaseProvider`), and a `stateDir` reaches a daemon the provider started, so such a provider returns what `leases.allocate` gave it and no longer needs a daemon address or a proxy that stamps the scope onto requests. `session`, `daemonBaseUrl`, `daemonAuthToken`, and `daemonTransport` stay with the engine and `daemon`; a lease setting them, or one carrying anything JSON cannot round-trip, is refused. `DeviceClientConfig` and `DeviceConnection` are exported; the mobile guide shows a provider on a device cloud.

- [#385](https://github.com/tester-army/e2e/pull/385) [`d7d2799`](https://github.com/tester-army/e2e/commit/d7d27993a6fd8653f6c21524c4e81a286c5e07a3) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `device.openLink(url, { app? })` opens a deep link (`myapp://orders/42`) or a web link on the device, into the pinned app by default, for magic-link sign-in and deep-link routes; the session observes that app afterwards. iOS launches the app for a web link and then opens the URL, Android starts the link on the package. Without an app, Android lets the OS route the link and the session follows the package that took it; iOS needs one (`INVALID_ARGUMENT`), since an open bound to no app leaves nothing to observe. `file:`, `data:`, and `javascript:` links are `POLICY_DENIED`, as on the web. The step is recorded as `device.openLink` with the link cut before its query, so a magic-link token never enters the report.

- [#392](https://github.com/tester-army/e2e/pull/392) [`f5e96d0`](https://github.com/tester-army/e2e/commit/f5e96d0cbea6bc26da1084ea3bbc49b7a7a16dd8) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The engine packages are named after what they drive, not what they are built on. `@e2edev/playwright` is now `@e2edev/web` with a `web()` factory, and `@e2edev/agent-device` is now `@e2edev/mobile` with a `mobile()` factory; the engine names in reports and telemetry follow (`web`, `mobile`). Option types rename with them (`WebOptions`, `WebConnectOptions`, `WebBasicAuth`, `MobileOptions`, `MobilePlatform`), the agent tool pack is `mobileTools` from `@e2edev/mobile/tools`, and the `device` fixture keeps its name. `PlaywrightLiveSurface` keeps its name because it hands out Playwright objects. `e2e init` writes the new packages. Replace the dependency and the import in an existing project; the old packages are deprecated on npm and receive no further releases.

### Patch Changes

- [#378](https://github.com/tester-army/e2e/pull/378) [`a124837`](https://github.com/tester-army/e2e/commit/a124837191be58a65dea105146f63295ec896445) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An agent-device failure keeps its hint in the engine error message. `dismissKeyboard` on an iPhone keyboard is refused upstream because the keyboard shows no dismiss key and agent-device taps nothing outside it; the model used to see only the refusal and retried it, and now reads the recovery path (the app's own Done control, or pressing return) in the same message.

- [#383](https://github.com/tester-army/e2e/pull/383) [`856e088`](https://github.com/tester-army/e2e/commit/856e08863442191381ef51fc251981cec01c2844) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `Role` grows by the composite widgets and structure ported Playwright tests name: `tablist`, `tabpanel`, `menu`, `menubar`, `menuitemcheckbox`, `menuitemradio`, `progressbar`, `spinbutton`, `meter`, `toolbar`, `tooltip`, `group`, `separator`, `radiogroup`, `grid`, `gridcell`, `rowgroup`, `rowheader`, `tree`, `treeitem`, `article`, `figure`, and `form`. The list stays closed. `getByRole('img')` is accepted as an alias of `image` and builds the `image` query, so engines, the trace cache, and reports never see `img`.
  
  The web engine reads `role="img"` back as `image`, and its reader derives the new roles from HTML semantics (`<progress>`, `<meter>`, `<hr>`, `<fieldset>`, `<details>`, `<input type="number">`, `<thead>`/`<tbody>`, `<th scope="row">`, `<figure>`, `<article>`, a named `<form>` or `<section>`, `<header>`/`<footer>`/`<aside>` landmarks) instead of dropping them, and names a fieldset, figure, or table by its legend, figcaption, or caption.
  
  The mobile engine maps a tab bar, a segmented control, and a `TabLayout` to `tablist`, their items to `tab` (on iOS, the buttons inside a tab bar or segmented control), a progress indicator or `ProgressBar` to `progressbar` (an activity indicator stays `status`), a stepper or `NumberPicker` to `spinbutton`, and `Toolbar`, `Menu`, `MenuItem`, and `RadioGroup` to their roles on both platforms.
- Updated dependencies [[`eb739e9`](https://github.com/tester-army/e2e/commit/eb739e930d533db36206d622c960d18a1ba965e7), [`54c0dba`](https://github.com/tester-army/e2e/commit/54c0dba62fc47403564ece41ce503bb9b9ce9a08), [`4c93414`](https://github.com/tester-army/e2e/commit/4c934142bc4ef4002811eff2be20d463343dd381), [`f7f86d9`](https://github.com/tester-army/e2e/commit/f7f86d91e87b317dea9ae076f143e20f6ba8ed98), [`a577da3`](https://github.com/tester-army/e2e/commit/a577da3199c42402dfb9a04cd8452c5d89ab40dc), [`a583a88`](https://github.com/tester-army/e2e/commit/a583a88254cd80450f986174b022cf961442e7f0), [`2e18196`](https://github.com/tester-army/e2e/commit/2e18196b79ac724c2a274a27562ea06d7a316d02), [`0f864ad`](https://github.com/tester-army/e2e/commit/0f864ad3f3e7f5242ed957941e58e55e1a818aee), [`2b9361f`](https://github.com/tester-army/e2e/commit/2b9361ffea8e39d2c32a5b1e2a6a98c2da759380), [`2e4d40e`](https://github.com/tester-army/e2e/commit/2e4d40eb0754f2558e5e89fe80b4b4933183d023), [`9f2b73f`](https://github.com/tester-army/e2e/commit/9f2b73f9293d4cdee449bb04e4f8272477d22402), [`0e525a0`](https://github.com/tester-army/e2e/commit/0e525a09dd2b8287280b1ede81a06d32dcb7f1d3), [`f5e96d0`](https://github.com/tester-army/e2e/commit/f5e96d0cbea6bc26da1084ea3bbc49b7a7a16dd8), [`f01c01f`](https://github.com/tester-army/e2e/commit/f01c01fbe3a73f2e9380a7db2e62718517ab2e6b), [`d043035`](https://github.com/tester-army/e2e/commit/d04303523652b264b02af82d200f7cc726c044b3), [`dcfe53a`](https://github.com/tester-army/e2e/commit/dcfe53a4b0e4c70b5f9a01f980c6dffea021f8c9), [`ae930bb`](https://github.com/tester-army/e2e/commit/ae930bbf9a6d3793ad9f96e0efb2e8c36cb7665a), [`856e088`](https://github.com/tester-army/e2e/commit/856e08863442191381ef51fc251981cec01c2844)]:
  - e2e@0.15.0

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
