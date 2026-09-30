---
'e2e': patch
'@e2e-dev/web': patch
'@e2e-dev/mobile': patch
---

Unknown keys are rejected below the top level of the config too, naming the nearest known key when one is a plausible typo and the known keys otherwise. `app: { url, comand }` on a target is `INVALID_CONFIG` (the run used to go on and fail with `APP_UNREACHABLE`), and so are an unknown `web()` or `mobile()` option, an unknown key inside `connect` or `basicAuth`, and an unknown key in `app.command` (`command: { executable, arg }` dropped the arguments). An app option that `web()` or `mobile()` used to take, such as `web({ url })`, is still reported with its place on the target's `app`, not as an unknown key. An unknown test or `describe` option (`{ timout }`) is `COLLECTION_ERROR`, and an unknown query option (`getByRole('link', { nam })`) is `INVALID_LOCATOR` listing the keys the query takes. `e2e/engine` exports `rejectUnknownKeys(label, value, keys)`, the same check for an engine's own options.
