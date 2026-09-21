---
'e2e': minor
'@e2edev/web': patch
'@e2edev/mobile': patch
---

`Role` grows by the composite widgets and structure ported Playwright tests name: `tablist`, `tabpanel`, `menu`, `menubar`, `menuitemcheckbox`, `menuitemradio`, `progressbar`, `spinbutton`, `meter`, `toolbar`, `tooltip`, `group`, `separator`, `radiogroup`, `grid`, `gridcell`, `rowgroup`, `rowheader`, `tree`, `treeitem`, `article`, `figure`, and `form`. The list stays closed. `getByRole('img')` is accepted as an alias of `image` and builds the `image` query, so engines, the trace cache, and reports never see `img`.

The Playwright engine spells `image` as ARIA `img` when it locates, which is what made `getByRole('image')` find nothing before, and reads `role="img"` back as `image`. Its reader derives the new roles from HTML semantics (`<progress>`, `<meter>`, `<hr>`, `<fieldset>`, `<details>`, `<input type="number">`, `<thead>`/`<tbody>`, `<th scope="row">`, `<figure>`, `<article>`, a named `<form>` or `<section>`, `<header>`/`<footer>`/`<aside>` landmarks) instead of dropping them.

The mobile engine maps a tab bar, a segmented control, and a `TabLayout` to `tablist`, their items to `tab`, a progress indicator or `ProgressBar` to `progressbar` (an activity indicator stays `status`), a stepper or `NumberPicker` to `spinbutton`, and `Toolbar`, `Menu`, `MenuItem`, and `RadioGroup` to their roles on both platforms.
