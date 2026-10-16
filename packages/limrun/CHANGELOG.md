# @e2e-dev/limrun

## 0.2.0

### Minor Changes

- [#988](https://github.com/tester-army/e2e/pull/988) [`c807f94`](https://github.com/tester-army/e2e/commit/c807f9480646a13f00d308cdd0a90034908b5543) Thanks [@enesonus](https://github.com/enesonus)! - Add the Limrun device provider with one hosted instance per worker, app
  installation, recording through agent-device, and cleanup on run exit.
  Renew retained driver leases while other targets run. Keep provider-owned
  local daemons isolated from ambient remote-daemon environment settings.

### Patch Changes

- [#1066](https://github.com/tester-army/e2e/pull/1066) [`c4263bd`](https://github.com/tester-army/e2e/commit/c4263bde1786fdf19817eb53441e5460e682f012) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Ship agent-device as a regular dependency pinned to the mobile engine's version instead of an exact peer dependency, so users no longer install it by hand.
