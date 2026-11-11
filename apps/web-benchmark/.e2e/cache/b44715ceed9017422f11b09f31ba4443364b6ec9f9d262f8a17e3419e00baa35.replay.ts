// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {"id":"b44715ceed9017422f11b09f31ba4443364b6ec9f9d262f8a17e3419e00baa35","testId":"tests-agent/scenarios.e2e.ts::act%20completes%20shadow-dom-form"},
  [
  replay.step(
    {
      "key": "817b52b90ccbfe4f0729b05f3880fc31a1d1ef82427b4c51a03b64e6762268ab",
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
    )
  ),
  ],
);
