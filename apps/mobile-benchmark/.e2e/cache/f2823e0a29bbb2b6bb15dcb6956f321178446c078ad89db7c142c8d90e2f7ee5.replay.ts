// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {
    "id": "f2823e0a29bbb2b6bb15dcb6956f321178446c078ad89db7c142c8d90e2f7ee5",
    "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Broken%20Accessibility"
  },
  [
    replay.step(
      {
        "key": "286f4c460f10ea043ed72d4b4109e071dc9aebcbb0ea9c48933e60a0649f6e16",
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
              "name": "Access granted",
              "role": "text"
            }
          ],
          "endPath": "dev.e2e.benchmark",
          "endWaitMs": 14422,
          "executor": {
            "name": "e2e-default-agent",
            "version": "2"
          },
          "goneAnchors": [
            {
              "name": "Tap the green circle to continue",
              "role": "text"
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
            "instructionDigest": "39a6071dd8e903747ecddcc20ac06b4c62c7e399b90ef1a0c2e79a3bcb5c4e92",
            "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            "targetId": "android-emulator",
            "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Broken%20Accessibility"
          },
          "startPath": "dev.e2e.benchmark",
          "summary": "Tapped the green circle, entered code 7291, and pressed the arrow. The screen now displays “Access granted.”"
        },
        [
          replay.tapAt({
            "point": {
              "x": 637,
              "y": 1389
            },
            "summary": "tap the point (637, 1389) on group",
            "viewport": {
              "height": 2400,
              "width": 1080
            }
          }),
          replay.tool({
            "derived": "pixels",
            "summary": "tool type (run-time value)"
          }),
          replay.tap({
            "summary": "tap group \"→\" in \"Enter the code 7291 and press the arrow\"",
            "target": {
              "name": "→",
              "role": "group",
              "within": "Enter the code 7291 and press the arrow"
            }
          }),
        ],
      ),
    ),
    replay.step(
      {
        "key": "cb2bc9d1e809fa5cf3823e7df21dc826a605c2192f8e2e5d2ceaa563cbde4236",
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
              "name": "Access granted",
              "role": "other"
            }
          ],
          "endPath": "dev.e2e.benchmark / Broken Accessibility",
          "endWaitMs": 15797,
          "executor": {
            "name": "e2e-default-agent",
            "version": "2"
          },
          "goneAnchors": [
            {
              "name": "Tap the green circle to continue",
              "role": "other"
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
            "instructionDigest": "39a6071dd8e903747ecddcc20ac06b4c62c7e399b90ef1a0c2e79a3bcb5c4e92",
            "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            "targetId": "ios-simulator",
            "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Broken%20Accessibility"
          },
          "startPath": "dev.e2e.benchmark / Broken Accessibility",
          "summary": "Entered code 7291 and pressed the green arrow. The screen now displays “Access granted.”"
        },
        [
          replay.tapAt({
            "point": {
              "x": 237,
              "y": 514
            },
            "summary": "tap the point (237, 514) on other \"Tap the green circle to continue\"",
            "viewport": {
              "height": 874,
              "width": 402
            },
            "within": {
              "fx": 0.5896,
              "fy": 0.5251,
              "target": {
                "name": "Tap the green circle to continue",
                "role": "other"
              }
            }
          }),
          replay.tapAt({
            "point": {
              "x": 165,
              "y": 514
            },
            "summary": "tap the point (165, 514) on other \"Enter the code 7291 and press the arrow…\"",
            "viewport": {
              "height": 874,
              "width": 402
            },
            "within": {
              "fx": 0.4104,
              "fy": 0.5251,
              "target": {
                "name": "Enter the code 7291 and press the arrow, →",
                "role": "other"
              }
            }
          }),
          replay.tool({
            "derived": "pixels",
            "summary": "tool type (run-time value)"
          }),
          replay.tapAt({
            "point": {
              "x": 268,
              "y": 512
            },
            "summary": "tap the point (268, 512) on other \"Enter the code 7291 and press the arrow…\"",
            "viewport": {
              "height": 874,
              "width": 402
            },
            "within": {
              "fx": 0.6667,
              "fy": 0.5224,
              "target": {
                "name": "Enter the code 7291 and press the arrow, →",
                "role": "other"
              }
            }
          }),
        ],
      ),
    ),
  ],
);
