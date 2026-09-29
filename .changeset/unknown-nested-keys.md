---
'e2e': patch
'@e2e-dev/web': patch
'@e2e-dev/mobile': patch
---

Unknown keys are rejected below the top level of the config too, naming the nearest known key when one is a plausible typo and the known keys otherwise. `web({ url, comand })` and an unknown key inside `connect` or `basicAuth` are `INVALID_CONFIG` (the run used to go on and fail with `APP_UNREACHABLE`), and so are an unknown `mobile()` option and an unknown key in a `command`, a service, or a service's `teardown` (`command: { executable, arg }` dropped the arguments). An unknown test or `describe` option (`{ timout }`) is `COLLECTION_ERROR`, and an unknown query option (`getByRole('link', { nam })`) is `INVALID_LOCATOR` listing the keys the query takes. `e2e/engine` exports `rejectUnknownKeys(label, value, keys)`, the same check for an engine's own options.
