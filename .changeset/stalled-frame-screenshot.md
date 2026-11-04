---
"@e2e-dev/web": patch
---

In Chromium, screenshots, `toHaveScreenshot`, and observations no longer wait on an iframe whose first navigation has not committed, such as one whose request a route handler holds. Before, they timed out with no screenshot.
