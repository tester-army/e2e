// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
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
);
