---
'e2e': patch
---

The shipped skill installs from `@canary` and lists `tap_at`, `toHaveClass`, and `secondaryTap` as unsupported on a device; the `expect.any(Object)` JSDoc says `null` matches, as it does.
