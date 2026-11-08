---
"e2e": patch
"@e2e-dev/web": patch
---

Read a listed node's computed style from a read-only project tool with
`getToolContext(options).read({ id }, { style: ['color', 'font-weight'] })`.
The web engine returns allow-listed CSS values, secret-redacted, under the
step's deadline. Engines can implement the optional `readStyle` method over the
engine protocol; engines without it report `UNSUPPORTED_CAPABILITY`.
