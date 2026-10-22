---
"e2e": patch
---

Every action in an `e2e mcp` session now answers with the test line that repeats it, such as `Test line: await screen.getByRole("button", "Save").tap();`, so a coding agent can write the test while it walks the flow. The locator comes from the node as the agent saw it and is checked against the live screen first: it must match that node and nothing else, and twins are narrowed with `{ visible: true }`, a container, or `.nth()`. When no locator works, the result says why and prints no line. Fills name `credentials.user(name)` or `secrets.get(name)`, never a value. The new read-only `test_lines` catalog tool returns the session's lines in order as a draft test body. A project tool can no longer be named `test_lines`, and the `e2e_mcp_session` telemetry event counts its calls under its own name.
