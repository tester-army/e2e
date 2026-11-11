// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
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
);
