---
'@e2edev/agent-device': minor
'@e2edev/e2e': minor
---

Install builds on the device. The `appPath` backend option installs an iOS
`.app` bundle or Android `.apk` once per worker, after boot and before the
first attempt; without `app`, the installed bundle id or package becomes the
app opened fresh per attempt, so `agentDevice({ platform: 'ios', appPath:
'./build/MyApp.app' })` is a complete target. The `device` fixture gains
`installApp(appPath, { app, reinstall })` for tests that exercise upgrade or
fresh-install paths, recorded as a `device.installApp` step.

`BackendInitInfo` carries `projectRoot`, the directory relative config paths
resolve against, so a backend option naming a file resolves the same way in a
child-process worker and an in-process run.
