---
"e2e": patch
---

Avoid an extra 500 ms change wait after the agent scrolls to text on a device. The final page has already settled; the next observation still checks stability. This applies to live execution and replay, while engines that scroll the final node into view keep their change wait.
