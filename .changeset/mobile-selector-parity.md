---
"@e2e-dev/mobile": minor
---

`device.locator()` and the `selector` locator match with agent-device's own term rules (`listSelectorChainMatches`, 0.21.21) instead of the engine's copy of them, which had drifted. A selector can match different nodes than before:

- `role` takes agent-device's kind, the role `agent-device snapshot` prints (`text-field`, `navigation-bar`, `scroll-area`), not the `getByRole` role. `role=textbox` becomes `role=text-field`, `role=navigation` becomes `role=navigation-bar`, `role=listitem` becomes `role=cell`. Platform type names (`StaticText`, `NavigationBar`) still match through agent-device's deprecated aliases; the docs now use the kind.
- Text terms (`id`, `label`, `value`, `text`) compare case-insensitively.
- `visible` means hittable or a non-empty frame, and `hidden` its opposite.
- `editable` means a fillable type that is enabled; a disabled field is not editable.
- `hittable` matches only a node that reports it; one that doesn't say is no longer counted as hittable.
- `text` reads the first non-empty label, value, or identifier.
