// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Draft deleted",
        "role": "text",
        "testId": "success-message"
      }
    ],
    "endPath": "dev.e2e.benchmark",
    "endWaitMs": 11903,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "Loading drafts…",
        "role": "text"
      },
      {
        "role": "group",
        "testId": "loading-indicator"
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
      "instructionDigest": "e8369dfb1ec63a3fa2636f3e1803fa229587d469fcb7abdafcfbbb046625544c",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "android-emulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Error%20Recovery"
    },
    "startPath": "dev.e2e.benchmark",
    "summary": "Retried the failed draft load; the draft list loaded. Deleted the “Untitled draft — ‘Quarterly numbers…’” and confirmed deletion; the screen shows “Draft deleted.”"
  },
  [
    replay.tap({
      "summary": "tap group \"Retry\" in \"Network error: could not load drafts\"",
      "target": {
        "name": "Retry",
        "role": "group",
        "selector": "id=retry-button",
        "testId": "retry-button",
        "within": "Network error: could not load drafts"
      }
    }),
    replay.tap({
      "summary": "tap group \"Delete draft\" in \"Drafts\"",
      "target": {
        "name": "Delete draft",
        "role": "group",
        "selector": "id=delete-draft",
        "testId": "delete-draft",
        "within": "Drafts"
      }
    }),
    replay.tap({
      "summary": "tap group \"Delete\" in \"Delete this draft?\"",
      "target": {
        "name": "Delete",
        "role": "group",
        "selector": "id=confirm-delete",
        "testId": "confirm-delete",
        "within": "Delete this draft?"
      }
    }),
  ],
);
