---
'e2e': patch
---

A reporter whose `onEvent` throws, or returns a promise that rejects, is still quarantined for the rest of the run, and now says so: one stderr line, `e2e: reporter "<name>" threw on <event type>: <message>; ignoring it for the rest of the run`, in the style of the `onRunFinished` diagnostics. Before, the reporter fell silent with nothing to say why.
