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
    "endPath": "dev.e2e.benchmark",
    "endWaitMs": 11801,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "Open modal",
        "role": "text"
      },
      {
        "name": "Open modal",
        "role": "group",
        "testId": "open-modal-button"
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
      "instructionDigest": "32bf25d16daf4e21f574c8c4919b38c59ac735da3fa3c55d0ddb4093a2abd239",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "android-emulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Modal%20Flow"
    },
    "startPath": "dev.e2e.benchmark",
    "summary": "Opened the modal, tapped Continue, and confirmed the native alert. The screen now shows “Flow completed.”"
  },
  [
    replay.tap({
      "summary": "tap group \"Open modal\"",
      "target": {
        "name": "Open modal",
        "role": "group",
        "selector": "id=open-modal-button",
        "testId": "open-modal-button"
      }
    }),
    replay.tap({
      "summary": "tap group \"Continue\" in \"Benchmark modal\"",
      "target": {
        "name": "Continue",
        "role": "group",
        "selector": "id=continue-button",
        "testId": "continue-button",
        "within": "Benchmark modal"
      }
    }),
    replay.tap({
      "summary": "tap button \"CONFIRM\" in \"CANCEL\"",
      "target": {
        "name": "CONFIRM",
        "role": "button",
        "selector": "id=android:id/button1",
        "testId": "android:id/button1",
        "within": "CANCEL"
      }
    }),
  ],
);
