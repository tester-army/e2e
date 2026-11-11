// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "All gestures completed",
        "role": "text",
        "testId": "success-message"
      }
    ],
    "endPath": "dev.e2e.benchmark",
    "endWaitMs": 15925,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "Step 1 of 3",
        "role": "text"
      },
      {
        "name": "Hold me",
        "role": "text"
      },
      {
        "name": "Hold me",
        "role": "group",
        "testId": "long-press-target"
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
      "instructionDigest": "548193505ec38bc1149592fdc74a267de461a8b29e29f4e7a168b20807a81a11",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "android-emulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Gestures"
    },
    "startPath": "dev.e2e.benchmark",
    "summary": "Long-pressed the first target, swiped the card left, and double-tapped the last target. The screen confirms “All gestures completed.”"
  },
  [
    replay.longPress({
      "summary": "long-press group \"Hold me\" in \"Step 1 of 3\"",
      "target": {
        "name": "Hold me",
        "role": "group",
        "selector": "id=long-press-target",
        "testId": "long-press-target",
        "within": "Step 1 of 3"
      }
    }),
    replay.tool({
      "summary": "tool swipe"
    }),
    replay.tool({
      "summary": "tool swipe"
    }),
    replay.doubleTap({
      "summary": "double-tap group \"Double-tap me\" in \"Step 3 of 3\"",
      "target": {
        "name": "Double-tap me",
        "role": "group",
        "selector": "id=double-tap-target",
        "testId": "double-tap-target",
        "within": "Step 3 of 3"
      }
    }),
  ],
);
