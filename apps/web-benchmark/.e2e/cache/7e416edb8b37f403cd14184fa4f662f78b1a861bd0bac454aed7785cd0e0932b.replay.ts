// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "testId": "success-message",
        "text": "Coupon applied"
      }
    ],
    "endPath": "/e/iframe-form",
    "endWaitMs": 11742,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "text": "Read the coupon code from the first frame and apply it in the second."
      },
      {
        "text": "SAVE-1234"
      },
      {
        "text": "Apply your coupon at checkout"
      },
      {
        "name": "Coupon code",
        "placeholder": "Coupon code",
        "role": "textbox"
      },
      {
        "name": "Apply",
        "role": "button"
      },
      {
        "name": "coupon-frame",
        "role": "iframe"
      },
      {
        "text": "Your coupon code:"
      },
      {
        "name": "checkout-frame",
        "role": "iframe"
      }
    ],
    "recordedFor": {
      "agent": "default",
      "callIndex": 0,
      "instructionDigest": "5ea16155d5cd3ee4fc67e7511534964bca91116fa0412e4523428844f9f85c15",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "web",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20iframe-form"
    },
    "startPath": "/e/iframe-form",
    "summary": "Read coupon SAVE-1234 from the first frame, entered it in the checkout form, and applied it. The page now shows “Coupon applied.”"
  },
  [
    replay.tool({
      "derived": "whole-node",
      "summary": "tool type (run-time value)"
    }),
    replay.tap({
      "summary": "tap button \"Apply\"",
      "target": {
        "name": "Apply",
        "role": "button"
      }
    }),
  ],
);
