// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
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
);
