// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {"id":"9df55695b7d0449c40232727d2b3cad2ce1fe8490dbaa4d5ab06ece9a654da27","testId":"tests-agent/scenarios.e2e.ts::act%20completes%20overlay-trap"},
  [
  replay.step(
    {
      "key": "3aa75b32cb016b70702dbf3853d17fb70dcd7fca5274a024199db5d58a671d00",
      "order": 0,
      "variant": {
        "agent": "37a8eec1ce19687d132fe29051dca629d164e2c4958ba141d5f4133a33f0688f",
        "project": "6c340b4558007fd12144b6a4e0daf3abb724b92faa2d08705fa564444b68533c",
        "target": "4b5e57f6eb2f42b9039b3d1e13929295f231749c510cbe341cd68036d9af97e2"
      }
    },
    replay.define(
      {
        "endAnchors": [
          {
            "testId": "success-message",
            "text": "You made it past the overlay"
          }
        ],
        "endPath": "/e/overlay-trap",
        "endWaitMs": 11329,
        "executor": {
          "name": "e2e-default-agent",
          "version": "2"
        },
        "goneAnchors": [
          {
            "text": "Accept cookies, close whatever is blocking clicks, then press Continue."
          },
          {
            "testId": "blocked-count",
            "text": "Blocked clicks: 0"
          },
          {
            "name": "Continue",
            "role": "button",
            "testId": "continue-button"
          },
          {
            "text": "We use cookies to run this benchmark."
          },
          {
            "name": "Accept cookies",
            "role": "button",
            "testId": "accept-cookies-button"
          }
        ],
        "recordedFor": {
          "agent": "default",
          "callIndex": 0,
          "instructionDigest": "6705af9140f936652f275b785be7e42b157ba15b3fa16eefba2c51d6f3fdcd1b",
          "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
          "targetId": "web",
          "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20overlay-trap"
        },
        "startPath": "/e/overlay-trap",
        "summary": "Dismissed the cookie banner, closed the overlay, and pressed Continue. The page shows “You made it past the overlay.”"
      },
      [
        replay.tap({
          "summary": "tap button \"Accept cookies\"",
          "target": {
            "name": "Accept cookies",
            "role": "button",
            "testId": "accept-cookies-button"
          }
        }),
        replay.tap({
          "summary": "tap button \"× close overlay\"",
          "target": {
            "name": "× close overlay",
            "role": "button"
          }
        }),
        replay.tap({
          "summary": "tap button \"Continue\"",
          "target": {
            "name": "Continue",
            "role": "button",
            "testId": "continue-button"
          }
        }),
      ],
    )
  ),
  ],
);
