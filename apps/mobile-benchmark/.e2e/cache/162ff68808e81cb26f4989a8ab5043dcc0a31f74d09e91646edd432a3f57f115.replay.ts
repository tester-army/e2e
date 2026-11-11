// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {"id":"162ff68808e81cb26f4989a8ab5043dcc0a31f74d09e91646edd432a3f57f115","testId":"tests-agent/scenarios.e2e.ts::act%20completes%20Infinite%20Scroll%20List"},
  [
  replay.step(
    {
      "key": "781e4367b42ad0ada60347c98bf6fe7f7428189559e7bde4182f3880ad96cacf",
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
            "name": "Found item 137",
            "role": "text",
            "testId": "success-message"
          }
        ],
        "endPath": "dev.e2e.benchmark",
        "endWaitMs": 11523,
        "executor": {
          "name": "e2e-default-agent",
          "version": "2"
        },
        "goneAnchors": [
          {
            "name": "Scroll down and tap Item 137 to complete",
            "role": "text"
          },
          {
            "name": "Item 1",
            "role": "text"
          },
          {
            "name": "Item 2",
            "role": "text"
          },
          {
            "name": "Item 3",
            "role": "text"
          },
          {
            "name": "Item 4",
            "role": "text"
          },
          {
            "name": "Item 5",
            "role": "text"
          },
          {
            "name": "Item 6",
            "role": "text"
          },
          {
            "name": "Item 7",
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
          "instructionDigest": "240960ef8daa93f30d3183a42cf877c23681993025141766e480102a3eca2d75",
          "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
          "targetId": "android-emulator",
          "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Infinite%20Scroll%20List"
        },
        "startPath": "dev.e2e.benchmark",
        "summary": "Scrolled the paginated list until Item 137 appeared and tapped it. The screen confirms success with “Found item 137.”"
      },
      [
        replay.scrollUntil({
          "direction": "down",
          "spans": 0.8821,
          "summary": "scroll down on group \"benchmark-list\" until \"Item 137\" shows (8 screens)",
          "target": {
            "role": "group",
            "selector": "id=benchmark-list",
            "testId": "benchmark-list"
          },
          "text": "Item 137"
        }),
        replay.tap({
          "summary": "tap group \"Item 137\"",
          "target": {
            "name": "Item 137",
            "role": "group",
            "selector": "id=item-137",
            "testId": "item-137"
          }
        }),
      ],
    )
  ),
  replay.step(
    {
      "key": "faa16d90a90a8e9500916153b844edf04464b063d1ca3645464522d47d79c224",
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
            "name": "Found item 137",
            "role": "text",
            "testId": "success-message"
          }
        ],
        "endPath": "dev.e2e.benchmark / Infinite Scroll List",
        "endWaitMs": 10160,
        "executor": {
          "name": "e2e-default-agent",
          "version": "2"
        },
        "goneAnchors": [
          {
            "name": "Item 1",
            "role": "other",
            "testId": "item-1"
          },
          {
            "name": "Item 2",
            "role": "other",
            "testId": "item-2"
          },
          {
            "name": "Item 3",
            "role": "other",
            "testId": "item-3"
          },
          {
            "name": "Item 4",
            "role": "other",
            "testId": "item-4"
          },
          {
            "name": "Item 5",
            "role": "other",
            "testId": "item-5"
          },
          {
            "name": "Item 6",
            "role": "other",
            "testId": "item-6"
          },
          {
            "name": "Item 7",
            "role": "other",
            "testId": "item-7"
          },
          {
            "name": "Item 8",
            "role": "other",
            "testId": "item-8"
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
          "instructionDigest": "240960ef8daa93f30d3183a42cf877c23681993025141766e480102a3eca2d75",
          "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
          "targetId": "ios-simulator",
          "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Infinite%20Scroll%20List"
        },
        "startPath": "dev.e2e.benchmark / Infinite Scroll List",
        "summary": "The screen shows “Found item 137,” confirming the list item was tapped and the scenario completed."
      },
      [
        replay.scrollUntil({
          "direction": "down",
          "summary": "scroll down until \"Item 137\" shows (13 screens)",
          "text": "Item 137"
        }),
        replay.tap({
          "summary": "tap other \"Item 137\"",
          "target": {
            "name": "Item 137",
            "role": "other",
            "selector": "id=item-137",
            "testId": "item-137"
          }
        }),
      ],
    )
  ),
  ],
);
