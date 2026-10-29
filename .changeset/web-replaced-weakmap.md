---
"@e2e-dev/web": patch
---

Screenshots no longer fail with `ENGINE_FAILURE` ("closed-shadow root tracking is unavailable") on a page that replaces the global `WeakMap`, as some polyfills do. On such pages, locators find elements inside closed shadow roots again, and CDP reconnects no longer fail.
