// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
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
);
