---
"e2e": patch
---

Add opt-in `e2e/ocr` with a local Tesseract adapter, read-only screenshot OCR tools for the normal agent, and a model-free callback executor for reading, locating, asserting, and tapping recognized text. OCR taps validate fresh full-viewport evidence and use checked harness actions; only the OCR executor disables its own replay cache. Tesseract 5 and language data must be installed independently. Nothing downloads automatically, and screenshot masking and secret-taint protections still apply.
