---
"@e2edev/agent-device": patch
---

`@e2edev/agent-device/tools` no longer imports `ai` at run time. `ai` is an optional peer dependency, and the tool pack loads with the project's config, so a project without `ai` failed at config load with `ERR_MODULE_NOT_FOUND` instead of getting as far as its own steps. The tools are typed the same way; nothing changes for a project that has `ai`.
