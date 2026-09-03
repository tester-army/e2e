---
'@e2edev/agent-device': minor
---

Install builds on the device. The `appPath` backend option installs an iOS
`.app` bundle or Android `.apk` once per worker, after boot and before the
first attempt; without `app`, the installed bundle id or package becomes the
app opened fresh per attempt, so `agentDevice({ platform: 'ios', appPath:
'./build/MyApp.app' })` is a complete target. The `device` fixture gains
`installApp(appPath, { app, reinstall })` for tests that exercise upgrade or
fresh-install paths, recorded as a `device.installApp` step.
