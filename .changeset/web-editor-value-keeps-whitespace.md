---
'@e2e-dev/web': patch
---

A `contenteditable` editor's value keeps the whitespace it renders. The reader trimmed an editor's text before reporting it as the textbox value, so a `white-space: pre-wrap` editor holding `"  keep spaces  "` failed `toHaveValue('  keep spaces  ')` and passed `toHaveValue('keep spaces')`, while a native input with the same value did what the docs promise: `toHaveValue` compares a value as it is, spaces and newlines included. The value is now the rendered text as is, with two normalizations left: an editor whose document is only the `<p><br></p>` an empty editor renders, which the browser reads as a newline, still reads as `''`, and the zero-width no-break space Slate and Quill pad an empty line with is left out, so an empty Slate editor reads as `''` too. Code editors and rich text with leading or trailing whitespace assert on it correctly, and `inputValue()` returns the same text.
