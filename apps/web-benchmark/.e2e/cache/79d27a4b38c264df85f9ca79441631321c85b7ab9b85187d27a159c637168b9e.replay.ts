// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {"id":"79d27a4b38c264df85f9ca79441631321c85b7ab9b85187d27a159c637168b9e","testId":"tests-agent/scenarios.e2e.ts::act%20completes%20debounced-search"},
  [
  replay.step(
    {
      "key": "ed226f92f03c6086530e8eb4128d4f2a1c1403692d110633a0ef607f14be1e6d",
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
            "text": "Added Trail Mix 500 g to the cart"
          }
        ],
        "endPath": "/e/debounced-search",
        "endWaitMs": 11449,
        "executor": {
          "name": "e2e-default-agent",
          "version": "2"
        },
        "goneAnchors": [
          {
            "text": "Search for trail mix and pick exactly Trail Mix 500 g."
          },
          {
            "name": "Search snacks",
            "placeholder": "Search snacks",
            "role": "combobox",
            "testId": "search-input"
          }
        ],
        "recordedFor": {
          "agent": "default",
          "callIndex": 0,
          "instructionDigest": "e5044d8a420a21763ff0ba6ba21266a9cf45e9607dd3496c435089c8d757d4e8",
          "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
          "targetId": "web",
          "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20debounced-search"
        },
        "startPath": "/e/debounced-search",
        "summary": "Searched for trail mix and selected exactly Trail Mix 500 g. The page confirms it was added to the cart."
      },
      [
        replay.type({
          "summary": "type \"trail mix\" into combobox \"Search snacks\"",
          "target": {
            "name": "Search snacks",
            "placeholder": "Search snacks",
            "role": "combobox",
            "testId": "search-input"
          },
          "value": "trail mix"
        }),
        replay.tap({
          "summary": "tap option \"Trail Mix 500 g\"",
          "target": {
            "name": "Trail Mix 500 g",
            "role": "option",
            "testId": "option-trail-mix-500-g"
          }
        }),
      ],
    )
  ),
  ],
);
