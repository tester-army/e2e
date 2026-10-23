---
"@e2e-dev/mobile": patch
---

Add `mobile({ screenshotPixelDensity: 1 | 2 | 3 })` for higher-resolution iOS simulator screenshots. Observation pixels and saved screenshots use the requested density while retaining secure-field masking. Omitted, screenshot behavior is unchanged. Android rejects the option; physical iOS devices refuse it during capture.
