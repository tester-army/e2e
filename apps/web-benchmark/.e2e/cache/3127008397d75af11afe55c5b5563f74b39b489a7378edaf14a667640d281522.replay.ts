// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {"id":"3127008397d75af11afe55c5b5563f74b39b489a7378edaf14a667640d281522","testId":"tests-agent/scenarios.e2e.ts::act%20completes%20infinite-scroll"},
  [
  replay.step(
    {
      "key": "ddc615c1f8fec05c095c44dcac3614808c52a55c24f3ebf41c6e507d1abe140e",
      "order": 0,
      "variant": {
        "agent": "37a8eec1ce19687d132fe29051dca629d164e2c4958ba141d5f4133a33f0688f",
        "project": "6c340b4558007fd12144b6a4e0daf3abb724b92faa2d08705fa564444b68533c",
        "target": "4b5e57f6eb2f42b9039b3d1e13929295f231749c510cbe341cd68036d9af97e2"
      }
    },
    replay.define(
      {
        "endAnchors": [
          {
            "testId": "success-message",
            "text": "Golden Ticket claimed"
          },
          {
            "text": "Item 41"
          },
          {
            "text": "Feed entry 41 of 200"
          },
          {
            "text": "Item 42"
          },
          {
            "text": "Feed entry 42 of 200"
          },
          {
            "text": "Item 43"
          },
          {
            "text": "Feed entry 43 of 200"
          },
          {
            "text": "Item 44"
          }
        ],
        "endPath": "/e/infinite-scroll",
        "endWaitMs": 11656,
        "executor": {
          "name": "e2e-default-agent",
          "version": "2"
        },
        "recordedFor": {
          "agent": "default",
          "callIndex": 0,
          "instructionDigest": "5693e0682199f2201375a207ac10bd69b22c26925bbf8fd87e06a9f6d1abeca9",
          "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
          "targetId": "web",
          "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20infinite-scroll"
        },
        "startPath": "/e/infinite-scroll",
        "summary": "Scrolled the feed until the Golden Ticket appeared and clicked Claim. The page now shows “Golden Ticket claimed.”"
      },
      [
        replay.scrollUntil({
          "direction": "down",
          "spans": 0.3083,
          "summary": "scroll down on node \"feed\" until \"Golden Ticket\" shows (20 screens)",
          "target": {
            "testId": "feed"
          },
          "text": "Golden Ticket"
        }),
        replay.tap({
          "summary": "tap button \"Claim\"",
          "target": {
            "name": "Claim",
            "role": "button",
            "testId": "claim-button"
          }
        }),
      ],
    )
  ),
  ],
);
