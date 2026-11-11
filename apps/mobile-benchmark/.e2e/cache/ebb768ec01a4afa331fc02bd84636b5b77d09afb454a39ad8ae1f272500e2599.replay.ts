// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Flow completed",
        "role": "text",
        "testId": "success-message"
      }
    ],
    "endPath": "dev.e2e.benchmark / Modal Flow",
    "endWaitMs": 10165,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "Open modal",
        "role": "other",
        "testId": "open-modal-button"
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
      "instructionDigest": "32bf25d16daf4e21f574c8c4919b38c59ac735da3fa3c55d0ddb4093a2abd239",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "ios-simulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Modal%20Flow"
    },
    "startPath": "dev.e2e.benchmark / Modal Flow",
    "summary": "The current screen shows “Flow completed,” confirming the modal flow completed after continuing and confirming the alert."
  },
  [
    replay.tap({
      "summary": "tap other \"Open modal\"",
      "target": {
        "name": "Open modal",
        "role": "other",
        "selector": "id=open-modal-button",
        "testId": "open-modal-button"
      }
    }),
    replay.tap({
      "summary": "tap other \"Continue\"",
      "target": {
        "name": "Continue",
        "role": "other",
        "selector": "id=continue-button",
        "testId": "continue-button"
      }
    }),
    replay.tap({
      "summary": "tap button \"Confirm\" in \"Confirm action\"",
      "target": {
        "name": "Confirm",
        "role": "button",
        "within": "Confirm action"
      }
    }),
  ],
);
