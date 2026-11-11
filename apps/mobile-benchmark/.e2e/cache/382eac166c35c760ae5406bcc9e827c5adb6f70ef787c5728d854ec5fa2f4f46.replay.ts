// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {
    "id": "382eac166c35c760ae5406bcc9e827c5adb6f70ef787c5728d854ec5fa2f4f46",
    "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20WebView%20Accessibility"
  },
  [
    replay.step(
      {
        "key": "f1e5741e33d85e38f0c7c883c04eca28c63045d028f353a812a2e83783a291ce",
        "order": 0,
        "variant": {
          "agent": "37a8eec1ce19687d132fe29051dca629d164e2c4958ba141d5f4133a33f0688f",
          "project": "5db668e539f1f8a455eaa798ab239f0cfdc68c99776863db1ddd6f27a9fba643",
          "target": "a34152a60079722a259a417c0251ad71bf53cd3ef002e7f6c1e465dad98bee2b"
        }
      },
      replay.define(
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
      ),
    ),
    replay.step(
      {
        "key": "ccabb55841076f013cc3014d25e96722580d13ec6b696e6161ff64d113e9be1f",
        "order": 0,
        "variant": {
          "agent": "37a8eec1ce19687d132fe29051dca629d164e2c4958ba141d5f4133a33f0688f",
          "project": "5db668e539f1f8a455eaa798ab239f0cfdc68c99776863db1ddd6f27a9fba643",
          "target": "d34e594487171911acb852c9c20a9b1e42d960b2c08aeb43fe1145049c6f1eed"
        }
      },
      replay.define(
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
      ),
    ),
  ],
);
