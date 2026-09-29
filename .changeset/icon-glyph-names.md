---
'@e2e-dev/web': patch
---

Names read CSS generated content, as the browser and `getByRole` do, and drop icon-font glyphs. A Font Awesome button, `<button><i class="fa fa-sign-in"> Login</i></button>`, is `button "Login"` on screen and `getByRole('button', { name: 'Login' })` finds it, where it used to find nothing; a `.next::before { content: "→" }` icon reads `button "→ Next"` in both. A glyph between two words reads as a space, and a control whose only content is a glyph reads as its `title`, though the browser names it by the glyph, so a role query by that title still finds nothing.
