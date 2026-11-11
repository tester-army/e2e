// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {"id":"ee9a83515f8e7d79d8645132f3c3700a14a1f9b2100643f002639b4405cb9d94","testId":"tests-agent/control-inventory.e2e.ts::control%20inventory::upload%20attaches%20the%20named%20project%20files"},
  [
  replay.step(
    {
      "key": "5e8767c8a91f29efad8ef0db0f28a2dcc434bef3a18e95faa2e3cb5b166a982e",
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
            "name": "Attachments state",
            "role": "status",
            "text": "attachment.txt, second.txt"
          },
          {
            "name": "Attachments",
            "role": "button",
            "value": "C:\\fakepath\\attachment.txt"
          }
        ],
        "endPath": "/e/control-inventory",
        "endWaitMs": 12311,
        "executor": {
          "name": "e2e-default-agent",
          "version": "2"
        },
        "goneAnchors": [
          {
            "name": "Attachments state",
            "role": "status",
            "text": "none"
          },
          {
            "name": "Attachments",
            "role": "button"
          }
        ],
        "recordedFor": {
          "agent": "default",
          "callIndex": 0,
          "instructionDigest": "6eb8c4cb34d6623811808727d85db0d55946be5724f0cdc01b3c633db3d6f44d",
          "paramsDigest": "38fc51716f1b76431a49c2fd70d8a6d11405fa9b9451a1d96cb9e357e70321ce",
          "targetId": "web",
          "testId": "tests-agent/control-inventory.e2e.ts::control%20inventory::upload%20attaches%20the%20named%20project%20files"
        },
        "startPath": "/e/control-inventory",
        "summary": "Attached both fixtures/attachment.txt and fixtures/second.txt to the Attachments input. The state now shows “attachment.txt, second.txt” and the control indicates 2 files."
      },
      [
        replay.tap({
          "summary": "tap button \"Attachments\" in \"Files\"",
          "target": {
            "name": "Attachments",
            "role": "button",
            "within": "Files"
          }
        }),
        replay.upload({
          "paths": [
            "fixtures/attachment.txt",
            "fixtures/second.txt"
          ],
          "summary": "upload \"fixtures/attachment.txt\", \"fixtures/second.txt\" to button \"Attachments\" in \"Files\"",
          "target": {
            "name": "Attachments",
            "role": "button",
            "within": "Files"
          }
        }),
      ],
    )
  ),
  ],
);
