---
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
"@e2e-dev/acp": patch
"@e2e-dev/limrun": patch
---

Name the released version each peer floor already meant in practice: web and mobile move their `e2e` peer floor from the never-published `0.22.1` to `0.23.0`, which first exports the `stepTimeout` value and the `EngineDoctorCheck` types both engines import; acp moves from the never-published `0.21.4` to `0.22.0`, which first exports the `e2e/agent` rules and tools it imports; limrun moves its mobile peer from the never-published `0.11.1` to `0.12.0`, the first mobile release with the provider-owned local daemon change from #988 (on `0.11.0` the local daemon picks up `AGENT_DEVICE_DAEMON_BASE_URL`). None of these cuts off a released version a consumer could install on the old range, so each is a patch.
