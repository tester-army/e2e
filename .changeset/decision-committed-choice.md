---
"@e2e-dev/decision": patch
---

A decision answer with no probability distribution, as a language model answering through an AI Gateway decision fallback returns, now counts as a committed choice with probability 1 and confidence 0 instead of failing the step with `MODEL_OUTPUT_INVALID`. The docs show how to set a confidence-based gateway fallback on the executor.
