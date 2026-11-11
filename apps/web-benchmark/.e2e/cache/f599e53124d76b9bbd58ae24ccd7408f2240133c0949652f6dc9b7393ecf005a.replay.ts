// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "testId": "progress",
        "text": "Progress: 3 / 3"
      },
      {
        "testId": "success-message",
        "text": "Target clicked 3 times"
      }
    ],
    "endPath": "/e/stale-dom",
    "endWaitMs": 11441,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "testId": "progress",
        "text": "Progress: 0 / 3"
      },
      {
        "text": "Slot 1"
      },
      {
        "name": "Decoy",
        "role": "button",
        "testId": "decoy-button"
      },
      {
        "text": "Slot 2"
      },
      {
        "text": "Slot 3"
      },
      {
        "name": "Tap me",
        "role": "button",
        "testId": "target-button"
      },
      {
        "text": "Slot 4"
      },
      {
        "text": "Slot 5"
      }
    ],
    "recordedFor": {
      "agent": "default",
      "callIndex": 0,
      "instructionDigest": "c7958b2326b3f2b42541d8b8261d04bb3d18d3fbbf439d754e64d72856a74ba4",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "web",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20stale-dom"
    },
    "startPath": "/e/stale-dom",
    "summary": "Clicked Tap me three times. The page shows Progress: 3 / 3 and “Target clicked 3 times.”"
  },
  [
    replay.tap({
      "summary": "tap button \"Tap me\"",
      "target": {
        "name": "Tap me",
        "role": "button",
        "testId": "target-button"
      }
    }),
    replay.tap({
      "summary": "tap button \"Tap me\"",
      "target": {
        "name": "Tap me",
        "role": "button",
        "testId": "target-button"
      }
    }),
    replay.tap({
      "summary": "tap button \"Tap me\"",
      "target": {
        "name": "Tap me",
        "role": "button",
        "testId": "target-button"
      }
    }),
  ],
);
