// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {
    "id": "07b4d7e9bd3b15f44051f1e387b5afcf6e7534ebc17d317fc7d11903eaebc3d6",
    "testId": "tests-agent/control-inventory.e2e.ts::control%20inventory::back%20returns%20from%20the%20details%20view%20to%20the%20inventory"
  },
  [
    replay.step(
      {
        "key": "d2a64638fa64821ffadb8a50d092e13ee89722c9ce06b9ae34628d827a9f37df",
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
              "name": "Navigation state",
              "role": "status",
              "text": "back on the inventory"
            }
          ],
          "endPath": "/e/control-inventory",
          "endWaitMs": 12570,
          "executor": {
            "name": "e2e-default-agent",
            "version": "2"
          },
          "goneAnchors": [
            {
              "name": "Navigation state",
              "role": "status",
              "text": "not opened"
            }
          ],
          "recordedFor": {
            "agent": "default",
            "callIndex": 0,
            "instructionDigest": "b654f62f1b06969b737e6bc5900524da39b012965a0d82aef45fce7af099ba6c",
            "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            "targetId": "web",
            "testId": "tests-agent/control-inventory.e2e.ts::control%20inventory::back%20returns%20from%20the%20details%20view%20to%20the%20inventory"
          },
          "startPath": "/e/control-inventory",
          "summary": "Opened Details, then used browser history to return to /e/control-inventory. The Navigation state now reads “back on the inventory.”"
        },
        [
          replay.tap({
            "summary": "tap button \"Open details\" in \"Navigation\"",
            "target": {
              "name": "Open details",
              "role": "button",
              "within": "Navigation"
            }
          }),
          replay.back({
            "summary": "navigate back"
          }),
        ],
      ),
    ),
  ],
);
