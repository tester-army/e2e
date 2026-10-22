---
"@e2e-dev/mobile": patch
---

Read an empty iOS text field as empty. XCTest reports an empty field's placeholder as its value, so the agent and `toHaveValue` saw the placeholder text as typed text, and an agent asked to submit an empty form spent its turns trying to delete it.
