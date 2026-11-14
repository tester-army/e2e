---
"e2e": patch
---

Add `appLog: { file: true }`: every entry the engine reports for an attempt — uncapped, redacted, one line each — is written to `app-log.txt` beside its screenshots (`results/<test>/attempt-1/app-log.txt`) and registered as a `log` artifact. `report.appLog` and the failure page keep their caps (an app that chats while it loads burns the 100-info quota before the test runs, dropping the lines around the interesting warning). `maxBytes` (default 20 MB) ends the file with a line saying it stopped. A test takes the same object as its own option; `file: false` opts out of a run that turned it on.
