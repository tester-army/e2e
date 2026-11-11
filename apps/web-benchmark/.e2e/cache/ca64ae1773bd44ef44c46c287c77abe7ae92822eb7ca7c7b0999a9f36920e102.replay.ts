// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {
    "id": "ca64ae1773bd44ef44c46c287c77abe7ae92822eb7ca7c7b0999a9f36920e102",
    "testId": "tests-agent/control-inventory.e2e.ts::control%20inventory::scroll_to%20brings%20the%20footnote%20into%20view"
  },
  [
    replay.step(
      {
        "key": "4c6e069d9f354e6876a2fbe8a2edf3efc95013dca6fd5b64682b742cbd8bde77",
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
              "name": "Footnote state",
              "role": "status",
              "text": "in view"
            }
          ],
          "endPath": "/e/control-inventory",
          "endWaitMs": 11385,
          "executor": {
            "name": "e2e-default-agent",
            "version": "2"
          },
          "goneAnchors": [
            {
              "name": "Footnote state",
              "role": "status",
              "text": "out of view"
            }
          ],
          "recordedFor": {
            "agent": "default",
            "callIndex": 0,
            "instructionDigest": "60d7d1c1109f3844ed7b5cd3f6f351e1b297af10aa7e4371ed45de087cce0df3",
            "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            "targetId": "web",
            "testId": "tests-agent/control-inventory.e2e.ts::control%20inventory::scroll_to%20brings%20the%20footnote%20into%20view"
          },
          "startPath": "/e/control-inventory",
          "summary": "Scrolled the page until the Footnote paragraph was in view; the Footnote state now reads “in view”."
        },
        [
          replay.scrollTo({
            "summary": "scroll node \"Footnote\" into view",
            "target": {
              "text": "Footnote"
            }
          }),
        ],
      ),
    ),
  ],
);
