// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {"id":"df7db32fffb961b1f5a804fcc0cebbb3fcc6eaa73957e84de7c0048c92e02cd5","testId":"tests-agent/control-inventory.e2e.ts::control%20inventory::check%20sets%20the%20checkbox%20and%20the%20radio"},
  [
  replay.step(
    {
      "key": "1f2ad4f61f8c80341b1a181b5f505c12fb2e7562c4c888ec21d4d3edf90d3a50",
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
    )
  ),
  ],
);
