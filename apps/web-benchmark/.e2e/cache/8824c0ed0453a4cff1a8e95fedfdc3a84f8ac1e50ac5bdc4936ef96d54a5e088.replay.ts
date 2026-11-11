// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
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
);
