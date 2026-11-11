// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Coupon code",
        "role": "textbox",
        "value": "TA-BENCH-50"
      },
      {
        "name": "I accept the terms",
        "role": "switch",
        "states": [
          "checked"
        ],
        "value": "1"
      },
      {
        "name": "Vertical scroll bar, 2 pages",
        "role": "other",
        "value": "0%"
      },
      {
        "name": "Coupon applied",
        "role": "other"
      },
      {
        "name": "Coupon applied",
        "role": "text",
        "testId": "success-message"
      },
      {
        "name": "Vertical scroll bar, 2 pages",
        "role": "other",
        "testId": "coupon-webview"
      },
      {
        "name": "Vertical scroll bar, 2 pages",
        "role": "web-view"
      }
    ],
    "endPath": "dev.e2e.benchmark / WebView Accessibility",
    "endWaitMs": 12286,
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
        "name": "Coupon code",
        "role": "textbox"
      },
      {
        "name": "I accept the terms",
        "role": "switch",
        "value": "0"
      },
      {
        "name": "Vertical scroll bar, 1 page",
        "role": "other",
        "value": "0%"
      },
      {
        "name": "Apply the coupon shown inside the web page (accept the terms first)",
        "role": "other"
      },
      {
        "name": "Vertical scroll bar, 1 page",
        "role": "other",
        "testId": "coupon-webview"
      },
      {
        "name": "Vertical scroll bar, 1 page",
        "role": "web-view"
      }
    ],
    "keyedBy": {
      "agentContextDigest": "9851c2b004c95e29037ba508c9a81e7efff8fcaa01e5491077154e702520281a",
      "appIdentity": "873e96a3c0364ffd8e603a0fb9ccef7bb32dd2c64eb8bddaa76d36fdfbf446ae",
      "cacheSchema": "trace-1",
      "engineName": "mobile",
      "engineSpiVersion": 1,
      "platform": "ios",
      "policyVersion": "conservative/6",
      "project": "5db668e539f1f8a455eaa798ab239f0cfdc68c99776863db1ddd6f27a9fba643"
    },
    "recordedFor": {
      "agent": "default",
      "callIndex": 0,
      "instructionDigest": "60e9576a643a70f4d33968ccc19d845112ca2ed50212584e9e7aadc34707e5c8",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "ios-simulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20WebView%20Accessibility"
    },
    "startPath": "dev.e2e.benchmark / WebView Accessibility",
    "summary": "Read coupon code TA-BENCH-50, entered it, accepted the terms, and applied it. The web view now displays “Coupon applied.”"
  },
  [
    replay.type({
      "summary": "type \"TA-BENCH-50\" into textbox \"Coupon code\"",
      "target": {
        "name": "Coupon code",
        "role": "textbox"
      },
      "value": "TA-BENCH-50"
    }),
    replay.check({
      "checked": true,
      "summary": "check switch \"I accept the terms\"",
      "target": {
        "name": "I accept the terms",
        "role": "switch"
      }
    }),
    replay.tap({
      "summary": "tap button \"Apply coupon\"",
      "target": {
        "name": "Apply coupon",
        "role": "button"
      }
    }),
  ],
);
