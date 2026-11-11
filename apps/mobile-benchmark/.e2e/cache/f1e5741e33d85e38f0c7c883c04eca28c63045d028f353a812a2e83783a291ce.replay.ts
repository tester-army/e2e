// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Coupon applied",
        "role": "text",
        "testId": "success-message"
      },
      {
        "name": "TA-BENCH-50",
        "placeholder": "Coupon code",
        "role": "textbox",
        "testId": "coupon-input",
        "value": "TA-BENCH-50"
      }
    ],
    "endPath": "dev.e2e.benchmark",
    "endWaitMs": 13288,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "Apply the coupon shown inside the web page (accept the terms first)",
        "role": "text"
      },
      {
        "placeholder": "Coupon code",
        "role": "textbox",
        "testId": "coupon-input"
      }
    ],
    "keyedBy": {
      "agentContextDigest": "9851c2b004c95e29037ba508c9a81e7efff8fcaa01e5491077154e702520281a",
      "appIdentity": "e18e9835187bab993e11f2dd7ff5624429bc26890c846accacf0057b525e92a0",
      "cacheSchema": "trace-1",
      "engineName": "mobile",
      "engineSpiVersion": 1,
      "platform": "android",
      "policyVersion": "conservative/6",
      "project": "5db668e539f1f8a455eaa798ab239f0cfdc68c99776863db1ddd6f27a9fba643"
    },
    "recordedFor": {
      "agent": "default",
      "callIndex": 0,
      "instructionDigest": "60e9576a643a70f4d33968ccc19d845112ca2ed50212584e9e7aadc34707e5c8",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "android-emulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20WebView%20Accessibility"
    },
    "startPath": "dev.e2e.benchmark",
    "summary": "Read coupon code TA-BENCH-50, entered it, accepted the terms, and applied it. The web view displays “Coupon applied.”"
  },
  [
    replay.tool({
      "derived": "whole-node",
      "summary": "tool type (run-time value)"
    }),
    replay.tap({
      "summary": "tap checkbox \"I accept the terms\"",
      "target": {
        "name": "I accept the terms",
        "role": "checkbox",
        "selector": "id=terms",
        "testId": "terms"
      }
    }),
    replay.tap({
      "summary": "tap button \"Apply coupon\" in \"Checkout coupon\"",
      "target": {
        "name": "Apply coupon",
        "role": "button",
        "selector": "id=apply",
        "testId": "apply",
        "within": "Checkout coupon"
      }
    }),
  ],
);
