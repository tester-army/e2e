---
"@e2e-dev/web": patch
---

Chromium launches with its OS sandbox on by default, so a renderer exploit on a page the agent reaches stays contained instead of running as the user running `e2e run`. `web({ chromiumSandbox: false })` or `E2E_CHROMIUM_SANDBOX=0` turns it off on a host where the sandbox cannot start.
