// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {"id":"e828039884c121972edbf9525fdd473c5566b9b7d43d23759675be1b90b70b4b","testId":"tests-agent/scenarios.e2e.ts::act%20completes%20async-states"},
  [
  replay.step(
    {
      "key": "8824c0ed0453a4cff1a8e95fedfdc3a84f8ac1e50ac5bdc4936ef96d54a5e088",
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
            "text": "Code verified successfully"
          }
        ],
        "endPath": "/e/async-states",
        "endWaitMs": 11512,
        "executor": {
          "name": "e2e-default-agent",
          "version": "2"
        },
        "goneAnchors": [
          {
            "testId": "initial-loading"
          }
        ],
        "recordedFor": {
          "agent": "default",
          "callIndex": 0,
          "instructionDigest": "3d8730745312e1ce478b253dcad7910775eb76246846228b0ca02a78e514aa88",
          "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
          "targetId": "web",
          "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20async-states"
        },
        "startPath": "/e/async-states",
        "summary": "Waited for the page to load, sent the code, read 4407 from the toast, entered it, and submitted once Verify was enabled. The page shows “Code verified successfully.”"
      },
      [
        replay.tap({
          "summary": "tap button \"Send code\"",
          "target": {
            "name": "Send code",
            "role": "button",
            "testId": "send-code-button"
          }
        }),
        replay.tool({
          "derived": "minted-token",
          "summary": "tool type (run-time value)"
        }),
        replay.tap({
          "summary": "tap button \"Verify\"",
          "target": {
            "name": "Verify",
            "role": "button",
            "testId": "verify-button"
          }
        }),
      ],
    )
  ),
  ],
);
