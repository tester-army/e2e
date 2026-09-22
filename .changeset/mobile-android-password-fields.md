---
'@e2edev/mobile': patch
---

An Android password field is a secure `textbox`. UIAutomator marks a password `EditText` with the `password` attribute rather than a class of its own, and the engine read only the class, so the field projected as a plain textbox: `type_secret` and `fill(secret)` with a credential's password were refused on every Android sign-in form (`field purpose none is incompatible with secret purpose password`), the typed value reached model input, and screenshots left the field unmasked. The node now carries `secure` and `inputPurpose: 'password'`, drops its value, and is painted over in screenshots like an iOS `SecureTextField`. A node the platform reports as editable is a `textbox` whatever its class, so a custom input view takes typed text and secrets too.
