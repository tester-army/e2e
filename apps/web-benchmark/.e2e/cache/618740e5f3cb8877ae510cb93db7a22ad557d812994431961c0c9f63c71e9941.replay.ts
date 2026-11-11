// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Filter products",
        "placeholder": "Filter products",
        "role": "textbox",
        "testId": "filter-input",
        "value": "mug"
      }
    ],
    "endPath": "/e/filter-deep-link?q=mug",
    "endWaitMs": 11489,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "Filter products",
        "placeholder": "Filter products",
        "role": "textbox",
        "testId": "filter-input"
      },
      {
        "name": "Trail Backpack",
        "role": "listitem"
      },
      {
        "name": "Steel Water Bottle",
        "role": "listitem"
      },
      {
        "name": "Merino Hiking Socks",
        "role": "listitem"
      },
      {
        "name": "Camp Lantern",
        "role": "listitem"
      }
    ],
    "recordedFor": {
      "agent": "default",
      "callIndex": 0,
      "instructionDigest": "c54ac6f470b19c027dd580aa19d24ab48c4f0612b3930178028f20eb76cdd216",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "web",
      "testId": "tests-agent/scenarios.e2e.ts::act%20filters%20the%20list%20and%20the%20URL%20carries%20the%20filter"
    },
    "startPath": "/e/filter-deep-link",
    "summary": "Entered “mug” in the product filter. The list is filtered to Titanium Mug, and the page URL is /e/filter-deep-link?q=mug."
  },
  [
    replay.type({
      "summary": "type \"mug\" into textbox \"Filter products\"",
      "target": {
        "name": "Filter products",
        "placeholder": "Filter products",
        "role": "textbox",
        "testId": "filter-input"
      },
      "value": "mug"
    }),
  ],
);
