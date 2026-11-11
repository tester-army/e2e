// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "testId": "success-message",
        "text": "Access granted"
      }
    ],
    "endPath": "/e/shadow-dom-form",
    "endWaitMs": 11646,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "text": "The form below lives inside a closed shadow root. Enter SHADOW-42 and press Submit."
      },
      {
        "text": "Access code hint: SHADOW-42"
      },
      {
        "name": "Access code",
        "placeholder": "Access code",
        "role": "textbox"
      },
      {
        "name": "Submit",
        "role": "button"
      }
    ],
    "recordedFor": {
      "agent": "default",
      "callIndex": 0,
      "instructionDigest": "c6884af43cef64f928cde4eaa3be0cbc128893f01611d32236baf514a915c0a6",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "web",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20shadow-dom-form"
    },
    "startPath": "/e/shadow-dom-form",
    "summary": "Entered SHADOW-42 and submitted the form. The page now shows “Access granted.”"
  },
  [
    replay.tool({
      "derived": "minted-token",
      "summary": "tool type (run-time value)"
    }),
    replay.tap({
      "summary": "tap button \"Submit\"",
      "target": {
        "name": "Submit",
        "role": "button"
      }
    }),
  ],
);
