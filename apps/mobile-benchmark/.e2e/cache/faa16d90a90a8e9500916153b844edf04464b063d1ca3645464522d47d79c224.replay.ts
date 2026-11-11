// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
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
);
