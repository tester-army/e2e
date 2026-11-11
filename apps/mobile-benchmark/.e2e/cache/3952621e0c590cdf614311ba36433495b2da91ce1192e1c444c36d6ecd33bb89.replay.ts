// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {
    "id": "3952621e0c590cdf614311ba36433495b2da91ce1192e1c444c36d6ecd33bb89",
    "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Error%20Recovery"
  },
  [
    replay.step(
      {
        "key": "be480e468e8e1ce9d711a913a342576d12f268717ddaf2b3b757bc52552aa633",
        "order": 0,
        "variant": {
          "agent": "37a8eec1ce19687d132fe29051dca629d164e2c4958ba141d5f4133a33f0688f",
          "project": "5db668e539f1f8a455eaa798ab239f0cfdc68c99776863db1ddd6f27a9fba643",
          "target": "a34152a60079722a259a417c0251ad71bf53cd3ef002e7f6c1e465dad98bee2b"
        }
      },
      replay.define(
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
      ),
    ),
    replay.step(
      {
        "key": "4c9b8d6da6cd0c38a5341e8bd7412e7618aafaec97ec4e020944d5ef2a0fb2b2",
        "order": 0,
        "variant": {
          "agent": "37a8eec1ce19687d132fe29051dca629d164e2c4958ba141d5f4133a33f0688f",
          "project": "5db668e539f1f8a455eaa798ab239f0cfdc68c99776863db1ddd6f27a9fba643",
          "target": "d34e594487171911acb852c9c20a9b1e42d960b2c08aeb43fe1145049c6f1eed"
        }
      },
      replay.define(
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
      ),
    ),
  ],
);
