// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {"id":"4665ba640b79821c0d8546a0035711f605bfdd15b65d424d8b76fadaf4253489","testId":"tests-agent/scenarios.e2e.ts::act%20completes%20Bottom%20Tabs"},
  [
  replay.step(
    {
      "key": "4e85a1a62b850f53a939103b6446aada085655ab250e434a614d0a96b1b5a41a",
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
            "name": "Actions",
            "role": "heading"
          },
          {
            "name": "Action completed",
            "role": "text",
            "testId": "success-message"
          },
          {
            "name": "Actions",
            "role": "text",
            "states": [
              "selected"
            ]
          },
          {
            "name": "⏷",
            "role": "text",
            "states": [
              "selected"
            ]
          },
          {
            "name": "⏷, Home",
            "role": "tab",
            "testId": "tab-home"
          },
          {
            "name": "⏷, Actions",
            "role": "tab",
            "states": [
              "selected"
            ],
            "testId": "tab-actions"
          }
        ],
        "endPath": "dev.e2e.benchmark",
        "endWaitMs": 11752,
        "executor": {
          "name": "e2e-default-agent",
          "version": "2"
        },
        "goneAnchors": [
          {
            "name": "Home",
            "role": "heading"
          },
          {
            "name": "Go to the Actions tab and press the button there.",
            "role": "text"
          },
          {
            "name": "Actions",
            "role": "text"
          },
          {
            "name": "⏷, Home",
            "role": "tab",
            "states": [
              "selected"
            ],
            "testId": "tab-home"
          },
          {
            "name": "⏷, Actions",
            "role": "tab",
            "testId": "tab-actions"
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
          "instructionDigest": "e537c4fc20970c63b73faeca0620f6f3aa5afdc8ad6e5b0964959e0f5762de45",
          "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
          "targetId": "android-emulator",
          "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Bottom%20Tabs"
        },
        "startPath": "dev.e2e.benchmark",
        "summary": "Opened the Actions tab and pressed “Complete action.” The screen displays “Action completed.”"
      },
      [
        replay.tap({
          "summary": "tap tab \"⏷, Actions\" in \"Home\"",
          "target": {
            "name": "⏷, Actions",
            "role": "tab",
            "selector": "id=tab-actions",
            "testId": "tab-actions",
            "within": "Home"
          }
        }),
        replay.tap({
          "summary": "tap group \"Complete action\" in \"Actions\"",
          "target": {
            "name": "Complete action",
            "role": "group",
            "selector": "id=complete-action-button",
            "testId": "complete-action-button",
            "within": "Actions"
          }
        }),
      ],
    )
  ),
  replay.step(
    {
      "key": "f3878ab8a2c7d2d0773efabcd031e4c078302faf5793fb0bb45430970301d06d",
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
            "name": "Home, tab, 1 of 3",
            "role": "button",
            "testId": "tab-home"
          },
          {
            "name": "Actions, tab, 3 of 3",
            "role": "button",
            "states": [
              "selected"
            ],
            "testId": "tab-actions"
          },
          {
            "name": "Actions",
            "role": "text"
          },
          {
            "name": "Action completed",
            "role": "text",
            "testId": "success-message"
          }
        ],
        "endPath": "dev.e2e.benchmark",
        "endWaitMs": 10166,
        "executor": {
          "name": "e2e-default-agent",
          "version": "2"
        },
        "goneAnchors": [
          {
            "name": "Home, tab, 1 of 3",
            "role": "button",
            "states": [
              "selected"
            ],
            "testId": "tab-home"
          },
          {
            "name": "Actions, tab, 3 of 3",
            "role": "button",
            "testId": "tab-actions"
          },
          {
            "name": "Home",
            "role": "text"
          },
          {
            "name": "Go to the Actions tab and press the button there.",
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
          "instructionDigest": "e537c4fc20970c63b73faeca0620f6f3aa5afdc8ad6e5b0964959e0f5762de45",
          "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
          "targetId": "ios-simulator",
          "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Bottom%20Tabs"
        },
        "startPath": "dev.e2e.benchmark",
        "summary": "The Actions tab is selected and the screen displays “Action completed,” confirming the action took effect."
      },
      [
        replay.tap({
          "summary": "tap button \"Actions, tab, 3 of 3\"",
          "target": {
            "name": "Actions, tab, 3 of 3",
            "role": "button",
            "selector": "id=tab-actions",
            "testId": "tab-actions"
          }
        }),
        replay.tap({
          "summary": "tap other \"Complete action\"",
          "target": {
            "name": "Complete action",
            "role": "other",
            "selector": "id=complete-action-button",
            "testId": "complete-action-button"
          }
        }),
      ],
    )
  ),
  ],
);
