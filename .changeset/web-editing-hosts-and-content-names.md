---
'@e2edev/web': patch
---

A `contenteditable` editing host, the root a TipTap, ProseMirror, Lexical, or Slate editor renders into, is a `textbox`: named by its `aria-label`, `aria-placeholder`, or the `data-placeholder` its editor paints, with its text as the value, so the agent types into it directly instead of falling back to the keyboard, a generic secret may fill it (a password still needs a password field), and `toHaveValue` reads it. The blocks inside it are content, not textboxes.

Accessible names come from descendants the way Playwright's role selector computes them: `<button><img alt="Search"></button>` and an icon button whose only child is `<svg aria-label="Close">` are named, a descendant's own `aria-labelledby` and `title` count, `aria-labelledby` wins over `aria-label` as accname orders them, and a hidden element a control references still names it, so `toHaveAccessibleName` reads the name `getByRole` matched and the agent no longer sees anonymous icon buttons.
