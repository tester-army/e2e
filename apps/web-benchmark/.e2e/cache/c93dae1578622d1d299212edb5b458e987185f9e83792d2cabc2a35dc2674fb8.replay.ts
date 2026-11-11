// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "testId": "success-message",
        "text": "Order confirmed"
      },
      {
        "text": "Jonas ★★★★★ Great bass and the battery lasts all week."
      },
      {
        "text": "Amelia ★★★★ Comfortable fit, pairing was instant."
      },
      {
        "name": "Wireless Headphones $80.00 $40.00 50% OFF Order confirmed",
        "role": "listitem",
        "testId": "deal-headphones"
      }
    ],
    "endPath": "/e/promo-storefront",
    "endWaitMs": 25883,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "Wireless Headphones $80.00 $40.00 50% OFF Buy now",
        "role": "listitem",
        "testId": "deal-headphones"
      }
    ],
    "recordedFor": {
      "agent": "default",
      "callIndex": 0,
      "instructionDigest": "1bf3aabb828b9b084d447df3a78d1fa700b5b28b8d5847dcc5ffcb9b0ce3bd45",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "web",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20promo-storefront"
    },
    "startPath": "/e/promo-storefront",
    "summary": "The current screen shows Wireless Headphones with an “Order confirmed” success message, so the recorded purchase took effect."
  },
  [
    replay.tap({
      "summary": "tap button \"Buy now\" in \"Wireless Headphones\"",
      "target": {
        "name": "Buy now",
        "role": "button",
        "testId": "buy-headphones",
        "within": "Wireless Headphones"
      }
    }),
  ],
);
