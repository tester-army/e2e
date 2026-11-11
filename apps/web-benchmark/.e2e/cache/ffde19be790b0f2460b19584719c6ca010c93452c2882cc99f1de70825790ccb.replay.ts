// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "testId": "success-message",
        "text": "Payment sent"
      }
    ],
    "endPath": "/e/lying-labels",
    "endWaitMs": 11896,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "text": "Click the button that visibly says Pay now."
      },
      {
        "text": "Do not press this button"
      },
      {
        "text": "Pay now safely"
      },
      {
        "name": "Confirm payment",
        "role": "button",
        "text": "Contact support"
      },
      {
        "name": "Cancel order",
        "role": "button",
        "text": "Pay now"
      },
      {
        "name": "Pay now",
        "role": "button",
        "text": "Cancel order"
      }
    ],
    "recordedFor": {
      "agent": "default",
      "callIndex": 0,
      "instructionDigest": "75cac33ad209d332c191820f8b966e11e3b86f06d25432d913adf93fe369052d",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "web",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20lying-labels"
    },
    "startPath": "/e/lying-labels",
    "summary": "Followed the visible labels and page instructions: entered 42.50 in the field beside “Amount,” left the visibly labeled Reference field empty, and submitted. The page now shows “Payment sent.”"
  },
  [
    replay.tap({
      "summary": "tap button \"Cancel order\"",
      "target": {
        "name": "Cancel order",
        "role": "button",
        "text": "Pay now"
      }
    }),
    replay.tool({
      "derived": "minted-token",
      "summary": "tool type (run-time value)"
    }),
    replay.tap({
      "summary": "tap button \"Discard draft\"",
      "target": {
        "name": "Discard draft",
        "role": "button",
        "text": "Submit payment"
      }
    }),
  ],
);
