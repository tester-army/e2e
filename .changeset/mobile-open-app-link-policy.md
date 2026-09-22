---
'@e2edev/mobile': patch
---

`device.openApp` and the agent's `open_app` tool take an app, never a link. agent-device opens any `scheme:rest` string as a URL, so `open_app({ app: 'file:///...' })` from the model, or `device.openApp('data:...')` from a test, reached the device as a navigation no rule had checked. A `file:`, `data:`, or `javascript:` link is now `POLICY_DENIED` before the device sees it, as it is for `openLink`; any other link is `INVALID_ARGUMENT` pointing at `device.openLink`. A bundle id, package, or display name is unchanged, and the `device.openApp` step label drops a link's query the way `openLink` does.
