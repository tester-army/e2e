// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Reward claimed",
        "role": "text",
        "testId": "success-message"
      },
      {
        "role": "group",
        "testId": "reward-scroll"
      }
    ],
    "endPath": "dev.e2e.benchmark",
    "endWaitMs": 16005,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "Loading…",
        "role": "text"
      },
      {
        "role": "group",
        "testId": "initial-loading"
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
      "instructionDigest": "fdc4e142da6e03180c7a75853bbbeb788efe25a58ccefefc640c6041870b36ce",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "android-emulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Async%20States"
    },
    "startPath": "dev.e2e.benchmark",
    "summary": "Waited for the Async States screen to load, scrolled up on the reward area to reveal the claim button, and tapped Claim reward. The screen now confirms “Reward claimed.”"
  },
  [
    replay.tool({
      "summary": "tool swipe"
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
    replay.back({
      "summary": "navigate back"
    }),
    replay.tool({
      "summary": "tool swipe"
    }),
    replay.back({
      "summary": "navigate back"
    }),
    replay.scroll({
      "direction": "up",
      "spans": 0.8821,
      "summary": "scroll up on group \"reward-scroll\" in \"Pull down to refresh and reveal your re…\"",
      "target": {
        "role": "group",
        "selector": "id=reward-scroll",
        "testId": "reward-scroll",
        "within": "Pull down to refresh and reveal your reward"
      }
    }),
    replay.tap({
      "summary": "tap group \"Claim reward\"",
      "target": {
        "name": "Claim reward",
        "role": "group",
        "selector": "id=claim-button",
        "testId": "claim-button"
      }
    }),
  ],
);
