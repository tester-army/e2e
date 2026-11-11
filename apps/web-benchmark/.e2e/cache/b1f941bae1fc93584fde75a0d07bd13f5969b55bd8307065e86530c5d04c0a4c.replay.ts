// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {
    "id": "b1f941bae1fc93584fde75a0d07bd13f5969b55bd8307065e86530c5d04c0a4c",
    "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20drag-and-drop"
  },
  [
    replay.step(
      {
        "key": "877837d0e2e667a1fd7572198f4d21118ce02703794a701f6fe93744d9e395ea",
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
              "text": "Items dropped in the right order"
            }
          ],
          "endPath": "/e/drag-and-drop",
          "endWaitMs": 11777,
          "executor": {
            "name": "e2e-default-agent",
            "version": "2"
          },
          "goneAnchors": [
            {
              "text": "Drop items here"
            }
          ],
          "recordedFor": {
            "agent": "default",
            "callIndex": 0,
            "instructionDigest": "24ea40459eba1c0e7841d174c9d6b29255cc71346083add2a38c39491aff758c",
            "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            "targetId": "web",
            "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20drag-and-drop"
          },
          "startPath": "/e/drag-and-drop",
          "summary": "Dragged Banana and then Cherry into the dropzone, leaving Apple alone. The page displays “Items dropped in the right order.”"
        },
        [
          replay.drag({
            "destination": {
              "testId": "dropzone"
            },
            "summary": "drag node \"Banana\" to node \"dropzone\"",
            "target": {
              "testId": "drag-banana",
              "text": "Banana"
            }
          }),
          replay.drag({
            "destination": {
              "testId": "dropzone"
            },
            "summary": "drag node \"Cherry\" to node \"dropzone\"",
            "target": {
              "testId": "drag-cherry",
              "text": "Cherry"
            }
          }),
        ],
      ),
    ),
  ],
);
