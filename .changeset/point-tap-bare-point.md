---
"e2e": patch
---

`tap_at` and `hover_at`, in `agent.act` and `e2e mcp`, now act on the bare point the model aimed at whenever the engine takes one, instead of snapping to the listed control under it and acting on that control's center. Before, a point outside an iOS popover snapped to the full-screen dismiss region and tapped its center, inside the popover, so the popover never closed. An engine that taps listed nodes only still gets the control by id.
