---
"@e2e-dev/mobile": patch
"@e2e-dev/acp": patch
"@e2e-dev/limrun": patch
---

- mobile: `e2e` peer floor `>=0.22.1` to `>=0.23.0`, the first version exporting the `stepTimeout` value and the `EngineDoctorCheck` types it imports.
- acp: `e2e` peer floor `>=0.21.4` to `>=0.22.0`, the first version exporting the `e2e/agent` rules and tools it imports.
- limrun: mobile peer floor `>=0.11.1` to `>=0.12.0`, the first mobile release with the provider-owned local daemon change from #988.
