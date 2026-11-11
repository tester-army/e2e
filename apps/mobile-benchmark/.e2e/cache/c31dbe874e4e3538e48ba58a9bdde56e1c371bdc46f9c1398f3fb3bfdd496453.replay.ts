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
    "endPath": "dev.e2e.benchmark / Gestures",
    "endWaitMs": 13065,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "Hold me",
        "role": "other",
        "testId": "long-press-target"
      },
      {
        "name": "Step 1 of 3",
        "role": "text"
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
    "recordedBy": {
      "model": "openai/gpt-6-luna-fast",
      "provider": "gateway"
    },
    "recordedFor": {
      "agent": "default",
      "callIndex": 0,
      "instructionDigest": "548193505ec38bc1149592fdc74a267de461a8b29e29f4e7a168b20807a81a11",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "ios-simulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Gestures"
    },
    "startPath": "dev.e2e.benchmark / Gestures",
    "summary": "Completed the long-press and left-swipe actions, then double-tapped the final target. The screen now confirms “All gestures completed.”"
  },
  [
    replay.longPress({
      "summary": "long-press other \"Hold me\"",
      "target": {
        "name": "Hold me",
        "role": "other",
        "selector": "id=long-press-target",
        "testId": "long-press-target"
      }
    }),
    replay.tool({
      "summary": "tool swipe"
    }),
    replay.tool({
      "summary": "tool swipe"
    }),
    replay.tool({
      "summary": "tool swipe"
    }),
    replay.doubleTap({
      "summary": "double-tap other \"Double-tap me\"",
      "target": {
        "name": "Double-tap me",
        "role": "other",
        "selector": "id=double-tap-target",
        "testId": "double-tap-target"
      }
    }),
    replay.doubleTap({
      "summary": "double-tap other \"Double-tap me\"",
      "target": {
        "name": "Double-tap me",
        "role": "other",
        "selector": "id=double-tap-target",
        "testId": "double-tap-target"
      }
    }),
  ],
);
