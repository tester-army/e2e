// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {"id":"9629cfc37e42a533b674ad764e7d5f4b8e578f5d51ad4ae8282eedfd7369d049","testId":"tests-agent/scenarios.e2e.ts::act%20completes%20Gestures"},
  [
  replay.step(
    {
      "key": "c0d68bc778f40b67bf2783588be85c1605082e05990a15b7ea413123b981f08d",
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
    )
  ),
  replay.step(
    {
      "key": "c31dbe874e4e3538e48ba58a9bdde56e1c371bdc46f9c1398f3fb3bfdd496453",
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
    )
  ),
  ],
);
