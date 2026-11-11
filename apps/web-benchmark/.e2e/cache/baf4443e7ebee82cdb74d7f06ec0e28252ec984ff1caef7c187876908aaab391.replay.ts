// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {
    "id": "baf4443e7ebee82cdb74d7f06ec0e28252ec984ff1caef7c187876908aaab391",
    "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20iframe-form"
  },
  [
    replay.step(
      {
        "key": "7e416edb8b37f403cd14184fa4f662f78b1a861bd0bac454aed7785cd0e0932b",
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
      ),
    ),
  ],
);
