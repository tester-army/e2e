---
'@e2edev/e2e': minor
---

Driver action events carry `detail`: bounded, redacted prose for what the
action did — `tap button "Approve"`, `fill secret "password" into textbox
"Password"` — with the same wording as recorded trace summaries, so a live
reporter or an embedding host can render each act without a side lookup.
Secret values never appear; the secret's stable name stands in.
`report-v1.schema.json` gains the optional `event.detail` field
(`suiteVersion` 0.6.0 → 0.7.0).
