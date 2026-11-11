// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {
    "id": "8b515b9fdfa865d2e0e11248281c9fbf5eabfeaa7cdfa2ccf99d8765f860c216",
    "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20virtualized-table"
  },
  [
    replay.step(
      {
        "key": "ab82f44f8dd2d4e8af4f76d0ac9d147e010ba0949f734270332fa8c889789108",
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
              "text": "Golden Row claimed"
            },
            {
              "text": "Row 4306"
            },
            {
              "text": "Row 4307"
            },
            {
              "text": "Row 4308"
            },
            {
              "text": "Row 4309"
            },
            {
              "text": "Row 4310"
            },
            {
              "text": "Row 4311"
            },
            {
              "text": "Row 4312"
            }
          ],
          "endPath": "/e/virtualized-table",
          "endWaitMs": 11397,
          "executor": {
            "name": "e2e-default-agent",
            "version": "2"
          },
          "goneAnchors": [
            {
              "text": "Row 1"
            },
            {
              "text": "Row 2"
            },
            {
              "text": "Row 3"
            },
            {
              "text": "Row 4"
            },
            {
              "text": "Row 5"
            },
            {
              "text": "Row 6"
            },
            {
              "text": "Row 7"
            },
            {
              "text": "Row 8"
            }
          ],
          "recordedFor": {
            "agent": "default",
            "callIndex": 0,
            "instructionDigest": "3e0bdeec3c893eadd972848c89ef841ec7722fd896ed12998ef945cf20af30ec",
            "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            "targetId": "web",
            "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20virtualized-table"
          },
          "startPath": "/e/virtualized-table",
          "summary": "Scrolled the windowed table until Row 4322 — Golden Row was rendered, clicked Claim, and verified the “Golden Row claimed” success message."
        },
        [
          replay.scrollUntil({
            "direction": "down",
            "spans": 0.3083,
            "summary": "scroll down on node \"table-viewport\" until \"Row 4322\" shows (431 screens)",
            "target": {
              "testId": "table-viewport"
            },
            "text": "Row 4322"
          }),
          replay.tap({
            "summary": "tap button \"Claim\"",
            "target": {
              "name": "Claim",
              "role": "button",
              "testId": "claim-button"
            }
          }),
        ],
      ),
    ),
  ],
);
