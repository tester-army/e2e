// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
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
);
