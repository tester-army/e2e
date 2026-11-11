// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Toggles state",
        "role": "status",
        "text": "terms agreed, size Medium"
      },
      {
        "name": "Agree to terms",
        "role": "checkbox",
        "states": [
          "checked"
        ]
      },
      {
        "name": "Medium",
        "role": "radio",
        "states": [
          "checked"
        ]
      }
    ],
    "endPath": "/e/control-inventory",
    "endWaitMs": 11356,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "Toggles state",
        "role": "status",
        "text": "terms not agreed, size unset"
      },
      {
        "name": "Agree to terms",
        "role": "checkbox"
      },
      {
        "name": "Medium",
        "role": "radio"
      }
    ],
    "recordedFor": {
      "agent": "default",
      "callIndex": 0,
      "instructionDigest": "31e69bd3b8b58acb08fa60eaea2976e3271b633b840b8ffca9440e21488961fc",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "web",
      "testId": "tests-agent/control-inventory.e2e.ts::control%20inventory::check%20sets%20the%20checkbox%20and%20the%20radio"
    },
    "startPath": "/e/control-inventory",
    "summary": "Agreed to the terms and selected Medium. The Toggles state confirms “terms agreed, size Medium.”"
  },
  [
    replay.check({
      "checked": true,
      "summary": "check checkbox \"Agree to terms\" in \"Toggles\"",
      "target": {
        "name": "Agree to terms",
        "role": "checkbox",
        "within": "Toggles"
      }
    }),
    replay.check({
      "checked": true,
      "summary": "check radio \"Medium\" in \"Size\"",
      "target": {
        "name": "Medium",
        "role": "radio",
        "within": "Size"
      }
    }),
  ],
);
