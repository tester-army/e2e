---
"e2e": patch
"@e2e-dev/decision": patch
"@e2e-dev/mobile": patch
---

PNG decoding and encoding now run on `@napi-rs/image`, a native addon with a prebuilt binary per platform, in place of `fast-png` and `pngjs`: decoding is 8 to 15 times faster, encoding 5 to 8 times, and a `toHaveScreenshot` capture 4 to 12 times. Stored screenshots decode to the same pixels as before. A screenshot the runner writes (a new baseline, or one rewritten because the screen changed) has the same pixels in different bytes: a Chromium capture comes out about 15% larger and a device screenshot about 20% smaller. The binary adds about 15 to 21 MB to an install, depending on the platform, and the package publishes none for Linux on ppc64, s390x, or riscv64. `e2e` loads it when the first screenshot is read or written, so `--version` and a run that takes none never need it, and a missing binding fails that call with `IMAGE_CODEC_UNAVAILABLE`; `@e2e-dev/mobile` and `@e2e-dev/decision` load it when they are imported. Gray PNGs with 1, 2, or 4 bits per sample now decode, and a 16-bit gray or RGB PNG with a transparent color now compares pixels to it at 16 bits, so a pixel that only rounds to it at 8 bits stays opaque.
