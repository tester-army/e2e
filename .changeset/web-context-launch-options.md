---
'@e2edev/web': minor
---

`web({ context, launch })` pass Playwright's own configuration through. `context` goes to `browser.newContext` for every context an attempt opens: `locale`, `timezoneId`, `colorScheme`, `ignoreHTTPSErrors`, `storageState`, or a device descriptor spread in whole for mobile emulation. `launch` goes to `browserType.launch`: `channel: 'chrome'`, `executablePath`, `args`, `proxy`, `slowMo`, `timeout`. The engine keeps the keys its bookkeeping owns and refuses them at config load with the option that stands in: `acceptDownloads`, `httpCredentials` (`basicAuth`), `recordVideo` (`--video`), a `null` viewport, and `headless` (`--headed`). `context.viewport` and `viewport` are one setting. A launch naming its own executable or a non-chromium release channel skips the first-run browser download. `WebContextOptions` and `WebLaunchOptions` are exported.
