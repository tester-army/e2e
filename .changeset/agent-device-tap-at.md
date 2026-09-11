---
'@e2edev/agent-device': minor
---

The engine declares `tapAt`: a settled press at one screen point in logical
pixels with no element behind it, which the agent's `tap_at` uses when the
point the model named in the screenshot lands on nothing the tree lists. The
pack's own `screenshot` tool is gone: the agent's grammar now offers
`screenshot` and `tap_at` on every engine while no secret has been filled, and
a project tool under a grammar name is rejected, so `agentDeviceTools()` no
longer returns one.
