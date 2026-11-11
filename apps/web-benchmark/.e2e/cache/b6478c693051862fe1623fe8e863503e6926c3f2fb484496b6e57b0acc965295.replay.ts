// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {"id":"b6478c693051862fe1623fe8e863503e6926c3f2fb484496b6e57b0acc965295","testId":"tests-agent/control-inventory.e2e.ts::control%20inventory::a%20long%20press%20and%20a%20double%20click%20are%20chosen%20over%20a%20plain%20tap"},
  [
  replay.step(
    {
      "key": "414d83190b19ded32b8cdf7449ed9ea3cd15323fec81434e6da539abd1c90423",
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
    )
  ),
  ],
);
