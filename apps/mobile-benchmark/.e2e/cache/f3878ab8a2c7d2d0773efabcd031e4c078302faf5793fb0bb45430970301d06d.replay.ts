// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Home, tab, 1 of 3",
        "role": "button",
        "testId": "tab-home"
      },
      {
        "name": "Actions, tab, 3 of 3",
        "role": "button",
        "states": [
          "selected"
        ],
        "testId": "tab-actions"
      },
      {
        "name": "Actions",
        "role": "text"
      },
      {
        "name": "Action completed",
        "role": "text",
        "testId": "success-message"
      }
    ],
    "endPath": "dev.e2e.benchmark",
    "endWaitMs": 10166,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "Home, tab, 1 of 3",
        "role": "button",
        "states": [
          "selected"
        ],
        "testId": "tab-home"
      },
      {
        "name": "Actions, tab, 3 of 3",
        "role": "button",
        "testId": "tab-actions"
      },
      {
        "name": "Home",
        "role": "text"
      },
      {
        "name": "Go to the Actions tab and press the button there.",
        "role": "text"
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
      "instructionDigest": "e537c4fc20970c63b73faeca0620f6f3aa5afdc8ad6e5b0964959e0f5762de45",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "ios-simulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Bottom%20Tabs"
    },
    "startPath": "dev.e2e.benchmark",
    "summary": "The Actions tab is selected and the screen displays “Action completed,” confirming the action took effect."
  },
  [
    replay.tap({
      "summary": "tap button \"Actions, tab, 3 of 3\"",
      "target": {
        "name": "Actions, tab, 3 of 3",
        "role": "button",
        "selector": "id=tab-actions",
        "testId": "tab-actions"
      }
    }),
    replay.tap({
      "summary": "tap other \"Complete action\"",
      "target": {
        "name": "Complete action",
        "role": "other",
        "selector": "id=complete-action-button",
        "testId": "complete-action-button"
      }
    }),
  ],
);
