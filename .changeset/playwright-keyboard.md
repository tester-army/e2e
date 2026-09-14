---
'@e2edev/playwright': minor
---

Declares the `keyboard` capability: `keyboard.type` types into whatever has focus through Playwright's keyboard, clearing first with select-all and delete when asked to replace, and refuses with `NOT_ACTIONABLE` when nothing that takes keystrokes has focus in any frame (the body, a button, a link, a select, a non-text input), so keystrokes never vanish into the page; a text field, a contenteditable host, a canvas, or any other element the app made focusable takes them. `keyboard.press` sends one key to the focused element.
