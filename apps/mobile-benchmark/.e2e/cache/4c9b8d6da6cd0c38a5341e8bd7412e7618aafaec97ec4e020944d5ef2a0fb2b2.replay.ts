// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "role": "navigation",
        "testId": "Error Recovery"
      },
      {
        "name": "Draft deleted",
        "role": "text",
        "testId": "success-message"
      }
    ],
    "endPath": "dev.e2e.benchmark / Error Recovery",
    "endWaitMs": 13545,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "In progress",
        "role": "status",
        "value": "1"
      },
      {
        "name": "Loading drafts…",
        "role": "text"
      },
      {
        "name": "Benchmark Examples",
        "role": "other"
      },
      {
        "name": "Benchmark Examples",
        "role": "navigation",
        "testId": "Error Recovery"
      },
      {
        "name": "Loading drafts…",
        "role": "other"
      },
      {
        "name": "In progress",
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
      "instructionDigest": "e8369dfb1ec63a3fa2636f3e1803fa229587d469fcb7abdafcfbbb046625544c",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "ios-simulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Error%20Recovery"
    },
    "startPath": "dev.e2e.benchmark / Error Recovery",
    "summary": "Retried the failed draft load, waited for the draft list to appear, then deleted the untitled draft and confirmed. The screen shows “Draft deleted.”"
  },
  [
    replay.tap({
      "summary": "tap other \"Retry\"",
      "target": {
        "name": "Retry",
        "role": "other",
        "selector": "id=retry-button",
        "testId": "retry-button"
      }
    }),
    replay.tap({
      "summary": "tap other \"Delete draft\"",
      "target": {
        "name": "Delete draft",
        "role": "other",
        "selector": "id=delete-draft",
        "testId": "delete-draft"
      }
    }),
    replay.tap({
      "summary": "tap other \"Delete\"",
      "target": {
        "name": "Delete",
        "role": "other",
        "selector": "id=confirm-delete",
        "testId": "confirm-delete"
      }
    }),
  ],
);
