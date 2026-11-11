// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
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
);
