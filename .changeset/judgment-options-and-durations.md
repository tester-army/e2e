---
"@e2edev/e2e": minor
---

The judgment calls take named option types, and duration options drop the
`Ms` suffix. `assert` takes `AssertOptions`; `waitFor` takes
`WaitForOptions`, with `interval` where it had `intervalMs`; `extract` takes
`ExtractOptions` and loses `maxModelCalls`, since its budget is fixed at two
calls (one extraction plus one repair round) and the knob only ever accepted 1
or 2. `longPress` takes `LongPressOptions`, with `duration` where it had
`durationMs`. Every duration is still in milliseconds, like `timeout`.
