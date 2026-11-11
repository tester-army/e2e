// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {"id":"8f49d663230cbb0d1c6364ec9f3378cdf9846db0789fb3d924aa4656d9f51f6f","testId":"tests-agent/scenarios.e2e.ts::act%20completes%20Modal%20Flow"},
  [
  replay.step(
    {
      "key": "efb2bb34b10aa7bf6a4684c2b2d8c6788283161ad77b1a4de6c0e4463685692d",
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
    )
  ),
  replay.step(
    {
      "key": "ebb768ec01a4afa331fc02bd84636b5b77d09afb454a39ad8ae1f272500e2599",
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
    )
  ),
  ],
);
