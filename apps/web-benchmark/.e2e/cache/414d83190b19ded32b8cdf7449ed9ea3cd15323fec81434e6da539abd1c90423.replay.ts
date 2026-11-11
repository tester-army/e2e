// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Hold state",
        "role": "status",
        "text": "long-pressed"
      },
      {
        "name": "Double-click state",
        "role": "status",
        "text": "double-clicked"
      }
    ],
    "endPath": "/e/control-inventory",
    "endWaitMs": 11370,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "Hold state",
        "role": "status",
        "text": "none"
      },
      {
        "name": "Double-click state",
        "role": "status",
        "text": "none"
      }
    ],
    "recordedFor": {
      "agent": "default",
      "callIndex": 0,
      "instructionDigest": "9fe8b7fcfeb1bd36e8d003d5c7e5feb16042211ec61970b63314a6c7bac345b0",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "web",
      "testId": "tests-agent/control-inventory.e2e.ts::control%20inventory::a%20long%20press%20and%20a%20double%20click%20are%20chosen%20over%20a%20plain%20tap"
    },
    "startPath": "/e/control-inventory",
    "summary": "Long-pressed Hold me; Hold state reads “long-pressed.” Double-clicked Double-click me; Double-click state reads “double-clicked.”"
  },
  [
    replay.longPress({
      "summary": "long-press button \"Hold me\" in \"Gestures\"",
      "target": {
        "name": "Hold me",
        "role": "button",
        "within": "Gestures"
      }
    }),
    replay.doubleTap({
      "summary": "double-tap button \"Double-click me\" in \"Gestures\"",
      "target": {
        "name": "Double-click me",
        "role": "button",
        "within": "Gestures"
      }
    }),
  ],
);
