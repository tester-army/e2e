// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {
    "id": "d68c4ef7c21412cf9ae24bd2bc1eb9022e1e571b8dec9a7d4119efd4ce5bb99f",
    "testId": "tests-agent/control-inventory.e2e.ts::control%20inventory::check%20picks%20a%20radio%20the%20pick%20replaces%20with%20its%20summary"
  },
  [
    replay.step(
      {
        "key": "5577eea54bd7879a1e6a701aa9b793ac228ac95d033923df09b6e9732e99bd21",
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
              "name": "Delivery state",
              "role": "status",
              "text": "Express"
            },
            {
              "text": "Express delivery selected"
            },
            {
              "name": "Change delivery",
              "role": "button"
            }
          ],
          "endPath": "/e/control-inventory",
          "endWaitMs": 11721,
          "executor": {
            "name": "e2e-default-agent",
            "version": "2"
          },
          "goneAnchors": [
            {
              "name": "Delivery state",
              "role": "status",
              "text": "unset"
            },
            {
              "name": "Standard",
              "role": "radio"
            },
            {
              "name": "Express",
              "role": "radio"
            },
            {
              "name": "Delivery",
              "role": "group"
            },
            {
              "text": "Standard"
            }
          ],
          "recordedFor": {
            "agent": "default",
            "callIndex": 0,
            "instructionDigest": "df853ab2fc826564b99c9b044a65fd7ee21cdc2b487273cebcd32bcbe3607c66",
            "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            "targetId": "web",
            "testId": "tests-agent/control-inventory.e2e.ts::control%20inventory::check%20picks%20a%20radio%20the%20pick%20replaces%20with%20its%20summary"
          },
          "startPath": "/e/control-inventory",
          "summary": "Selected Express delivery; the delivery state now reads “Express” and the page confirms “Express delivery selected.”"
        },
        [
          replay.tap({
            "summary": "tap radio \"Express\" in \"Delivery\"",
            "target": {
              "name": "Express",
              "role": "radio",
              "within": "Delivery"
            }
          }),
        ],
      ),
    ),
  ],
);
