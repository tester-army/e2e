// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Receipt attached: icon.png",
        "role": "other"
      },
      {
        "name": "Receipt attached: icon.png",
        "role": "text",
        "testId": "success-message"
      }
    ],
    "endPath": "dev.e2e.benchmark / Photo Picker",
    "endWaitMs": 13099,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "Expense report",
        "role": "text"
      },
      {
        "name": "Attach the receipt photo from your photo library to submit this expense.",
        "role": "text"
      },
      {
        "name": "Choose photo",
        "role": "other",
        "testId": "choose-photo"
      },
      {
        "name": "Expense report",
        "role": "other"
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
    "recordedFor": {
      "agent": "default",
      "callIndex": 0,
      "instructionDigest": "d601aab262121b364841d0fcc4785cb58a9ec678addac0d10f4a1683f22638a6",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "ios-simulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Photo%20Picker"
    },
    "startPath": "dev.e2e.benchmark / Photo Picker",
    "summary": "Selected the most recent library photo (October 15, 10:27). The scenario now confirms: “Receipt attached: icon.png.”"
  },
  [
    replay.tap({
      "summary": "tap other \"Choose photo\"",
      "target": {
        "name": "Choose photo",
        "role": "other",
        "selector": "id=choose-photo",
        "testId": "choose-photo"
      }
    }),
    replay.tap({
      "summary": "tap image \"Photo, October 15, 10:27\"",
      "target": {
        "name": "Photo, October 15, 10:27",
        "role": "image",
        "selector": "id=PXGGridLayout-Info",
        "testId": "PXGGridLayout-Info"
      }
    }),
  ],
);
