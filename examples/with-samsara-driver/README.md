# Samsara Driver with VisionFlow debug recording

Ports the existing Driver **Assignment rows are fully labeled** check to the
`@e2e-dev/mobile` engine. e2e drives the app; VisionFlow only records the debug
session. No change to either framework is required.

The [`onAction` hook from PR 1219](https://github.com/tester-army/e2e/pull/1219)
is awaited after each settled action, including cache replays. The bridge calls
`app.screenshot()` and `DebugSession.recordHostPhase()` once per event, preserving
its action-budget index, redacted summary, and `model` or `replay` source.
Sequence numbers span acts even though action-budget indexes reset. The CLI prints
the session URL after each action; open that session to inspect each action's
screenshot. These are session links, not per-step deep links. A recording failure
fails the step, rather than silently losing evidence.

## Source and scope

Source: [`assignment-screen-visionflow.ai.spec.ts`](https://github.com/samsara-dev/backend/blob/1795325ae23f3eebb168bc7f6df8f1ccebaa79e2/mobile/Troy/mobile-e2e-tests/tests/regression/assignment-screen-visionflow.ai.spec.ts),
with the observable contract from `prompts/assignments.yaml`, `verify_rows_labeled`.
The source repository requires Samsara access.

The check preserves readable assignment labels, carrier name and DOT number when
that row is present, and the absence of icon-only blank rows. It uses a read-only,
screenshot-only `agent.assert`, paired with deterministic heading and Vehicle-row
checks so an empty sheet cannot pass vacuously.

Provisioning and sign-in are setup preconditions here, not ports of the backend's
dynamic-driver fixtures. Prepare a disposable test-org driver with no vehicle,
then sign in **outside this e2e attempt** and finish permission/onboarding prompts.
Leave Driver on Home or Assignments. The example opens Assignments through Assets
if needed. It never selects a vehicle or presses Done.

e2e withholds model pixels for the rest of an attempt after a secret fill.
Signing in inside this test would make the screenshot-only check fail with
`POLICY_DENIED`; using a semantic-tree-only check would miss the visual regression.
This example does not weaken that policy or read raw device screenshots around it.

The original Appwright/VisionFlow test remains in place. This draft is a migration
pilot, not a claim that its CI coverage has been replaced.

## Run

Requires Node 24.8+ and a booted iOS simulator or Android emulator with a compatible
Samsara Driver build installed under `com.samsara.driver`. This example uses local
devices, not the source suite's BrowserStack lane.

`@samsara-dev/visionflow` is access-controlled on GitHub Packages. Configure your
user-level npm authentication for the `@samsara-dev` scope through your approved
setup. Do not commit an npm token, credentials, or a registry auth file. Like the
other examples, this project sits outside the pnpm workspace and uses published
packages, with no committed lockfile.

```sh
cd examples/with-samsara-driver
npm install
npm run typecheck
npm run test:unit
```

Set these through your local shell or secret manager, without committing values:

| Variable                    | Purpose                                      |
| --------------------------- | -------------------------------------------- |
| `AI_GATEWAY_API_KEY`        | Vercel AI Gateway authentication             |
| `E2E_MODEL`                 | Gateway model ID available to your account   |
| `VISIONFLOW_DEBUG_BASE_URL` | Authorized VisionFlow debug service URL      |
| `VISIONFLOW_DEBUG_API_KEY`  | Debug service bearer credential, if required |
| `DRIVER_IOS_DEVICE`         | Optional simulator name or UDID              |
| `DRIVER_ANDROID_DEVICE`     | Optional emulator name or serial             |

```sh
npm run test:e2e:ios
# or
npm run test:e2e:android
```

Use only an approved test account and viewer. The SDK uploads original screen
captures; they can contain test driver, carrier, or vehicle information. It does
not apply extra masking. Do not point it at an unapproved public upload service.
Keep generated `.e2e/` artifacts out of source control.

## Validation status

Last checked: typecheck and bridge tests only. The bridge tests exercise the real
VisionFlow SDK against a loopback HTTP server with synthetic PNG input, including
model/replay recording and failed-test status. They do not prove device behavior,
model judgments, or hosted viewer rendering. No Driver device run has been made;
the migration needs both-platform device evidence before replacing the source.
