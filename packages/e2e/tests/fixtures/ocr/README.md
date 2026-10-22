# OCR fixtures

`lines.tsv` is hand-written, deterministic Tesseract-shaped output. It exercises
line grouping, distinct blocks, Unicode, geometry, and minimum-word confidence.

`controls.png` is an original synthetic 640 by 160 image with black “Continue”
and “Cancel” text on a white background. It contains no captured user data.
It was rendered with Pillow and the locally installed DejaVu Sans font at
36 pixels, at positions (24, 18) and (24, 88), respectively.

The unit suite needs no Tesseract installation. To also run the local recognition
smoke test with independently installed Tesseract and English traineddata:

```sh
E2E_TESSERACT_SMOKE=1 pnpm --filter e2e exec vitest run tests/unit/ocr-tesseract.test.ts
```

The adapter follows Tesseract's [TSV format](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html#tsv-output)
and [CLI manual](https://github.com/tesseract-ocr/tesseract/blob/main/doc/tesseract.1.asc).
Tesseract is [Apache-2.0 licensed](https://github.com/tesseract-ocr/tesseract/blob/main/LICENSE)
and is not bundled or downloaded by this package.
