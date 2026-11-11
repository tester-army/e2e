// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {
    "id": "264aa80313ee8596117c6aecc5940f3960f06777bb6e27908a99c9a0de520c93",
    "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Async%20States"
  },
  [
    replay.step(
      {
        "key": "1d0ec270805299b99155c5403b3a3f8b75d84ac6e41249974cea59f66d75f3bd",
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
      ),
    ),
    replay.step(
      {
        "key": "a5de499f27a44803c5735c66c52a95a09e4d801ff679df37b16614cc3f67435f",
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
      ),
    ),
  ],
);
