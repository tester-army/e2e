---
'@e2e-dev/web': minor
---

web({ locale, timezoneId }) sets the language and time zone every attempt's context runs in, as Playwright's `use.locale` and `use.timezoneId` do: `navigator.language`, `Intl`, the `Accept-Language` header, and local `Date` time. A tag `Intl` rejects is `INVALID_CONFIG` at config load, and so is an `accept-language` entry in `headers` beside `locale`, and either option on a persistent remote context (`connect.reconnectEndpoint`, or a provider with `scope: 'attempt'`).
