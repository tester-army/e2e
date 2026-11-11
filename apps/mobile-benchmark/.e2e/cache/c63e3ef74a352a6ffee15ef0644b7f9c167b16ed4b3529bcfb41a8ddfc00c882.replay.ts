// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Found Row 0512",
        "role": "text",
        "testId": "success-message"
      }
    ],
    "endPath": "dev.e2e.benchmark",
    "endWaitMs": 11555,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "All 600 rows are loaded. Scroll to Row 0512 and tap it.",
        "role": "text"
      },
      {
        "name": "Row 0001",
        "role": "text"
      },
      {
        "name": "Row 0002",
        "role": "text"
      },
      {
        "name": "Row 0003",
        "role": "text"
      },
      {
        "name": "Row 0004",
        "role": "text"
      },
      {
        "name": "Row 0005",
        "role": "text"
      },
      {
        "name": "Row 0006",
        "role": "text"
      },
      {
        "name": "Row 0007",
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
      "instructionDigest": "0cbf462391106879e99df44b824d6b362b915d99d44a02d241309ec3d4bf4041",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "android-emulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Huge%20Virtualized%20List"
    },
    "startPath": "dev.e2e.benchmark",
    "summary": "Scrolled the virtualized list to Row 0512 and tapped it. The screen confirms success with “Found Row 0512.”"
  },
  [
    replay.scrollUntil({
      "direction": "down",
      "summary": "scroll down until \"Row 0512\" shows (50 screens)",
      "text": "Row 0512"
    }),
    replay.tap({
      "summary": "tap group \"Row 0512\"",
      "target": {
        "name": "Row 0512",
        "role": "group",
        "selector": "id=row-512",
        "testId": "row-512"
      }
    }),
  ],
);
