// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Sequence complete",
        "role": "text"
      }
    ],
    "endPath": "dev.e2e.benchmark",
    "endWaitMs": 14472,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "Tap: square, then circle, then diamond",
        "role": "text"
      },
      {
        "name": "Progress: 0/3",
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
      "instructionDigest": "e950bf904a3587f9a1d42a4dc15c29517000d20a1e31c8bd896e96a9c6ebd6d1",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "android-emulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Vision%20Only"
    },
    "startPath": "dev.e2e.benchmark",
    "summary": "Tapped the square, circle, and diamond in the instructed order. The screen now displays “Sequence complete.”"
  },
  [
    replay.tapAt({
      "point": {
        "x": 749,
        "y": 1458
      },
      "summary": "tap the point (749, 1458) on group",
      "viewport": {
        "height": 2400,
        "width": 1080
      }
    }),
    replay.tapAt({
      "point": {
        "x": 331,
        "y": 1458
      },
      "summary": "tap the point (331, 1458) on group",
      "viewport": {
        "height": 2400,
        "width": 1080
      }
    }),
    replay.tapAt({
      "point": {
        "x": 540,
        "y": 1458
      },
      "summary": "tap the point (540, 1458) on group",
      "viewport": {
        "height": 2400,
        "width": 1080
      }
    }),
  ],
);
