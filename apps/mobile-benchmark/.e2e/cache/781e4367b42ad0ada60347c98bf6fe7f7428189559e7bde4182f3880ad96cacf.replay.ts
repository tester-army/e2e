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
);
