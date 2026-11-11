// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Vertical scroll bar, 1 page",
        "role": "other",
        "value": "0%"
      },
      {
        "name": "Horizontal scroll bar, 1 page",
        "role": "other",
        "value": "0%"
      },
      {
        "name": "Vertical scroll bar, 1 page",
        "role": "other"
      },
      {
        "name": "Reward claimed",
        "role": "other",
        "testId": "reward-scroll"
      },
      {
        "name": "Reward claimed",
        "role": "scroll-view"
      },
      {
        "name": "Reward claimed",
        "role": "text",
        "testId": "success-message"
      }
    ],
    "endPath": "dev.e2e.benchmark / Async States",
    "endWaitMs": 15245,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "In progress",
        "role": "status",
        "value": "1"
      },
      {
        "name": "Loading…",
        "role": "text"
      },
      {
        "name": "Loading…",
        "role": "other"
      },
      {
        "name": "In progress",
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
      "instructionDigest": "fdc4e142da6e03180c7a75853bbbeb788efe25a58ccefefc640c6041870b36ce",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "ios-simulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Async%20States"
    },
    "startPath": "dev.e2e.benchmark / Async States",
    "summary": "Waited for the reward area to load, pulled down on it to refresh and reveal the Claim reward button, then tapped it. The screen now shows “Reward claimed.”"
  },
  [
    replay.tool({
      "summary": "tool swipe"
    }),
    replay.tool({
      "summary": "tool swipe"
    }),
    replay.tap({
      "summary": "tap other \"Claim reward\"",
      "target": {
        "name": "Claim reward",
        "role": "other",
        "selector": "id=claim-button",
        "testId": "claim-button"
      }
    }),
  ],
);
