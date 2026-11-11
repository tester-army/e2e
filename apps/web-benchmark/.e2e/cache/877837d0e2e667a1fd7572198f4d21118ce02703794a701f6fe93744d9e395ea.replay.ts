// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
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
);
