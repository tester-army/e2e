// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
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
);
