// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "testId": "success-message",
        "text": "Terms accepted"
      }
    ],
    "endPath": "/e/sticky-chrome",
    "endWaitMs": 11764,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "recordedFor": {
      "agent": "default",
      "callIndex": 0,
      "instructionDigest": "507883318a8655d47afe9f680ee91cde1ae64055fbef530129cc289101a30c23",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "web",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20sticky-chrome"
    },
    "startPath": "/e/sticky-chrome",
    "summary": "Scrolled until the Accept terms button was clear above the sticky footer, clicked it once, and verified the “Terms accepted” confirmation."
  },
  [
    replay.scrollTo({
      "summary": "scroll button \"Accept terms\" into view",
      "target": {
        "name": "Accept terms",
        "role": "button",
        "testId": "accept-button"
      }
    }),
    replay.tap({
      "summary": "tap button \"Accept terms\"",
      "target": {
        "name": "Accept terms",
        "role": "button",
        "testId": "accept-button"
      }
    }),
  ],
);
